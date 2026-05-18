// Loaded first by server.ts — before any other import — because it has to
// run before the SDK / app code can dirty stdout or read process.cwd().
//
// Responsibilities:
//   1. Set cwd to the project root (lib/config.ts derives .orchestrator/
//      from process.cwd(); the MCP launcher may spawn us from elsewhere).
//   2. Load .env / .env.local into process.env (Next.js does this for us
//      normally; standalone we have to do it ourselves).
//   3. Redirect console.* to stderr. MCP's stdio transport owns stdout —
//      a stray console.log corrupts the JSON-RPC stream.
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..')
process.chdir(PROJECT_ROOT)

function formatArgs(args: unknown[]): string {
    return args
        .map(a => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)))
        .join(' ')
}

const stderrConsole = (prefix: string) =>
    ((...args: unknown[]) => {
        process.stderr.write(`[${prefix}] ${formatArgs(args)}\n`)
    }) as (...args: unknown[]) => void

console.log = stderrConsole('log') as typeof console.log
console.info = stderrConsole('info') as typeof console.info
console.warn = stderrConsole('warn') as typeof console.warn
console.error = stderrConsole('error') as typeof console.error
console.debug = stderrConsole('debug') as typeof console.debug

function loadEnvFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return
    const content = fs.readFileSync(filePath, 'utf-8')
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq === -1) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }
        if (!(key in process.env)) {
            process.env[key] = value
        }
    }
}
loadEnvFile(path.join(PROJECT_ROOT, '.env'))
loadEnvFile(path.join(PROJECT_ROOT, '.env.local'))

export { PROJECT_ROOT }
