/**
 * Smoke test for orchestrator read-only history tools.
 *
 * Uses a temporary cwd so it does not touch the real .orchestrator/data.db.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import type { TokenUsageBreakdown } from '@/lib/types'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'observability-tools-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const {
        executeGetAgentLog,
        executeGetPastRun,
        executeReadRuntimeIndex,
        executeSearchAgentLogs,
        executeSearchPastRuns,
    } = await import('@/lib/ai/tools/observability')
    const { createScheduledTask, recordTaskRun } = await import('@/lib/scheduling/store')
    const {
        buildUsageReport,
        getRequestLog,
        logRequestComplete,
        logRequestStart,
        logToolCall,
        sealInterruptedStreamingRequestLogs,
    } = await import('@/lib/observability/store')
    const { updateConfig } = await import('@/lib/config')
    const { addMessage, createConversation, getConversation } = await import('@/lib/db')
    const { runWithProfileContext } = await import('@/lib/profiles/context')
    const {
        appendRuntimeRequestLogIndex,
        appendRuntimeRunIndex,
    } = await import('@/lib/runtime-index')
    const { codexUsageForCurrentTurn } = await import('@/lib/ai/providers/codex-helpers')
    const { default: Database } = await import('better-sqlite3')
    const { initializeDatabaseSchema } = await import('@/lib/db-schema')
    const { retryTransientSqliteRecovery } = await import('@/lib/observability/recovery-retry')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
        if (!ok) failures++
    }

    updateConfig({ timezone: 'Europe/Bucharest' })

    const recoverySleeps: number[] = []
    let recoveryAttempts = 0
    const recoveredAfterContention = await retryTransientSqliteRecovery(
        () => {
            recoveryAttempts++
            if (recoveryAttempts < 3) {
                throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
            }
            return 'sealed'
        },
        {
            initialDelayMs: 25,
            sleep: async delayMs => { recoverySleeps.push(delayMs) },
        },
    )
    check(
        'startup recovery retries transient SQLite contention with backoff',
        recoveredAfterContention === 'sealed'
        && recoveryAttempts === 3
        && recoverySleeps.join(',') === '25,50',
        { recoveredAfterContention, recoveryAttempts, recoverySleeps },
    )
    let permanentAttempts = 0
    await retryTransientSqliteRecovery(
        () => {
            permanentAttempts++
            throw new Error('schema mismatch')
        },
        { sleep: async () => undefined },
    ).then(
        () => check('startup recovery surfaces non-contention errors', false),
        error => check(
            'startup recovery surfaces non-contention errors without retrying',
            permanentAttempts === 1 && error instanceof Error && error.message === 'schema mismatch',
            { permanentAttempts, error: String(error) },
        ),
    )

    const now = Date.now()
    const legacyUsageDb = new Database(path.join(tmpRoot, 'legacy-codex-usage.db'))
    initializeDatabaseSchema(legacyUsageDb)
    legacyUsageDb
        .prepare(`DELETE FROM schema_migrations WHERE id = ?`)
        .run('codex-appserver-turn-delta-v1')
    const insertLegacyCodexRow = legacyUsageDb.prepare(`
        INSERT INTO request_logs (
            id, conversationId, agentId, provider, model, thinkingLevel,
            status, startedAt, statefulMode, interactionId,
            inputTokens, cachedTokens, outputTokens, thinkingTokens, totalTokens
        ) VALUES (?, ?, 'orchestrator', 'codex', 'gpt-5.5', 'high',
            'ok', ?, 1, 'appserver:smoke-thread', ?, ?, ?, ?, ?)
    `)
    insertLegacyCodexRow.run(
        'legacy_codex_first',
        'conv_legacy_codex',
        now - 2_000,
        1_000,
        900,
        20,
        7,
        1_020
    )
    insertLegacyCodexRow.run(
        'legacy_codex_second',
        'conv_legacy_codex',
        now - 1_000,
        1_080,
        960,
        33,
        12,
        1_118
    )
    initializeDatabaseSchema(legacyUsageDb)
    const migratedLegacyCodex = legacyUsageDb
        .prepare(`
            SELECT inputTokens, cachedTokens, outputTokens, thinkingTokens,
                   totalTokens, usageCorrectionVersion
            FROM request_logs WHERE id = ?
        `)
        .get('legacy_codex_second') as {
            inputTokens: number
            cachedTokens: number
            outputTokens: number
            thinkingTokens: number
            totalTokens: number
            usageCorrectionVersion: string | null
        }
    check(
        'legacy codex cumulative usage migration stores per-turn delta',
        migratedLegacyCodex.inputTokens === 80 &&
        migratedLegacyCodex.cachedTokens === 60 &&
        migratedLegacyCodex.outputTokens === 13 &&
        migratedLegacyCodex.thinkingTokens === 5 &&
        migratedLegacyCodex.totalTokens === 98 &&
        migratedLegacyCodex.usageCorrectionVersion === 'codex-appserver-turn-delta-v1',
        migratedLegacyCodex
    )
    legacyUsageDb.close()

    const task = createScheduledTask({
        title: 'Runtime history smoke',
        enabled: true,
        createdBy: 'orchestrator',
        schedule: { kind: 'once', fireAt: now + 60_000 },
        action: {
            kind: 'agent',
            agentId: 'orchestrator',
            prompt: 'Smoke test scheduled prompt',
            adaptive: false,
        },
    })
    recordTaskRun({
        taskId: task.id,
        startedAt: now - 2_000,
        status: 'ok',
        trigger: 'schedule',
        surfaced: false,
        conversationId: null,
        summary: 'Smart Monitor: no watches due - idle tick. Smoke marker: runtime history.',
    })

    const runs = await executeSearchPastRuns({ range: 'all', q: 'runtime history', limit: 5 })
    check('search_past_runs succeeds', runs.success === true)
    const runsData = runs.data as { timezone: string; runs: Array<{ run_id: string; task_title: string; started_at: string; started_at_utc: string }> }
    const runRows = runsData.runs
    check('search_past_runs finds smoke run', runRows.length === 1 && runRows[0].task_title === task.title, runs.data)
    check('search_past_runs reports configured timezone', runsData.timezone === 'Europe/Bucharest', runs.data)
    check('search_past_runs has local and UTC timestamps', runRows[0].started_at !== runRows[0].started_at_utc && runRows[0].started_at_utc.endsWith('Z'), runRows[0])

    const run = await executeGetPastRun({ run_id: runRows[0].run_id })
    check('get_past_run succeeds', run.success === true)
    const runData = run.data as { summary: string; timezone: string; started_at: string; started_at_utc: string }
    check('get_past_run returns summary', runData.summary.includes('Smoke marker'))
    check('get_past_run returns local time first', runData.timezone === 'Europe/Bucharest' && runData.started_at !== runData.started_at_utc, runData)

    const requestId = 'req_observability_smoke'
    logRequestStart({
        requestId,
        conversationId: 'conv_observability_smoke',
        agentId: 'orchestrator',
        provider: 'openai',
        model: 'gpt-smoke',
        thinkingLevel: 'low',
        statefulMode: false,
        startedAt: now - 1_000,
        inputText: 'Please inspect runtime history smoke marker.',
    })
    logToolCall({
        requestId,
        toolName: 'search_past_runs',
        success: true,
        startedAt: now - 700,
        durationMs: 12,
    })
    logRequestComplete({
        requestId,
        endedAt: now,
        provider: 'openai',
        outputText: 'Runtime history smoke marker inspected.',
    })

    const logs = await executeSearchAgentLogs({ range: 'all', q: 'smoke marker', limit: 5 })
    check('search_agent_logs succeeds', logs.success === true)
    const logsData = logs.data as { timezone: string; logs: Array<{ request_id: string; started_at: string; started_at_utc: string }> }
    const logRows = logsData.logs
    check('search_agent_logs finds request', logRows.some((row) => row.request_id === requestId), logs.data)
    check('search_agent_logs reports configured timezone', logsData.timezone === 'Europe/Bucharest', logs.data)
    check('search_agent_logs has local and UTC timestamps', logRows.some((row) => row.request_id === requestId && row.started_at !== row.started_at_utc && row.started_at_utc.endsWith('Z')), logs.data)

    const log = await executeGetAgentLog({ request_id: requestId })
    check('get_agent_log succeeds', log.success === true)
    const logData = log.data as { output_text: string; timezone: string; started_at: string; started_at_utc: string; tool_logs: Array<{ started_at: string; started_at_utc: string }> }
    check('get_agent_log returns output text', logData.output_text.includes('Runtime history'))
    check('get_agent_log returns tool logs', logData.tool_logs.length === 1)
    check('get_agent_log returns local time first', logData.timezone === 'Europe/Bucharest' && logData.started_at !== logData.started_at_utc, logData)
    check('get_agent_log tool logs include UTC companion', logData.tool_logs[0]?.started_at !== logData.tool_logs[0]?.started_at_utc, logData.tool_logs)

    const browserRequestId = 'req_observability_browser_usage'
    logRequestStart({
        requestId: browserRequestId,
        conversationId: 'conv_observability_smoke',
        agentId: 'browser_agent',
        provider: 'browser',
        model: 'default',
        thinkingLevel: 'medium',
        statefulMode: true,
        startedAt: now - 900,
        inputText: 'Run a browser smoke task.',
    })
    logRequestComplete({
        requestId: browserRequestId,
        endedAt: now - 800,
        provider: 'browser',
        usage: {
            model: 'gemini-3-flash-preview',
            totals: {
                promptTokens: 100,
                outputTokens: 10,
                thoughtsTokens: 5,
                totalTokens: 115,
                requests: 2,
            },
            byModel: {
                'gemini-3-flash-preview': {
                    promptTokens: 100,
                    outputTokens: 10,
                    thoughtsTokens: 5,
                    totalTokens: 115,
                    requests: 2,
                },
            },
        },
        outputText: 'Browser usage smoke.',
    })
    const browserLog = getRequestLog(browserRequestId)
    check('browser usage maps prompt tokens', browserLog?.inputTokens === 100, browserLog)
    check('browser usage maps billing model', browserLog?.billingBreakdown?.[0]?.model === 'gemini-3-flash-preview', browserLog)

    const legacyBrowserRequestId = 'req_observability_legacy_browser_usage'
    logRequestStart({
        requestId: legacyBrowserRequestId,
        conversationId: 'conv_observability_smoke',
        agentId: 'browser_agent',
        provider: 'browser',
        model: 'default',
        thinkingLevel: 'medium',
        statefulMode: true,
        startedAt: now - 850,
        inputText: 'Run a legacy browser smoke task.',
    })
    logRequestComplete({
        requestId: legacyBrowserRequestId,
        endedAt: now - 750,
        provider: 'browser',
        outputText: [
            'Browser agent finished.',
            '📊 Usage (completed): task[prompt=40, output=4, thoughts=2, total=46, requests=1] | session[prompt=40, output=4, thoughts=2, total=46, requests=1] | model=gemini-3.1-flash-lite | thinking=medium',
        ].join('\n'),
    })
    const legacyBrowserLog = getRequestLog(legacyBrowserRequestId)
    check('legacy browser output usage is read back', legacyBrowserLog?.totalTokens === 46, legacyBrowserLog)
    check('legacy browser billing model is inferred', legacyBrowserLog?.billingBreakdown?.[0]?.model === 'gemini-3.1-flash-lite', legacyBrowserLog)

    let codexBaseline: TokenUsageBreakdown | null = null
    const codexFirstUsage = codexUsageForCurrentTurn({
        last: {
            inputTokens: 50,
            cachedInputTokens: 40,
            outputTokens: 5,
            reasoningOutputTokens: 2,
            totalTokens: 57,
        },
        total: {
            inputTokens: 1_000,
            cachedInputTokens: 940,
            outputTokens: 15,
            reasoningOutputTokens: 4,
            totalTokens: 1_019,
        },
    }, codexBaseline)
    codexBaseline = codexFirstUsage.baseline
    check('codex usage first update uses current turn delta', codexFirstUsage.usage?.inputTokens === 50 && codexFirstUsage.usage?.totalTokens === 57, codexFirstUsage)

    const codexSecondUsage = codexUsageForCurrentTurn({
        last: {
            inputTokens: 30,
            cachedInputTokens: 20,
            outputTokens: 8,
            reasoningOutputTokens: 3,
            totalTokens: 41,
        },
        total: {
            inputTokens: 1_030,
            cachedInputTokens: 960,
            outputTokens: 23,
            reasoningOutputTokens: 7,
            totalTokens: 1_060,
        },
    }, codexBaseline)
    check(
        'codex usage accumulates current turn without prior thread total',
        codexSecondUsage.usage?.inputTokens === 80 &&
        codexSecondUsage.usage?.cachedInputTokens === 60 &&
        codexSecondUsage.usage?.outputTokens === 13 &&
        codexSecondUsage.usage?.reasoningOutputTokens === 5 &&
        codexSecondUsage.usage?.totalTokens === 98,
        codexSecondUsage
    )

    const codexRequestId = 'req_observability_codex_usage_delta'
    logRequestStart({
        requestId: codexRequestId,
        conversationId: 'conv_observability_smoke',
        agentId: 'orchestrator',
        provider: 'codex',
        model: 'gpt-5.5',
        thinkingLevel: 'high',
        statefulMode: true,
        startedAt: now - 700,
        inputText: 'Run a Codex resumed-thread smoke task.',
    })
    logRequestComplete({
        requestId: codexRequestId,
        endedAt: now - 650,
        provider: 'codex',
        usage: codexSecondUsage.usage,
        outputText: 'Codex usage smoke.',
    })
    const codexLog = getRequestLog(codexRequestId)
    check('codex request log stores per-turn usage delta', codexLog?.inputTokens === 80 && codexLog?.totalTokens === 98, codexLog)

    const usage = buildUsageReport('all')
    const geminiUsage = usage.byModel.find((row) => row.provider === 'google' && row.model === 'gemini-3-flash-preview')
    check('usage report expands browser model calls', geminiUsage?.requests === 2, usage.byModel)
    const browserAgentUsage = usage.byAgent.find((row) => row.agentId === 'browser_agent')
    check('usage report attributes browser tokens to browser_agent', browserAgentUsage?.inputTokens === 140, usage.byAgent)

    const staleRequestId = 'req_observability_stale_stream'
    createConversation({
        id: 'conv_observability_smoke',
        title: 'Interrupted stream recovery',
        createdAt: now - 10_000,
        messages: [],
    })
    addMessage('conv_observability_smoke', {
        id: staleRequestId,
        role: 'assistant',
        content: 'Partial output before restart.',
        timestamp: now - 5_000,
    })
    logRequestStart({
        requestId: staleRequestId,
        conversationId: 'conv_observability_smoke',
        agentId: 'orchestrator',
        provider: 'openai',
        model: 'gpt-smoke',
        thinkingLevel: 'low',
        statefulMode: false,
        startedAt: now - 5_000,
        inputText: 'This request simulates a process restart before completion.',
    })
    const sealed = sealInterruptedStreamingRequestLogs({
        now,
        activeRequestIds: new Set<string>(),
        startedBefore: now + 1,
    })
    const staleLog = getRequestLog(staleRequestId)
    check('stale streaming request is sealed', sealed === 1)
    check('sealed request becomes aborted', staleLog?.status === 'aborted', staleLog)
    check('sealed request records restart hint', staleLog?.errorMessage?.includes('server process restarted'), staleLog)
    check(
        'sealed request also terminates its assistant message',
        getConversation('conv_observability_smoke')?.messages.find(message => message.id === staleRequestId)?.status === 'aborted',
        getConversation('conv_observability_smoke'),
    )

    const memberSealed = runWithProfileContext(
        { profileId: 'member_smoke', role: 'member' },
        () => {
            logRequestStart({
                requestId: 'req_member_interrupted_stream',
                conversationId: 'conv_member_interrupted_stream',
                agentId: 'browser_agent',
                provider: 'browser',
                model: 'default',
                thinkingLevel: 'medium',
                statefulMode: true,
                startedAt: now - 4_000,
                inputText: 'Member profile interrupted request.',
            })
            return sealInterruptedStreamingRequestLogs({
                now,
                activeRequestIds: new Set<string>(),
                startedBefore: now + 1,
            })
        },
    )
    check('interrupted recovery can sweep a member profile independently', memberSealed === 1, memberSealed)

    const index = await executeReadRuntimeIndex({ section: 'overview' })
    check('read_runtime_index overview succeeds', index.success === true)
    const overview = index.data as { run_index_files: string[]; log_index_files: string[] }
    check('run index file was written', overview.run_index_files.length === 1, overview)
    check('log index file was written', overview.log_index_files.length === 1, overview)

    const memberOverviewResult = await runWithProfileContext(
        { profileId: 'member_smoke', role: 'member' },
        async () => {
            appendRuntimeRunIndex({
                id: 'run_member_only',
                taskId: 'task_member_only',
                taskTitle: 'Member-only Smart Monitor',
                startedAt: now,
                endedAt: now + 10,
                status: 'ok',
                trigger: 'schedule',
                surfaced: false,
                conversationId: null,
                summary: 'Member-only run marker.',
            })
            appendRuntimeRequestLogIndex({
                id: 'request_member_only',
                conversationId: 'conversation_member_only',
                agentId: 'smart_monitor',
                agentThreadId: null,
                parentRequestId: null,
                depth: 0,
                provider: 'openai',
                model: 'gpt-smoke',
                status: 'ok',
                startedAt: now,
                endedAt: now + 10,
                durationMs: 10,
                toolCallCount: 0,
                interactionId: null,
                errorMessage: null,
                inputText: 'Member-only input marker.',
                outputText: 'Member-only output marker.',
            })
            return executeReadRuntimeIndex({ section: 'overview' })
        }
    )
    const memberOverview = memberOverviewResult.data as {
        profile_id: string
        root: string
        database_path: string
        run_index_files: string[]
        log_index_files: string[]
    }
    check('runtime index overview identifies active member profile', memberOverview.profile_id === 'member_smoke', memberOverview)
    check(
        'runtime index paths are isolated under member profile state',
        memberOverview.root.includes(`${path.sep}profiles${path.sep}member_smoke${path.sep}index`) &&
        memberOverview.database_path.includes(`${path.sep}profiles${path.sep}member_smoke${path.sep}data.db`),
        memberOverview
    )
    check('member run/log index files were written separately', memberOverview.run_index_files.length === 1 && memberOverview.log_index_files.length === 1, memberOverview)
    const memberRunText = fs.readFileSync(memberOverview.run_index_files[0], 'utf-8')
    const adminRunText = fs.readFileSync(overview.run_index_files[0], 'utf-8')
    check('member runtime index contains its own run', memberRunText.includes('run_member_only'))
    check('admin runtime index excludes member run', !adminRunText.includes('run_member_only'))

    if (failures > 0) process.exit(1)
    console.log('Observability tools smoke passed.')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
