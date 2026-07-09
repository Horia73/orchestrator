import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function main() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-api-cost-'))
    process.env.ORCHESTRATOR_STATE_DIR = stateDir

    try {
        const { attachBillingMetadata } = await import('@/lib/observability/billing-metadata')
        const { buildUsageReport, logRequestComplete, logRequestStart } = await import('@/lib/observability/store')
        const now = Date.now()

        logRequestStart({
            requestId: 'claude-cost',
            conversationId: 'cost-smoke',
            agentId: 'orchestrator',
            provider: 'claude-code',
            model: 'opus[1m]',
            thinkingLevel: 'high',
            statefulMode: true,
            startedAt: now - 2_000,
        })
        logRequestComplete({
            requestId: 'claude-cost',
            endedAt: now - 1_000,
            provider: 'claude-code',
            usage: attachBillingMetadata({
                input_tokens: 100,
                cache_read_input_tokens: 900,
                output_tokens: 20,
            }, [{
                provider: 'claude-code',
                model: 'claude-opus-4-8',
                requests: 1,
                inputTokens: 1_000,
                outputTokens: 20,
                thinkingTokens: 0,
                cachedTokens: 900,
                toolUseTokens: 0,
                totalTokens: 1_020,
                apiEquivalentCostUsd: 1.25,
                costSource: 'provider-estimate',
                costAccuracy: 'provider',
                pricingSource: 'https://code.claude.com/docs/en/agent-sdk/cost-tracking',
            }]),
        })

        logRequestStart({
            requestId: 'legacy-codex-cost',
            conversationId: 'cost-smoke',
            agentId: 'coder',
            provider: 'codex',
            model: 'gpt-5.5',
            thinkingLevel: 'high',
            statefulMode: true,
            startedAt: now - 1_000,
        })
        logRequestComplete({
            requestId: 'legacy-codex-cost',
            endedAt: now,
            provider: 'codex',
            usage: {
                totalTokens: 310_000,
                inputTokens: 300_000,
                cachedInputTokens: 200_000,
                outputTokens: 10_000,
                reasoningOutputTokens: 2_000,
            },
        })

        const report = buildUsageReport('24h')
        assert.equal(report.totals.requests, 2)
        assert.equal(report.totals.estimatedCostUsd, 0)
        assert.ok(Math.abs(report.totals.subscriptionNotionalUsd - 2.9) < 1e-9)
        assert.equal(report.daily.at(-1)?.subscriptionNotionalUsd, report.totals.subscriptionNotionalUsd)

        const claude = report.byModel.find(row => row.model === 'claude-opus-4-8')
        assert.equal(claude?.notionalUsd, 1.25)
        assert.equal(claude?.costSource, 'provider-estimate')
        assert.equal(claude?.costAccuracy, 'provider')

        const codex = report.byModel.find(row => row.model === 'gpt-5.5')
        assert.ok(codex && Math.abs(codex.notionalUsd - 1.65) < 1e-9)
        assert.equal(codex.costSource, 'api-pricing')
        assert.equal(codex.costAccuracy, 'aggregate')

        const byAgentTotal = report.byAgent.reduce((sum, row) => sum + row.subscriptionNotionalUsd, 0)
        assert.ok(Math.abs(byAgentTotal - report.totals.subscriptionNotionalUsd) < 1e-9)
        console.log('smoke-api-equivalent-report: ok')
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true })
    }
}

main().catch(error => {
    console.error('smoke-api-equivalent-report: failed')
    console.error(error)
    process.exit(1)
})
