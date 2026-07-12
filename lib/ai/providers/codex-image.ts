import { spawn } from 'child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import type { ImageGenOptions, ImageGenResult } from '@/lib/ai/agents/types'
import { codexCliEnv } from '@/lib/cli/codex-env'
import { resolveBin } from '@/lib/cli/resolve-bin'

const CODEX_IMAGE_TIMEOUT_MS = 10 * 60_000
const MAX_CODEX_IMAGES = 4

interface CodexImageRuntime {
    bin?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
}

interface PendingRequest {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
}

interface ImageGenerationItem {
    status?: string
    result?: string
    revisedPrompt?: string | null
    savedPath?: string | null
}

/** Generate images through the authenticated Codex CLI app-server route. */
export async function generateCodexImage(
    options: ImageGenOptions,
    runtime: CodexImageRuntime = {},
): Promise<ImageGenResult> {
    const workDir = await mkdtemp(path.join(tmpdir(), 'orchestrator-codex-image-'))
    try {
        const referencePaths = await writeReferenceImages(workDir, options.referenceImages ?? [])
        return await runCodexImageTurn(options, referencePaths, workDir, runtime)
    } finally {
        await rm(workDir, { recursive: true, force: true })
    }
}

async function runCodexImageTurn(
    options: ImageGenOptions,
    referencePaths: string[],
    workDir: string,
    runtime: CodexImageRuntime,
): Promise<ImageGenResult> {
    return new Promise<ImageGenResult>((resolve, reject) => {
        const bin = runtime.bin ?? resolveBin('codex')
        const imageItems: ImageGenerationItem[] = []
        const pending = new Map<number, PendingRequest>()
        let nextRequestId = 1
        let stdoutBuffer = ''
        let stderrTail = ''
        let latestUsage: unknown
        let settled = false

        let proc: ReturnType<typeof spawn>
        try {
            proc = spawn(bin, codexImageAppServerArgs(), {
                cwd: workDir,
                env: runtime.env ?? codexCliEnv(),
                stdio: ['pipe', 'pipe', 'pipe'],
            })
        } catch (error) {
            reject(new Error(`Failed to start Codex ImageGen: ${error instanceof Error ? error.message : String(error)}`))
            return
        }

        const stop = () => {
            try { proc.stdin?.end() } catch { /* already closed */ }
            try { proc.kill('SIGTERM') } catch { /* already gone */ }
            const killTimer = setTimeout(() => {
                try { proc.kill('SIGKILL') } catch { /* already gone */ }
            }, 1_500)
            killTimer.unref()
        }

        const cleanError = (error: Error): Error => {
            const detail = stderrTail.trim()
            return detail
                ? new Error(`${error.message} (${detail.slice(-800)})`)
                : error
        }

        const fail = (error: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            options.signal?.removeEventListener('abort', abort)
            for (const request of pending.values()) request.reject(error)
            pending.clear()
            stop()
            reject(cleanError(error))
        }

        const finish = async () => {
            if (settled) return
            try {
                const images = await materializeImageItems(imageItems, workDir)
                if (images.length === 0) {
                    const failure = imageItems.find(item => item.status === 'failed')
                    throw new Error(
                        typeof failure?.result === 'string' && failure.result.trim()
                            ? `Codex ImageGen failed: ${failure.result.trim()}`
                            : 'Codex ImageGen completed without returning an image.',
                    )
                }
                settled = true
                clearTimeout(timeout)
                options.signal?.removeEventListener('abort', abort)
                pending.clear()
                stop()
                resolve({ images, usage: latestUsage })
            } catch (error) {
                fail(error instanceof Error ? error : new Error('Failed to read Codex ImageGen output.'))
            }
        }

        const send = (message: Record<string, unknown>) => {
            if (!proc.stdin || proc.stdin.destroyed) throw new Error('Codex ImageGen stdin closed early.')
            proc.stdin.write(`${JSON.stringify(message)}\n`)
        }

        const request = (method: string, params: unknown): Promise<unknown> => {
            const id = nextRequestId++
            return new Promise((requestResolve, requestReject) => {
                pending.set(id, { resolve: requestResolve, reject: requestReject })
                try {
                    send({ id, method, params })
                } catch (error) {
                    pending.delete(id)
                    requestReject(error instanceof Error ? error : new Error(String(error)))
                }
            })
        }

        const respond = (id: unknown, result: unknown) => send({ id, result })
        const respondError = (id: unknown, message: string) => send({
            id,
            error: { code: -32601, message },
        })

        const handleLine = (line: string) => {
            let parsed: unknown
            try {
                parsed = JSON.parse(line)
            } catch {
                return
            }
            if (!parsed || typeof parsed !== 'object') return
            const message = parsed as Record<string, unknown>

            if (typeof message.id === 'number' && !message.method) {
                const waiting = pending.get(message.id)
                if (!waiting) return
                pending.delete(message.id)
                if (message.error && typeof message.error === 'object') {
                    const rawMessage = (message.error as Record<string, unknown>).message
                    waiting.reject(new Error(
                        typeof rawMessage === 'string' ? rawMessage : 'Codex app-server request failed.',
                    ))
                } else {
                    waiting.resolve(message.result)
                }
                return
            }

            if (typeof message.id === 'number' && typeof message.method === 'string') {
                if (
                    message.method === 'item/commandExecution/requestApproval'
                    || message.method === 'item/fileChange/requestApproval'
                ) {
                    respond(message.id, { decision: 'decline' })
                } else {
                    respondError(message.id, `Unsupported Codex ImageGen request: ${message.method}`)
                }
                return
            }

            if (typeof message.method !== 'string') return
            const params = message.params && typeof message.params === 'object'
                ? message.params as Record<string, unknown>
                : {}
            if (message.method === 'item/completed') {
                const item = params.item && typeof params.item === 'object'
                    ? params.item as Record<string, unknown>
                    : null
                if (item?.type === 'imageGeneration') {
                    imageItems.push({
                        status: typeof item.status === 'string' ? item.status : undefined,
                        result: typeof item.result === 'string' ? item.result : undefined,
                        revisedPrompt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt : null,
                        savedPath: typeof item.savedPath === 'string' ? item.savedPath : null,
                    })
                }
                return
            }
            if (message.method === 'thread/tokenUsage/updated') {
                latestUsage = params.tokenUsage ?? latestUsage
                return
            }
            if (message.method === 'turn/completed') {
                const turn = params.turn && typeof params.turn === 'object'
                    ? params.turn as Record<string, unknown>
                    : null
                if (turn?.status === 'failed') {
                    const rawError = turn.error && typeof turn.error === 'object'
                        ? (turn.error as Record<string, unknown>).message
                        : turn?.error
                    fail(new Error(
                        typeof rawError === 'string' ? rawError : 'Codex ImageGen turn failed.',
                    ))
                    return
                }
                void finish()
            }
        }

        const timeout = setTimeout(() => {
            fail(new Error(`Codex ImageGen timed out after ${runtime.timeoutMs ?? CODEX_IMAGE_TIMEOUT_MS}ms.`))
        }, runtime.timeoutMs ?? CODEX_IMAGE_TIMEOUT_MS)
        timeout.unref()

        const abort = () => fail(new Error('Codex ImageGen was aborted.'))
        if (options.signal?.aborted) {
            abort()
            return
        }
        options.signal?.addEventListener('abort', abort, { once: true })

        proc.stdin?.on('error', error => fail(new Error(`Codex ImageGen stdin failed: ${error.message}`)))
        proc.stdout?.setEncoding('utf8')
        proc.stderr?.setEncoding('utf8')
        proc.stdout?.on('data', chunk => {
            stdoutBuffer += chunk.toString()
            for (;;) {
                const newline = stdoutBuffer.indexOf('\n')
                if (newline < 0) break
                const line = stdoutBuffer.slice(0, newline).trim()
                stdoutBuffer = stdoutBuffer.slice(newline + 1)
                if (line) handleLine(line)
            }
        })
        proc.stderr?.on('data', chunk => {
            stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4_000)
        })
        proc.on('error', error => fail(new Error(`Codex ImageGen process failed: ${error.message}`)))
        proc.on('exit', (code, signal) => {
            if (settled) return
            fail(new Error(`Codex ImageGen exited early (${signal ?? code ?? 'unknown'}).`))
        })

        void (async () => {
            try {
                await request('initialize', {
                    clientInfo: {
                        name: 'orchestrator',
                        title: 'Orchestrator Image Generator',
                        version: '0.0.1',
                    },
                    capabilities: { experimentalApi: true },
                })
                send({ method: 'initialized', params: {} })

                const rawCapabilities = await request('modelProvider/capabilities/read', {})
                const capabilities = rawCapabilities && typeof rawCapabilities === 'object'
                    ? rawCapabilities as Record<string, unknown>
                    : {}
                if (capabilities.imageGeneration !== true) {
                    throw new Error('The installed or authenticated Codex CLI does not expose image generation.')
                }

                const rawThread = await request('thread/start', codexImageThreadParams(workDir))
                const thread = rawThread && typeof rawThread === 'object'
                    ? (rawThread as Record<string, unknown>).thread
                    : null
                const threadId = thread && typeof thread === 'object'
                    ? (thread as Record<string, unknown>).id
                    : null
                if (typeof threadId !== 'string' || !threadId) {
                    throw new Error('Codex ImageGen did not return a thread id.')
                }

                await request('turn/start', {
                    threadId,
                    input: [
                        { type: 'text', text: buildCodexImagePrompt(options), text_elements: [] },
                        ...referencePaths.map(referencePath => ({
                            type: 'localImage',
                            path: referencePath,
                            detail: 'original',
                        })),
                    ],
                })
            } catch (error) {
                fail(error instanceof Error ? error : new Error('Codex ImageGen setup failed.'))
            }
        })()
    })
}

