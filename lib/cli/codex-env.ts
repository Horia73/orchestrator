import fs from 'fs'
import os from 'os'
import path from 'path'

import { PRIVATE_STATE_DIR } from '@/lib/config'
import { augmentedEnv } from './resolve-bin'

const RUNTIME_HOME = path.join(PRIVATE_STATE_DIR, 'codex-runtime-home')
const RUNTIME_CODEX_HOME = path.join(RUNTIME_HOME, '.codex')
const RUNTIME_CONFIG_PATH = path.join(RUNTIME_CODEX_HOME, 'config.toml')

const SANITIZED_CONFIG = [
    '# Managed by Orchestrator.',
    '# Keep Codex app-server isolated from user MCP config that may differ by CLI version.',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[features]',
    'multi_agent = false',
    'apps = false',
    '',
].join('\n')

export function codexCliEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const runtimeHome = prepareCodexRuntimeHome()
    return {
        ...augmentedEnv(extra),
        HOME: runtimeHome,
        CODEX_HOME: path.join(runtimeHome, '.codex'),
    }
}

export function prepareCodexRuntimeHome(): string {
    fs.mkdirSync(RUNTIME_CODEX_HOME, { recursive: true })
    writeSanitizedConfig()
    syncAuthFile()
    return RUNTIME_HOME
}

function writeSanitizedConfig(): void {
    try {
        const existing = fs.existsSync(RUNTIME_CONFIG_PATH)
            ? fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8')
            : null
        if (existing !== SANITIZED_CONFIG) {
            fs.writeFileSync(RUNTIME_CONFIG_PATH, SANITIZED_CONFIG, { encoding: 'utf-8', mode: 0o600 })
        }
    } catch {
        // Let Codex surface a concrete auth/config error if the runtime home is not writable.
    }
}

function syncAuthFile(): void {
    const source = path.join(os.homedir(), '.codex', 'auth.json')
    const target = path.join(RUNTIME_CODEX_HOME, 'auth.json')
    if (source === target || !fs.existsSync(source)) return

    try {
        const sourceStat = fs.statSync(source)
        const targetStat = fs.existsSync(target) ? fs.statSync(target) : null
        if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) return
        fs.copyFileSync(source, target)
        fs.chmodSync(target, 0o600)
    } catch {
        // Best effort. Device auth through Orchestrator writes directly into the runtime home.
    }
}
