import assert from 'node:assert/strict'

import {
    estimateCliApiEquivalentAggregate,
    estimateCodexApiEquivalentCall,
} from '@/lib/observability/api-equivalent'
import { attachBillingMetadata } from '@/lib/observability/billing-metadata'
import { estimateCost } from '@/lib/observability/cost'
import { normalizeUsage } from '@/lib/observability/usage-mapper'
import { claudeCodeBillingEntries } from '@/lib/ai/providers/claude-code'
import { codexUsageForBillingUpdate } from '@/lib/ai/providers/codex-helpers'

const smallCodex = estimateCodexApiEquivalentCall('gpt-5.5', {
    inputTokens: 200_000,
    cachedTokens: 150_000,
    outputTokens: 10_000,
})
assert.ok(smallCodex)
assert.equal(smallCodex.costAccuracy, 'per-call')
assert.ok(Math.abs(smallCodex.usd - 0.625) < 1e-9)

const largeCodex = estimateCodexApiEquivalentCall('gpt-5.5', {
    inputTokens: 300_000,
    cachedTokens: 200_000,
    outputTokens: 10_000,
})
assert.ok(largeCodex)
assert.ok(Math.abs(largeCodex.usd - 1.65) < 1e-9, 'large-context rates apply per provider call')

const historicalCodex = estimateCliApiEquivalentAggregate('codex', 'gpt-5.5', {
    inputTokens: 300_000,
    cachedTokens: 200_000,
    outputTokens: 10_000,
})
assert.equal(historicalCodex?.costAccuracy, 'aggregate')

const historicalClaude = estimateCliApiEquivalentAggregate('claude-code', 'opus[1m]', {
    inputTokens: 1_000_000,
    cachedTokens: 900_000,
    outputTokens: 10_000,
})
assert.ok(historicalClaude)
assert.ok(Math.abs(historicalClaude.usd - 1.2) < 1e-9)

const claudeEntries = claudeCodeBillingEntries({
    modelUsage: {
        'claude-opus-4-8': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 900,
            cacheCreationInputTokens: 50,
            costUSD: 0.123,
        },
    },
    totalCostUsd: 0.125,
    fallbackModel: 'opus[1m]',
    fallbackUsage: null,
})
assert.equal(claudeEntries.length, 1)
assert.equal(claudeEntries[0].inputTokens, 1_050)
assert.equal(claudeEntries[0].cachedTokens, 950)
assert.equal(claudeEntries[0].apiEquivalentCostUsd, 0.125, 'query total reconciles model cost')
assert.equal(claudeEntries[0].costAccuracy, 'provider')

const enriched = attachBillingMetadata({ input_tokens: 100, output_tokens: 20 }, claudeEntries)
assert.equal(JSON.stringify(enriched).includes('apiEquivalentCostUsd'), false, 'private billing metadata stays out of SSE JSON')
const normalized = normalizeUsage('claude-code', enriched)
assert.equal(normalized.billingBreakdown?.[0].model, 'claude-opus-4-8')

const firstBilling = codexUsageForBillingUpdate({
    last: {
        totalTokens: 120,
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 20,
        reasoningOutputTokens: 5,
    },
    total: {
        totalTokens: 1_120,
        inputTokens: 1_000,
        cachedInputTokens: 800,
        outputTokens: 120,
        reasoningOutputTokens: 25,
    },
}, null)
assert.equal(firstBilling.usage?.inputTokens, 100, 'first cumulative event uses last call only')

const secondBilling = codexUsageForBillingUpdate({
    last: {
        totalTokens: 240,
        inputTokens: 200,
        cachedInputTokens: 160,
        outputTokens: 40,
        reasoningOutputTokens: 10,
    },
    total: {
        totalTokens: 1_360,
        inputTokens: 1_200,
        cachedInputTokens: 960,
        outputTokens: 160,
        reasoningOutputTokens: 35,
    },
}, firstBilling.total)
assert.equal(secondBilling.usage?.inputTokens, 200)
assert.equal(secondBilling.usage?.outputTokens, 40)

const openAiCost = estimateCost({
    kind: 'tokens',
    inputPerMillion: 1,
    outputPerMillion: 10,
}, {
    provider: 'openai',
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 100,
    thinkingTokens: 60,
    toolUseTokens: 0,
})
assert.ok(Math.abs(openAiCost.usd - 0.001) < 1e-12, 'reasoning detail is not billed twice')

console.log('smoke-api-equivalent-cost: ok')
