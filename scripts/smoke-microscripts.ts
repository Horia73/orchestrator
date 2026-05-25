/**
 * Smoke test for Microscripts.
 *
 * Runs against a temporary DB/workspace. Validates:
 *   - code validation rejects imports;
 *   - create/get/list round-trip;
 *   - phase-based operation execution;
 *   - notify_inbox permission posts one Inbox item;
 *   - completeOnNotification completes/disables;
 *   - missing permission is denied in-band;
 *   - file read/write operations stay inside script workspace.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'microscripts-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const {
        createMicroscript,
        getMicroscript,
        listMicroscriptEvents,
        listMicroscripts,
    } = await import('@/lib/microscripts/store')
    const { runMicroscript, validateMicroscriptCode } = await import('@/lib/microscripts/runner')
    const { listInboxConversations } = await import('@/lib/scheduling/store')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
        if (!ok) failures++
    }

    const rejected = await validateMicroscriptCode('import os\n\ndef run(ctx):\n    return {}')
    check('validator rejects imports', rejected.ok === false, rejected)

    const notifyCode = `
def run(ctx):
    state = ctx.get("state", {})
    results = ctx.get("results", {})
    if state.get("notified"):
        return {"summary": "already notified", "state": state, "status": "complete"}
    if "notify" not in results:
        return {
            "summary": "queue notify",
            "state": {"notified": True},
            "requests": [
                {"id": "notify", "kind": "notify.inbox", "title": "Smoke", "body": "Microscript smoke notification."}
            ]
        }
    return {"summary": "done", "state": {"notified": True}, "status": "complete"}
`.trim()

    const created = createMicroscript({
        title: 'Smoke notify',
        code: notifyCode,
        enabled: false,
        manifest: {
            description: 'Smoke notification test',
            schedule: { kind: 'manual' },
            permissions: [{ kind: 'notify_inbox' }],
            stop: { completeOnNotification: true, persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
        initialState: {},
    })
    check('create round-trip id', created.id.startsWith('ms_'))
    check('getMicroscript returns created', getMicroscript(created.id)?.title === 'Smoke notify')
    check('listMicroscripts contains created', listMicroscripts().some((s) => s.id === created.id))

    const notifyResult = await runMicroscript(created, { trigger: 'manual', preserveEnabled: true })
    const afterNotify = getMicroscript(created.id)
    check('notify run ok', notifyResult.ok, notifyResult)
    check('notify surfaced inbox', notifyResult.surfaced && Boolean(notifyResult.conversationId), notifyResult)
    check('completeOnNotification completed script', afterNotify?.status === 'completed' && afterNotify.enabled === false, afterNotify)
    check('inbox item created', listInboxConversations().some((i) => i.id === notifyResult.conversationId))
    check('operation event recorded', listMicroscriptEvents(created.id).some((e) => e.kind === 'operation_ok'))

    const deniedCode = `
def run(ctx):
    results = ctx.get("results", {})
    if "notify" not in results:
        return {
            "requests": [
                {"id": "notify", "kind": "notify.inbox", "body": "should not post"}
            ],
            "nextCheckAfterMs": 60000
        }
    result = results["notify"]
    return {"summary": result.get("error", "missing error"), "status": "complete", "state": {"denied": not result["ok"]}}
`.trim()
    const denied = createMicroscript({
        title: 'Smoke denied',
        code: deniedCode,
        enabled: false,
        manifest: {
            description: 'Smoke permission denial test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const deniedResult = await runMicroscript(denied, { trigger: 'manual', preserveEnabled: true })
    const deniedAfter = getMicroscript(denied.id)
    check('permission denial is in-band and run completes', deniedResult.ok && deniedAfter?.state.denied === true, deniedAfter)
    check('permission denial records operation_error', listMicroscriptEvents(denied.id).some((e) => e.kind === 'operation_error'))

    const fileCode = `
def run(ctx):
    results = ctx.get("results", {})
    if "write" not in results:
        return {"requests": [{"id": "write", "kind": "file.write", "path": "note.txt", "content": "hello"}]}
    if "read" not in results:
        return {"requests": [{"id": "read", "kind": "file.read", "path": "note.txt"}]}
    return {"summary": results["read"]["data"]["content"], "state": {"content": results["read"]["data"]["content"]}, "status": "complete"}
`.trim()
    const fileScript = createMicroscript({
        title: 'Smoke files',
        code: fileCode,
        enabled: false,
        manifest: {
            description: 'Smoke file test',
            schedule: { kind: 'manual' },
            permissions: [{ kind: 'files', read: true, write: true, maxBytes: 10_000 }],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const fileResult = await runMicroscript(fileScript, { trigger: 'manual', preserveEnabled: true })
    const fileAfter = getMicroscript(fileScript.id)
    check('file read/write works', fileResult.ok && fileAfter?.state.content === 'hello', fileAfter)

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