function codexImageAppServerArgs(): string[] {
    return [
        'app-server',
        '--listen', 'stdio://',
        '-c', 'features.image_generation=true',
        '-c', 'features.shell_tool=false',
        '-c', 'features.multi_agent=false',
        '-c', 'features.apps=false',
        '-c', 'features.plugins=false',
        '-c', 'features.skills=false',
        '-c', 'web_search="disabled"',
    ]
}

function codexImageThreadParams(workDir: string): Record<string, unknown> {
    return {
        cwd: workDir,
        serviceName: 'orchestrator-image-generator',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        config: {
            features: {
                image_generation: true,
                shell_tool: false,
                multi_agent: false,
                apps: false,
                plugins: false,
                skills: false,
            },
            web_search: 'disabled',
        },
    }
}

function buildCodexImagePrompt(options: ImageGenOptions): string {
    const count = Math.max(1, Math.min(MAX_CODEX_IMAGES, Math.floor(options.n ?? 1)))
    const lines = [
        'Use the built-in image generation capability to create the requested image asset.',
        count === 1
            ? 'Generate exactly one image.'
            : `Generate exactly ${count} separate images, each returned as its own generated image asset.`,
        options.aspectRatio ? `Target aspect ratio: ${options.aspectRatio}.` : '',
        options.referenceImages?.length
            ? 'Use the attached reference image(s) exactly as described in the request.'
            : '',
        'Do not write implementation code or substitute a text description for the generated image.',
        '',
        options.prompt.trim(),
    ]
    return lines.filter((line, index) => line || index >= lines.length - 2).join('\n')
}

