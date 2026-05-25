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
    const { logRequestComplete, logRequestStart, logToolCall } = await import('@/lib/observability/store')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  (${JSON.stringify(detail)})`}`)
        if (!ok) failures++
    }

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
    const runRows = (runs.data as { runs: Array<{ run_id: string; task_title: string }> }).runs
    check('search_past_runs finds smoke run', runRows.length === 1 && runRows[0].task_title === task.title, runs.data)

    const run = await executeGetPastRun({ run_id: runRows[0].run_id })
    check('get_past_run succeeds', run.success === true)
    check('get_past_run returns summary', (run.data as { summary: string }).summary.includes('Smoke marker'))

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
    const logRows = (logs.data as { logs: Array<{ request_id: string }> }).logs
    check('search_agent_logs finds request', logRows.some((row) => row.request_id === requestId), logs.data)

    const log = await executeGetAgentLog({ request_id: requestId })
    check('get_agent_log succeeds', log.success === true)
    const logData = log.data as { output_text: string; tool_logs: unknown[] }
    check('get_agent_log returns output text', logData.output_text.includes('Runtime history'))
    check('get_agent_log returns tool logs', logData.tool_logs.length === 1)

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
