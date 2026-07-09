import { spawn } from 'child_process'
import path from 'path'

export interface FilesystemRetentionProcessResult {
    ok: boolean
    exitCode: number | null
    output: string
}

const MAX_CAPTURE_CHARS = 24_000

/**
 * Run filesystem cleanup outside the Next.js process. Walking/removing old
 * dependency trees can be I/O-heavy; a child keeps the scheduler and chat
 * event loop responsive while the maintenance command uses its own lock.
 */
export function runFilesystemRetentionProcess(): Promise<FilesystemRetentionProcessResult> {
    const projectDir = process.cwd()
    const executable = process.platform === 'win32'
        ? path.join(projectDir, 'node_modules', '.bin', 'tsx.cmd')
        : path.join(projectDir, 'node_modules', '.bin', 'tsx')
    const child = spawn(executable, ['scripts/storage-maintenance.ts', '--apply', '--summary'], {
        cwd: projectDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    const capture = (chunk: Buffer | string) => {
        output += chunk.toString()
        if (output.length > MAX_CAPTURE_CHARS) output = output.slice(-MAX_CAPTURE_CHARS)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    return new Promise(resolve => {
        child.once('error', error => resolve({
            ok: false,
            exitCode: null,
            output: `${output}\n${error.message}`.trim(),
        }))
        child.once('close', code => resolve({
            ok: code === 0,
            exitCode: code,
            output: output.trim(),
        }))
    })
}
