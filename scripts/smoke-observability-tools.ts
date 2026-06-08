/**
 * Smoke test for orchestrator read-only history tools.
 *
 * Uses a temporary cwd so it does not touch the real .orchestrator/data.db.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

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

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
        if (!ok) failures++
    }

    updateConfig({ timezone: 'Europe/Bucharest' })

    const now = Date.now()
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

    const usage = buildUsageReport('all')
    const geminiUsage = usage.byModel.find((row) => row.provider === 'google' && row.model === 'gemini-3-flash-preview')
    check('usage report expands browser model calls', geminiUsage?.requests === 2, usage.byModel)
    const browserAgentUsage = usage.byAgent.find((row) => row.agentId === 'browser_agent')
    check('usage report attributes browser tokens to browser_agent', browserAgentUsage?.inputTokens === 140, usage.byAgent)

    const staleRequestId = 'req_observability_stale_stream'
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

    const index = await executeReadRuntimeIndex({ section: 'overview' })
    check('read_runtime_index overview succeeds', index.success === true)
    const overview = index.data as { run_index_files: string[]; log_index_files: string[] }
    check('run index file was written', overview.run_index_files.length === 1, overview)
    check('log index file was written', overview.log_index_files.length === 1, overview)

    if (failures > 0) process.exit(1)
    console.log('Observability tools smoke passed.')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
