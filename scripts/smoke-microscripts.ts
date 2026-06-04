/**
 * Smoke test for Microscripts.
 *
 * Runs against a temporary DB/workspace. Validates:
 *   - trusted Python validation accepts normal imports;
 *   - create/get/list round-trip;
 *   - phase-based operation execution;
 *   - notify_inbox permission posts one Inbox item;
 *   - completeOnNotification completes/disables;
 *   - missing permission is denied in-band;
 *   - blocked actions explain AGENT_NEEDS.md escalation;
 *   - agent wake requests require explicit permission;
 *   - direct trusted Python file access stays inside script workspace.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'microscripts-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const { updateConfig } = await import('@/lib/config')
    const {
        createMicroscript,
        getMicroscript,
        listMicroscriptEvents,
        listMicroscripts,
    } = await import('@/lib/microscripts/store')
    const { runMicroscript, validateMicroscriptCode } = await import('@/lib/microscripts/runner')
    const { listInboxConversations } = await import('@/lib/scheduling/store')
    const { executeMicroscriptCreate } = await import('@/lib/ai/tools/microscripts')

    updateConfig({ timezone: 'Europe/Bucharest' })

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
        if (!ok) failures++
    }

    const acceptedImport = await validateMicroscriptCode('import json\n\ndef run(ctx):\n    return {"summary": json.dumps({"ok": True}), "status": "complete"}')
    check('validator accepts trusted Python imports', acceptedImport.ok === true, acceptedImport)

    const rejectedSyntax = await validateMicroscriptCode('def run(ctx):\n    return {')
    check('validator rejects syntax errors', rejectedSyntax.ok === false, rejectedSyntax)

    const validCode = 'def run(ctx):\n    return {"summary": "ok", "status": "complete"}'
    const accepted = await validateMicroscriptCode(validCode)
    check('validator accepts minimal valid script', accepted.ok === true, accepted)

    const toolCreated = await executeMicroscriptCreate({
        title: 'Smoke tool create',
        code: validCode,
        enabled: false,
        manifest: {
            description: 'Smoke create through tool',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    check('microscript_create tool accepts minimal valid script', toolCreated.success === true, toolCreated)

    const directFileCode = `
def run(ctx):
    with open("notes/hello.txt", "w") as f:
        f.write("hello")
    with open("notes/hello.txt", "r") as f:
        content = f.read()
    return ctx.complete(state={"content": content}, summary="direct file ok")
`.trim()
    const directFile = createMicroscript({
        title: 'Smoke trusted direct files',
        code: directFileCode,
        enabled: false,
        manifest: {
            description: 'Smoke trusted Python direct file test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const directFileResult = await runMicroscript(directFile, { trigger: 'manual', preserveEnabled: true })
    const directFileAfter = getMicroscript(directFile.id)
    check('trusted Python direct file access works inside workspace', directFileResult.ok && directFileAfter?.state.content === 'hello', directFileAfter)

    const zoneInfoCode = `
from datetime import datetime
from zoneinfo import ZoneInfo

def run(ctx):
    tz = ctx["timezone"]
    local = datetime.now(ZoneInfo(tz))
    return ctx.complete(
        state={"timezone": tz, "offset": local.strftime("%z"), "local_time": ctx.get("local_time")},
        summary="zoneinfo ok",
    )
`.trim()
    const zoneInfoScript = createMicroscript({
        title: 'Smoke timezone ZoneInfo',
        code: zoneInfoCode,
        enabled: false,
        manifest: {
            description: 'Smoke Python ZoneInfo timezone data access',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const zoneInfoResult = await runMicroscript(zoneInfoScript, { trigger: 'manual', preserveEnabled: true })
    const zoneInfoAfter = getMicroscript(zoneInfoScript.id)
    check(
        'trusted Python can read system timezone data read-only',
        zoneInfoResult.ok
            && zoneInfoAfter?.state.timezone === 'Europe/Bucharest'
            && (zoneInfoAfter.state.offset === '+0200' || zoneInfoAfter.state.offset === '+0300'),
        zoneInfoAfter,
    )

    const absoluteFileCode = `
def run(ctx):
    with open("/etc/passwd", "r") as f:
        return ctx.complete(summary=f.read(1))
`.trim()
    const absoluteFile = createMicroscript({
        title: 'Smoke blocked absolute file',
        code: absoluteFileCode,
        enabled: false,
        manifest: {
            description: 'Smoke absolute file path denial',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const absoluteFileResult = await runMicroscript(absoluteFile, { trigger: 'manual', preserveEnabled: true })
    check('absolute non-timezone file access remains blocked', absoluteFileResult.ok === false && absoluteFileResult.error?.includes('absolute filesystem path'), absoluteFileResult)

    const blockedShellCode = `
import subprocess

def run(ctx):
    subprocess.run(["echo", "nope"])
    return ctx.complete()
`.trim()
    const blockedShell = createMicroscript({
        title: 'Smoke blocked shell',
        code: blockedShellCode,
        enabled: false,
        manifest: {
            description: 'Smoke blocked shell guidance test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const blockedShellResult = await runMicroscript(blockedShell, { trigger: 'manual', preserveEnabled: true })
    check('blocked shell explains AGENT_NEEDS.md escalation', blockedShellResult.ok === false && blockedShellResult.error?.includes('AGENT_NEEDS.md'), blockedShellResult)

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

    const agentDeniedCode = `
def run(ctx):
    results = ctx.get("results", {})
    if "agent" not in results:
        return {
            "requests": [
                {"id": "agent", "kind": "agent.wake", "prompt": "This should not run."}
            ]
        }
    result = results["agent"]
    return {"summary": result.get("error", "missing error"), "status": "complete", "state": {"agent_denied": not result["ok"]}}
`.trim()
    const agentDenied = createMicroscript({
        title: 'Smoke agent denied',
        code: agentDeniedCode,
        enabled: false,
        manifest: {
            description: 'Smoke agent wake permission denial test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const agentDeniedResult = await runMicroscript(agentDenied, { trigger: 'manual', preserveEnabled: true })
    const agentDeniedAfter = getMicroscript(agentDenied.id)
    check('agent wake permission denial is in-band', agentDeniedResult.ok && agentDeniedAfter?.state.agent_denied === true, agentDeniedAfter)

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
