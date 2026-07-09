/** Smoke test: heavy-detail retention preserves durable audit/usage rows. */
import fs from 'fs'
import os from 'os'
import path from 'path'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-storage-retention-'))
process.env.ORCHESTRATOR_STATE_DIR = stateDir

let failures = 0
function check(label: string, condition: unknown, detail?: unknown): void {
    const ok = Boolean(condition)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
    if (!ok) failures++
}

async function main(): Promise<void> {
    const { default: db } = await import('@/lib/db')
    const { pruneStoredDetails } = await import('@/lib/storage/retention')
    const now = Date.UTC(2026, 6, 9)
    const day = 86_400_000
    const oldAt = now - 31 * day
    const recentAt = now - day

    const insertRequest = db.prepare(`
        INSERT INTO request_logs (
            id, conversationId, agentId, provider, model, thinkingLevel,
            status, startedAt, statefulMode, toolCallCount
        ) VALUES (?, 'conv', 'orchestrator', 'test', 'test', 'medium', 'ok', ?, 0, 1)
    `)
    insertRequest.run('old-request', oldAt)
    insertRequest.run('recent-request', recentAt)

    const insertInput = db.prepare(`
        INSERT INTO request_log_input (requestId, systemPrompt, messages, tools, createdAt)
        VALUES (?, 'large prompt', '[]', '[]', ?)
    `)
    insertInput.run('old-request', oldAt)
    insertInput.run('recent-request', recentAt)
    const insertReasoning = db.prepare(`
        INSERT INTO request_log_reasoning (requestId, reasoning, contentSegments)
        VALUES (?, '[{"type":"thinking"}]', '[{"content":"answer"}]')
    `)
    insertReasoning.run('old-request')
    insertReasoning.run('recent-request')

    const insertTool = db.prepare(`
        INSERT INTO tool_logs (requestId, toolName, success, startedAt)
        VALUES (?, 'Read', 1, ?)
    `)
    insertTool.run('old-request', now - 91 * day)
    insertTool.run('recent-request', recentAt)

    const insertRun = db.prepare(`
        INSERT INTO scheduled_task_runs (
            id, taskId, startedAt, endedAt, status, trigger, surfaced,
            summary, contentSegments, reasoning, attachments
        ) VALUES (?, 'task', ?, ?, 'ok', 'schedule', 0, ?, '[{"content":"x"}]', '[{"type":"thinking"}]', '[{"id":"file"}]')
    `)
    insertRun.run('old-run', oldAt, oldAt + 1000, 'old summary must remain')
    insertRun.run('recent-run', recentAt, recentAt + 1000, 'recent summary')

    const result = pruneStoredDetails(now, {
        exactLogDays: 30,
        scheduledRunDetailDays: 30,
        toolLogDays: 90,
    })
    check('retention reports one deletion/compaction per old detail class',
        result.requestInputsDeleted === 1
        && result.requestReasoningDeleted === 1
        && result.scheduledRunDetailsCompacted === 1
        && result.toolLogsDeleted === 1,
        result)
    check('request usage/audit rows remain',
        (db.prepare(`SELECT COUNT(*) AS count FROM request_logs`).get() as { count: number }).count === 2)
    check('recent exact input and reasoning remain',
        Boolean(db.prepare(`SELECT 1 FROM request_log_input WHERE requestId = 'recent-request'`).get())
        && Boolean(db.prepare(`SELECT 1 FROM request_log_reasoning WHERE requestId = 'recent-request'`).get()))
    check('old exact input and reasoning are removed',
        !db.prepare(`SELECT 1 FROM request_log_input WHERE requestId = 'old-request'`).get()
        && !db.prepare(`SELECT 1 FROM request_log_reasoning WHERE requestId = 'old-request'`).get())

    const oldRun = db.prepare(`
        SELECT summary, contentSegments, reasoning, attachments
        FROM scheduled_task_runs WHERE id = 'old-run'
    `).get() as {
        summary: string
        contentSegments: string | null
        reasoning: string | null
        attachments: string | null
    }
    check('old scheduled-run summary remains while heavy detail is nulled',
        oldRun.summary === 'old summary must remain'
        && oldRun.contentSegments === null
        && oldRun.reasoning === null
        && oldRun.attachments === null,
        oldRun)
    const recentRun = db.prepare(`
        SELECT contentSegments, reasoning, attachments
        FROM scheduled_task_runs WHERE id = 'recent-run'
    `).get() as {
        contentSegments: string | null
        reasoning: string | null
        attachments: string | null
    }
    check('recent scheduled-run rich detail remains',
        recentRun.contentSegments !== null
        && recentRun.reasoning !== null
        && recentRun.attachments !== null)

    fs.rmSync(stateDir, { recursive: true, force: true })
    if (failures > 0) process.exit(1)
    console.log('\nAll storage-retention checks passed')
}

main().catch(error => {
    fs.rmSync(stateDir, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
})
