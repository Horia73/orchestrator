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
 *   - stale running scripts are recovered by the watchdog;
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
        claimMicroscriptForWebhook,
        recoverStaleRunningMicroscripts,
    } = await import('@/lib/microscripts/store')
    const { runMicroscript, validateMicroscriptCode, createIdleAbortTimer } = await import('@/lib/microscripts/runner')
    const { listInboxConversations } = await import('@/lib/scheduling/store')
    const {
        executeMicroscriptCreate,
        executeMicroscriptGet,
        executeMicroscriptRunNow,
        executeMicroscriptUpdate,
    } = await import('@/lib/ai/tools/microscripts')

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

    const toolSurfaceScript = createMicroscript({
        title: 'Smoke tool update surface',
        code: validCode,
        enabled: false,
        manifest: {
            description: 'Smoke tool strict args and update dry-run test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const strictGet = await executeMicroscriptGet({ id: toolSurfaceScript.id })
    check(
        'microscript_get rejects id alias with exact script_id guidance',
        strictGet.success === false && /unknown argument.*id/i.test(strictGet.error ?? '') && /script_id/.test(strictGet.error ?? ''),
        strictGet,
    )
    const strictUpdate = await executeMicroscriptUpdate({ script_id: toolSurfaceScript.id, dryRun: true })
    check(
        'microscript_update rejects unsupported camel dryRun field',
        strictUpdate.success === false && /unknown argument.*dryRun/i.test(strictUpdate.error ?? '') && /dry_run/.test(strictUpdate.error ?? ''),
        strictUpdate,
    )

    const beforeNoop = getMicroscript(toolSurfaceScript.id)
    const beforeNoopEvents = listMicroscriptEvents(toolSurfaceScript.id).length
    const dryNoop = await executeMicroscriptUpdate({
        script_id: toolSurfaceScript.id,
        dry_run: true,
        code: validCode,
    })
    const afterDryNoop = getMicroscript(toolSurfaceScript.id)
    check(
        'microscript_update dry_run previews same-code no-op without writing',
        dryNoop.success === true
            && (dryNoop.data as { changed?: boolean; write_performed?: boolean }).changed === false
            && (dryNoop.data as { write_performed?: boolean }).write_performed === false
            && afterDryNoop?.updatedAt === beforeNoop?.updatedAt
            && afterDryNoop?.codeHash === beforeNoop?.codeHash
            && listMicroscriptEvents(toolSurfaceScript.id).length === beforeNoopEvents,
        { dryNoop, beforeNoop, afterDryNoop },
    )
    const realNoop = await executeMicroscriptUpdate({
        script_id: toolSurfaceScript.id,
        code: validCode,
    })
    const afterRealNoop = getMicroscript(toolSurfaceScript.id)
    check(
        'microscript_update real no-op does not touch updatedAt/hash/events',
        realNoop.success === true
            && (realNoop.data as { changed?: boolean; write_performed?: boolean }).changed === false
            && (realNoop.data as { write_performed?: boolean }).write_performed === false
            && afterRealNoop?.updatedAt === beforeNoop?.updatedAt
            && afterRealNoop?.codeHash === beforeNoop?.codeHash
            && listMicroscriptEvents(toolSurfaceScript.id).length === beforeNoopEvents,
        { realNoop, beforeNoop, afterRealNoop },
    )
    const changedCode = `${validCode}\n# updated by smoke`
    const dryChanged = await executeMicroscriptUpdate({
        script_id: toolSurfaceScript.id,
        dry_run: true,
        code: changedCode,
    })
    const afterDryChanged = getMicroscript(toolSurfaceScript.id)
    check(
        'microscript_update dry_run validates changed code without changing stored hash',
        dryChanged.success === true
            && (dryChanged.data as { changed?: boolean; changed_fields?: string[] }).changed === true
            && ((dryChanged.data as { changed_fields?: string[] }).changed_fields ?? []).includes('codeHash')
            && afterDryChanged?.codeHash === beforeNoop?.codeHash
            && listMicroscriptEvents(toolSurfaceScript.id).length === beforeNoopEvents,
        { dryChanged, beforeNoop, afterDryChanged },
    )
    const realChanged = await executeMicroscriptUpdate({
        script_id: toolSurfaceScript.id,
        code: changedCode,
    })
    const afterRealChanged = getMicroscript(toolSurfaceScript.id)
    const changedEvents = listMicroscriptEvents(toolSurfaceScript.id)
    check(
        'microscript_update changed code writes exactly one updated event and stable readback hash',
        realChanged.success === true
            && afterRealChanged?.code === changedCode
            && afterRealChanged?.codeHash !== beforeNoop?.codeHash
            && changedEvents.filter((e) => e.kind === 'updated').length === 1,
        { realChanged, beforeNoop, afterRealChanged, changedEvents },
    )
    const readbackChanged = await executeMicroscriptGet({ script_id: toolSurfaceScript.id, include_code: true })
    check(
        'microscript_get readback code_hash matches stored hash after update',
        readbackChanged.success === true
            && (readbackChanged.data as { code_hash?: string; code?: string }).code_hash === afterRealChanged?.codeHash
            && (readbackChanged.data as { code?: string }).code === changedCode,
        readbackChanged,
    )
    const repeatedNoop = await executeMicroscriptUpdate({
        script_id: toolSurfaceScript.id,
        code: changedCode,
    })
    check(
        'repeating same update does not emit another updated event',
        repeatedNoop.success === true
            && (repeatedNoop.data as { changed?: boolean }).changed === false
            && listMicroscriptEvents(toolSurfaceScript.id).filter((e) => e.kind === 'updated').length === 1,
        repeatedNoop,
    )

    const dryNotifyCode = `
def run(ctx):
    state = dict(ctx.get("state", {}))
    if ctx.get("trigger") == "webhook":
        state["zone"] = ctx.get("webhook", {}).get("payload", {}).get("zone")
    results = ctx.get("results", {})
    if "notify" not in results:
        return {
            "summary": "queue dry notify",
            "state": state,
            "requests": [
                {"id": "notify", "kind": "notify.inbox", "title": "Dry run", "body": "Dry run notification."}
            ],
        }
    state["notified"] = results["notify"]["ok"]
    return {"summary": "dry notify done", "state": state, "status": "complete"}
`.trim()
    const dryNotifyScript = createMicroscript({
        title: 'Smoke run dry notify',
        code: dryNotifyCode,
        enabled: false,
        manifest: {
            description: 'Smoke run_now dry-run notification simulation',
            schedule: { kind: 'manual' },
            permissions: [{ kind: 'notify_inbox' }],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const beforeDryRun = getMicroscript(dryNotifyScript.id)
    const beforeDryRunEvents = listMicroscriptEvents(dryNotifyScript.id).length
    const beforeDryRunInbox = listInboxConversations().length
    const dryRunWithWebhook = await executeMicroscriptRunNow({
        script_id: dryNotifyScript.id,
        dry_run: true,
        test_context: {
            trigger: 'webhook',
            state: { seen: 1 },
            webhook: {
                eventId: 'whe_smoke',
                endpointId: 'wh_smoke',
                slug: 'gym-events',
                source: 'home_assistant',
                eventType: 'location.changed',
                dedupeKey: 'sample-1',
                payload: { zone: 'home' },
                normalized: { zone: 'home' },
            },
        },
    })
    const afterDryRun = getMicroscript(dryNotifyScript.id)
    check(
        'microscript_run_now dry_run simulates webhook/state/notify without production writes',
        dryRunWithWebhook.success === true
            && (dryRunWithWebhook.data as { dryRun?: boolean; wouldSurface?: boolean }).dryRun === true
            && (dryRunWithWebhook.data as { wouldSurface?: boolean }).wouldSurface === true
            && (dryRunWithWebhook.data as { state?: { zone?: string; notified?: boolean } }).state?.zone === 'home'
            && (dryRunWithWebhook.data as { state?: { notified?: boolean } }).state?.notified === true
            && afterDryRun?.updatedAt === beforeDryRun?.updatedAt
            && afterDryRun?.runCount === beforeDryRun?.runCount
            && Object.keys(afterDryRun?.state ?? {}).length === 0
            && listMicroscriptEvents(dryNotifyScript.id).length === beforeDryRunEvents
            && listInboxConversations().length === beforeDryRunInbox,
        { dryRunWithWebhook, beforeDryRun, afterDryRun },
    )
    const liveRunWithTestContext = await executeMicroscriptRunNow({
        script_id: dryNotifyScript.id,
        test_context: { state: {} },
    })
    check(
        'microscript_run_now rejects test_context without dry_run',
        liveRunWithTestContext.success === false && /dry_run=true/.test(liveRunWithTestContext.error ?? ''),
        liveRunWithTestContext,
    )

    const dryAgentCode = `
def run(ctx):
    results = ctx.get("results", {})
    if "agent" not in results:
        return {
            "requests": [
                {"id": "agent", "kind": "agent.wake", "agent_id": "orchestrator", "prompt": "Dry-run judgement only."}
            ]
        }
    return {
        "summary": "dry agent done",
        "state": {"would_wake": results["agent"]["data"]["wouldWakeAgent"]},
        "status": "complete",
    }
`.trim()
    const dryAgentScript = createMicroscript({
        title: 'Smoke run dry agent',
        code: dryAgentCode,
        enabled: false,
        manifest: {
            description: 'Smoke run_now dry-run agent wake simulation',
            schedule: { kind: 'manual' },
            permissions: [{ kind: 'agent_wake', agentIds: ['orchestrator'], maxPromptChars: 1_000, allowNotifyInbox: true }],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const beforeDryAgentEvents = listMicroscriptEvents(dryAgentScript.id).length
    const beforeDryAgentInbox = listInboxConversations().length
    const dryAgentRun = await executeMicroscriptRunNow({
        script_id: dryAgentScript.id,
        dry_run: true,
    })
    const afterDryAgent = getMicroscript(dryAgentScript.id)
    check(
        'microscript_run_now dry_run simulates agent wake without waking agent or Inbox',
        dryAgentRun.success === true
            && (dryAgentRun.data as { state?: { would_wake?: boolean } }).state?.would_wake === true
            && afterDryAgent?.runCount === 0
            && Object.keys(afterDryAgent?.state ?? {}).length === 0
            && listMicroscriptEvents(dryAgentScript.id).length === beforeDryAgentEvents
            && listInboxConversations().length === beforeDryAgentInbox,
        { dryAgentRun, afterDryAgent },
    )

    const staleScript = createMicroscript({
        title: 'Smoke stale running recovery',
        code: validCode,
        enabled: true,
        manifest: {
            description: 'Smoke stale-running watchdog test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: true, expiresAt: null },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const claimedStale = claimMicroscriptForWebhook(staleScript.id, Date.now())
    const recoveredStale = recoverStaleRunningMicroscripts(Date.now() + 31 * 60_000, 30 * 60_000)
    const afterStaleRecovery = getMicroscript(staleScript.id)
    check(
        'stale running microscript watchdog recovers script to error',
        Boolean(claimedStale)
            && recoveredStale.some((script) => script.id === staleScript.id)
            && afterStaleRecovery?.status === 'error'
            && afterStaleRecovery.lastRunStatus === 'error'
            && /stale-running watchdog/.test(afterStaleRecovery.lastRunError ?? '')
            && listMicroscriptEvents(staleScript.id).some((event) => event.kind === 'recovered'),
        { claimedStale, recoveredStale, afterStaleRecovery },
    )

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

    // Tail read: ctx.file_read(path, tail_bytes=N) returns only the last N bytes
    // of a growing journal (with tail/truncated/totalBytes flags), so a script
    // can follow an append-only log without pulling the whole file each run.
    const tailReadCode = `
def run(ctx):
    body = "".join("line%d\\n" % i for i in range(1000))
    ctx.file_write("journal.log", body)
    r = ctx.file_read("journal.log", tail_bytes=40)
    d = r["data"]
    return ctx.complete(state={"content": d["content"], "truncated": d.get("truncated"), "total": d.get("totalBytes")}, summary="tail ok")
`.trim()
    const tailRead = createMicroscript({
        title: 'Smoke tail read',
        code: tailReadCode,
        enabled: false,
        manifest: {
            description: 'Smoke file tail-read test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: false, expiresAt: Date.now() + 60_000 },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    await runMicroscript(tailRead, { trigger: 'manual', preserveEnabled: true })
    const tailReadAfter = getMicroscript(tailRead.id)
    const tailState = tailReadAfter?.state as { content?: string; truncated?: boolean; total?: number } | undefined
    check(
        'file_read tail_bytes returns only the last slice with truncated/total flags',
        typeof tailState?.content === 'string' &&
            tailState.content.length === 40 &&
            tailState.content.endsWith('line999\n') &&
            tailState.truncated === true &&
            (tailState.total ?? 0) > 40,
        tailState
    )

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
    // A run whose Python phase completed but whose only operation failed is
    // unhealthy: it must count toward the consecutive-failure breaker (so a
    // bulk sender against a dead integration self-pauses) and be recorded as an
    // errored run, even though the runner did not throw.
    check(
        'all-operations-failed run counts toward the failure breaker',
        deniedAfter?.consecutiveFailures === 1 && deniedAfter?.lastRunStatus === 'error',
        { consecutiveFailures: deniedAfter?.consecutiveFailures, lastRunStatus: deniedAfter?.lastRunStatus }
    )

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

    // Idle-abort timer powering the agent-wake no-progress timeout: bumps reset
    // the window, it fires exactly once after idle silence, and 0 disables it.
    {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        let fires = 0
        const idle = createIdleAbortTimer(120, () => { fires += 1 })
        idle.bump()
        await sleep(40); idle.bump()
        await sleep(40); idle.bump() // ~80ms of activity, window 120ms — must NOT fire yet
        const firesDuringActivity = fires
        await sleep(320) // 320ms of silence > 120ms window — must fire exactly once
        const firesAfterIdle = fires
        idle.clear()
        await sleep(180) // cleared timer must never fire again
        check(
            'agent-wake idle timer resets on activity and fires once after idle window',
            firesDuringActivity === 0 && firesAfterIdle === 1 && fires === 1,
            { firesDuringActivity, firesAfterIdle, fires },
        )

        let disabledFires = 0
        const disabled = createIdleAbortTimer(0, () => { disabledFires += 1 })
        disabled.bump()
        await sleep(60)
        disabled.clear()
        check('agent-wake idle timer with 0 disables the timeout', disabledFires === 0, { disabledFires })
    }

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