async function writeReferenceImages(
    workDir: string,
    images: NonNullable<ImageGenOptions['referenceImages']>,
): Promise<string[]> {
    const paths: string[] = []
    for (const [index, image] of images.entries()) {
        const referencePath = path.join(
            workDir,
            `reference-${index + 1}${extensionForMime(image.mimeType)}`,
        )
        await writeFile(referencePath, image.data)
        paths.push(referencePath)
    }
    return paths
}

async function materializeImageItems(
    items: ImageGenerationItem[],
    workDir: string,
): Promise<ImageGenResult['images']> {
    const images: ImageGenResult['images'] = []
    for (const item of items) {
        if (item.status === 'failed') continue
        const materialized = await materializeImageItem(item, workDir)
        if (materialized) images.push(materialized)
    }
    return images
}

async function materializeImageItem(
    item: ImageGenerationItem,
    workDir: string,
): Promise<ImageGenResult['images'][number] | null> {
    const candidatePath = item.savedPath
        ?? (item.result && !item.result.startsWith('data:') ? item.result : null)
    if (candidatePath) {
        const absolutePath = path.isAbsolute(candidatePath)
            ? candidatePath
            : path.resolve(workDir, candidatePath)
        if (await isPathInside(workDir, absolutePath)) {
            try {
                const data = await readFile(absolutePath)
                return {
                    data,
                    mimeType: mimeForImage(data, absolutePath),
                    revisedPrompt: item.revisedPrompt?.trim() || undefined,
                }
            } catch {
                // Some app-server versions return inline data in `result`;
                // fall through before declaring no output.
            }
        }
    }

    const inline = parseInlineImage(item.result)
    if (!inline) return null
    return {
        ...inline,
        revisedPrompt: item.revisedPrompt?.trim() || undefined,
    }
}

async function isPathInside(root: string, candidate: string): Promise<boolean> {
    try {
        const [canonicalRoot, canonicalCandidate] = await Promise.all([
            realpath(root),
            realpath(candidate),
        ])
        const relative = path.relative(canonicalRoot, canonicalCandidate)
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    } catch {
        return false
    }
}

function parseInlineImage(result: string | undefined): { data: Buffer; mimeType: string } | null {
    if (!result?.trim()) return null
    const trimmed = result.trim()
    const dataUrl = trimmed.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i)
    const encoded = dataUrl ? dataUrl[2] : trimmed
    if (!dataUrl && !/^[a-z0-9+/=\s]{128,}$/i.test(encoded)) return null
    try {
        const data = Buffer.from(encoded.replace(/\s+/g, ''), 'base64')
        if (data.length === 0) return null
        return {
            data,
            mimeType: dataUrl?.[1] ?? mimeForImage(data),
        }
    } catch {
        return null
    }
}

function mimeForImage(data: Buffer, filePath?: string): string {
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return 'image/png'
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg'
    }
    if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp'
    }
    const extension = filePath ? path.extname(filePath).toLowerCase() : ''
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
    if (extension === '.webp') return 'image/webp'
    return 'image/png'
}

function extensionForMime(mimeType: string): string {
    if (mimeType === 'image/jpeg') return '.jpg'
    if (mimeType === 'image/webp') return '.webp'
    return '.png'
}

export const codexImageTestHooks = {
    buildCodexImagePrompt,
    codexImageAppServerArgs,
    codexImageThreadParams,
    parseInlineImage,
}
