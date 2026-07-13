/**
 * End-to-end smoke coverage for the remote_sudo tool without an SSH server.
 * A deterministic PTY transport verifies stdin behavior while the real tool
 * executor performs env-name resolution, prompt detection, and redaction.
 */
import { executeRemoteSudo } from '@/lib/ai/tools/remote-sudo'
import { redactToolArgs } from '@/lib/ai/tools/redaction'

const SENTINEL = 'remote-sudo-sentinel-DO-NOT-LOG-7uQ9'
const ENV_KEY = 'REMOTE_SUDO_SMOKE_PASSWORD'
process.env[ENV_KEY] = SENTINEL

let failures = 0
function check(label: string, condition: unknown, detail?: unknown) {
    const ok = Boolean(condition)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
    if (!ok) failures += 1
}

type Scenario =
    | { kind: 'exit'; output: string; exitCode: number }
    | { kind: 'prompt'; exitCode: number; afterWrite: string }

function transport(scenarios: Scenario[]) {
    const invocations: Array<{ file: string; args: string[] }> = []
    const writes: string[] = []
    let index = 0
    return {
        invocations,
        writes,
        spawnPty(file: string, args: string[]) {
            const scenario = scenarios[index++]
            if (!scenario) throw new Error('Unexpected SSH phase')
            invocations.push({ file, args })
            let onData: (data: string) => void = () => undefined
            let onExit: (event: { exitCode: number }) => void = () => undefined
            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                queueMicrotask(() => onExit({ exitCode: scenario.exitCode }))
            }
            queueMicrotask(() => {
                if (scenario.kind === 'exit') {
                    onData(scenario.output)
                    finish()
                    return
                }
                // Split the marker to prove prompt detection works across PTY
                // chunk boundaries. Do not exit until the tool answers it.
                onData('[orchestrator-sudo-')
                onData('password]: ')
            })
            return {
                onData(callback: (data: string) => void) { onData = callback },
                onExit(callback: (event: { exitCode: number }) => void) { onExit = callback },
                write(data: string) {
                    writes.push(data)
                    if (scenario.kind === 'prompt') {
                        onData(scenario.afterWrite)
                        finish()
                    }
                },
                kill() { finish() },
            }
        },
    }
}

const baseArgs = {
    host: 'server.example.test',
    user: 'deploy',
    command: 'systemctl restart orchestrator',
    password_env_key: ENV_KEY,
}

// sudo -n succeeds: one SSH phase, absolutely no password/stdin write.
const fastTransport = transport([{ kind: 'exit', output: 'restarted\r\n', exitCode: 0 }])
const fast = await executeRemoteSudo(baseArgs, undefined, { spawnPty: fastTransport.spawnPty })
check('sudo -n success returns success', fast.success === true, fast)
check('sudo -n sends no password or stdin', fastTransport.writes.length === 0, fastTransport.writes)
check('sudo -n uses one SSH phase', fastTransport.invocations.length === 1)
check('sudo -n rendered argv has no sentinel', !JSON.stringify(fastTransport.invocations).includes(SENTINEL))

// Only the canonical sudo -n password-required result unlocks a second phase;
// that phase waits for its exact marker and writes the secret once.
const liveDeltas: string[] = []
const promptTransport = transport([
    { kind: 'exit', output: 'sudo: a password is required\r\n', exitCode: 1 },
    { kind: 'prompt', afterWrite: `accepted ${SENTINEL}\r\ndone\r\n`, exitCode: 0 },
])
const prompted = await executeRemoteSudo(baseArgs, {
    callerAgentId: 'orchestrator',
    depth: 0,
    conversationId: 'remote-sudo-smoke',
    parentRequestId: 'remote-sudo-smoke-request',
    currentToolCallId: 'remote-sudo-smoke',
    onToolDelta: (_id, _name, delta) => { liveDeltas.push(String(delta.text ?? '')) },
}, { spawnPty: promptTransport.spawnPty })
check('real sudo prompt path succeeds', prompted.success === true, prompted)
check('actual prompt receives password exactly once', promptTransport.writes.length === 1 && promptTransport.writes[0] === `${SENTINEL}\n`, promptTransport.writes.length)
check('password is absent from both rendered SSH commands', !JSON.stringify(promptTransport.invocations).includes(SENTINEL))
check('password is redacted from success result/output', !JSON.stringify(prompted).includes(SENTINEL), prompted)
check('password is redacted from streamed PTY logs', !liveDeltas.join('').includes(SENTINEL), liveDeltas)

// A generic SSH failure must not cause the secret to be written.
const noPromptTransport = transport([{ kind: 'exit', output: 'ssh: connect to host failed\r\n', exitCode: 255 }])
const noPrompt = await executeRemoteSudo(baseArgs, undefined, { spawnPty: noPromptTransport.spawnPty })
check('non-sudo SSH failure stays failed', noPrompt.success === false)
check('non-prompt failure sends no password', noPromptTransport.writes.length === 0)
check('non-prompt error has no sentinel', !JSON.stringify(noPrompt).includes(SENTINEL), noPrompt)

// Failure after a real prompt remains redacted end-to-end.
const failureTransport = transport([
    { kind: 'exit', output: 'sudo: password is required\r\n', exitCode: 1 },
    { kind: 'prompt', afterWrite: `${SENTINEL}\r\nSorry, try again.\r\n`, exitCode: 1 },
])
const failed = await executeRemoteSudo(baseArgs, undefined, { spawnPty: failureTransport.spawnPty })
check('prompted sudo failure returns failure', failed.success === false)
check('prompted failure writes password once only', failureTransport.writes.length === 1)
check('prompted error is secret-free', !JSON.stringify(failed).includes(SENTINEL), failed)

const maliciousArgs = { ...baseArgs, password: SENTINEL, stdin: SENTINEL }
const persistedArgs = redactToolArgs('remote_sudo', maliciousArgs)
check('reasoning/tool-log arg redaction drops unknown secret fields', !JSON.stringify(persistedArgs).includes(SENTINEL), persistedArgs)
check('model-visible args contain env name, never value', !JSON.stringify(baseArgs).includes(SENTINEL))

delete process.env[ENV_KEY]
if (failures > 0) {
    console.error(`\n${failures} remote sudo smoke check(s) failed.`)
    process.exit(1)
}
console.log('\nRemote sudo smoke checks passed.')
