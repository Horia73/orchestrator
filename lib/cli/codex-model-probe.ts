/**
 * Codex CLI model discovery through the app-server protocol.
 *
 * Codex does not expose a top-level `--list-models` command, but app-server
 * exposes the account-aware `model/list` request used by first-party clients.
 * Querying that surface keeps Orchestrator's picker aligned with both the
 * installed CLI version and the models currently enabled for the signed-in
 * account, without hardcoding each new model family in seed.json.
 */
import { spawn } from 'child_process'
import { z } from 'zod'

import { activeRuntimePaths } from '@/lib/runtime-paths'
import type { LiveModelEntry } from '@/lib/models/schema'
import { codexCliEnv } from './codex-env'
import { resolveBin } from './resolve-bin'

const PROBE_TIMEOUT_MS = 20_000
const MODEL_PAGE_SIZE = 100
const STABLE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/

const CodexReasoningEffortSchema = z.object({
    reasoningEffort: z.string().min(1),
    description: z.string().optional(),
}).passthrough()

const CodexListedModelSchema = z.object({
    id: z.string().min(1),
    model: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().optional(),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    supportedReasoningEfforts: z.array(CodexReasoningEffortSchema),
    defaultReasoningEffort: z.string().min(1),
    inputModalities: z.array(z.string()).optional(),
}).passthrough()

const CodexModelListResponseSchema = z.object({
    data: z.array(CodexListedModelSchema),
    nextCursor: z.string().nullable().optional(),
}).passthrough()

export type CodexListedModel = z.infer<typeof CodexListedModelSchema>

interface PendingRequest {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
}

/** Ask the installed, authenticated Codex CLI for every visible picker model. */
export async function probeCodexModels(): Promise<CodexListedModel[]> {
    return new Promise<CodexListedModel[]>((resolve, reject) => {
        const bin = resolveBin('codex')
        if (bin === 'codex') {
            reject(new Error('Codex CLI is not installed.'))
            return
        }

        let proc: ReturnType<typeof spawn>
        try {
            proc = spawn(bin, [
                'app-server',
                '--listen', 'stdio://',
                '-c', 'features.multi_agent=false',
                '-c', 'features.apps=false',
                '-c', 'features.plugins=false',
                '-c', 'features.skills=false',
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: codexCliEnv(),
                cwd: activeRuntimePaths().agentWorkspaceDir,
            })
        } catch (error) {
            reject(new Error(`Failed to spawn Codex CLI: ${error instanceof Error ? error.message : String(error)}`))
            return
        }

        let settled = false
        let nextRequestId = 1
        let stdoutBuffer = ''
        let stderrTail = ''
        const pending = new Map<number, PendingRequest>()

        const stop = () => {
            try { proc.stdin?.end() } catch { /* already closed */ }
            try { proc.kill('SIGTERM') } catch { /* already gone */ }
            const killTimer = setTimeout(() => {
                try { proc.kill('SIGKILL') } catch { /* already gone */ }
            }, 1_000)
            killTimer.unref()
        }

        const finish = (models: CodexListedModel[]) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            pending.clear()
            stop()
            resolve(models)
        }

        const fail = (error: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            for (const request of pending.values()) request.reject(error)
            pending.clear()
            stop()
            const detail = stderrTail.trim()
            reject(detail ? new Error(`${error.message} (${detail.slice(-600)})`) : error)
        }

        const send = (message: Record<string, unknown>) => {
            if (!proc.stdin || proc.stdin.destroyed) throw new Error('Codex app-server stdin closed early.')
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

        const handleLine = (line: string) => {
            let message: unknown
            try {
                message = JSON.parse(line)
            } catch {
                return
            }
            if (!message || typeof message !== 'object') return
            const record = message as Record<string, unknown>
            if (typeof record.id !== 'number') return
            const waiting = pending.get(record.id)
            if (!waiting) return
            pending.delete(record.id)

            if (record.error && typeof record.error === 'object') {
                const rawMessage = (record.error as Record<string, unknown>).message
                waiting.reject(new Error(typeof rawMessage === 'string' ? rawMessage : 'Codex app-server request failed.'))
                return
            }
            waiting.resolve(record.result)
        }

        const timeout = setTimeout(() => {
            fail(new Error(`Codex model/list timed out after ${PROBE_TIMEOUT_MS}ms.`))
        }, PROBE_TIMEOUT_MS)

        proc.stdout?.setEncoding('utf8')
        proc.stderr?.setEncoding('utf8')
        proc.stdin?.on('error', error => fail(new Error(`Codex app-server stdin failed: ${error.message}`)))
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
            stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2_000)
        })
        proc.on('error', error => fail(new Error(`Codex app-server failed: ${error.message}`)))
        proc.on('exit', (code, signal) => {
            if (settled) return
            fail(new Error(`Codex app-server exited before model/list completed (${signal ?? code ?? 'unknown'}).`))
        })

        void (async () => {
            try {
                await request('initialize', {
                    clientInfo: { name: 'orchestrator', title: 'Orchestrator', version: '0.0.1' },
                    capabilities: { experimentalApi: true },
                })
                send({ method: 'initialized' })

                const models: CodexListedModel[] = []
                let cursor: string | null | undefined
                do {
                    const raw = await request('model/list', {
                        includeHidden: false,
                        limit: MODEL_PAGE_SIZE,
                        ...(cursor ? { cursor } : {}),
                    })
                    const page = CodexModelListResponseSchema.parse(raw)
                    models.push(...page.data)
                    cursor = page.nextCursor
                } while (cursor)

                finish(models)
            } catch (error) {
                fail(error instanceof Error ? error : new Error('Codex model/list failed.'))
            }
        })()
    })
}

/** Convert app-server model metadata into Orchestrator's live registry layer. */
export function codexModelsToLiveEntries(models: CodexListedModel[]): Record<string, LiveModelEntry> {
    const entries: Record<string, LiveModelEntry> = {}

    for (const model of models) {
        if (model.hidden) continue
        const modelId = model.model.trim()
        if (!modelId || entries[modelId]) continue

        const thinkingLevels = [...new Set(
            model.supportedReasoningEfforts
                .map(option => option.reasoningEffort.trim())
                .filter(level => STABLE_ID_RE.test(level))
        )]
        const defaultThinkingLevel = thinkingLevels.includes(model.defaultReasoningEffort)
            ? model.defaultReasoningEffort
            : undefined

        entries[modelId] = {
            name: model.displayName.trim() || modelId,
            kinds: ['text'],
            pricing: { kind: 'subscription' },
            capabilities: ['text', 'function_calling'],
            thinkingSupported: thinkingLevels.length > 0,
            ...(thinkingLevels.length > 0 ? { thinkingLevels } : {}),
            ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
            rawDescription: model.description?.trim() || 'Discovered from Codex CLI model/list.',
            raw: {
                codexModelId: model.id,
                isDefault: model.isDefault,
                inputModalities: model.inputModalities ?? [],
            },
        }
    }

    return entries
}
