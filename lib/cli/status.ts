import { spawn } from 'child_process'

import { CLI_IDS, CLI_SPECS, type CliId, type CliStatus } from './specs'
import { resolveBin, augmentedEnv } from './resolve-bin'

const STATUS_TIMEOUT_MS = 8000

/**
 * Return whether `bin` is reachable on PATH. We don't use `which`/`where`
 * because behaviour differs across platforms — a one-shot `--version` is
 * cheap and uniform; ENOENT means missing.
 */
async function isInstalled(bin: string): Promise<boolean> {
    return new Promise(resolve => {
        const resolved = resolveBin(bin)
        const proc = spawn(resolved, ['--version'], {
            stdio: ['ignore', 'ignore', 'ignore'],
            env: augmentedEnv(),
        })
        const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false) }, 3000)
        proc.on('error', () => { clearTimeout(timer); resolve(false) })
        proc.on('exit', code => { clearTimeout(timer); resolve(code === 0) })
    })
}

/**
 * Run the configured `statusArgs` for a CLI and parse the output. Times out
 * after STATUS_TIMEOUT_MS to avoid blocking the settings page if a CLI hangs.
 */
async function runStatus(id: CliId): Promise<CliStatus> {
    const spec = CLI_SPECS[id]

    if (!await isInstalled(spec.bin)) {
        return { installed: false, loggedIn: false }
    }

    return new Promise<CliStatus>(resolve => {
        const resolvedBin = resolveBin(spec.bin)
        const proc = spawn(resolvedBin, spec.statusArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: augmentedEnv(),
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
            proc.kill('SIGKILL')
            resolve({ installed: true, loggedIn: false, detail: 'status check timed out', raw: stdout })
        }, STATUS_TIMEOUT_MS)

        proc.stdout.on('data', chunk => { stdout += chunk.toString() })
        proc.stderr.on('data', chunk => { stderr += chunk.toString() })
        proc.on('error', err => {
            clearTimeout(timer)
            resolve({ installed: false, loggedIn: false, detail: err.message })
        })
        proc.on('exit', code => {
            clearTimeout(timer)
            try {
                resolve(spec.parseStatus(stdout, stderr, code ?? 0))
            } catch (err) {
                resolve({
                    installed: true,
                    loggedIn: false,
                    detail: err instanceof Error ? err.message : 'parse failed',
                    raw: stdout,
                })
            }
        })
    })
}

/** Status snapshot for all configured CLIs. Used by /api/cli/status. */
export async function getAllCliStatuses(): Promise<Record<CliId, CliStatus>> {
    const entries = await Promise.all(
        CLI_IDS.map(async id => [id, await runStatus(id)] as const)
    )
    const result = {} as Record<CliId, CliStatus>
    for (const [id, status] of entries) {
        result[id] = status
    }
    return result
}
