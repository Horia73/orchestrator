/**
 * Codex CLI vision backend (GPT-5.5 via `codex app-server`).
 *
 * Architecture: ONE long-lived app-server process per vision-service instance
 * (= per browser session), spawned lazily and killed on dispose. Each
 * analyzeScreenshot/reflectOnIterationLimit call starts a FRESH unpersisted
 * thread and runs exactly one turn on it, sending the full context (system
 * prompt as developerInstructions, history + frames as input items) — the same
 * stateless-per-call semantics as the Gemini backend, which keeps escalation
 * and interrupts working unchanged and gives the pro model a fresh context.
 *
 * The model grounds natively in screenshot pixels, so this backend prompts in
 * the 'pixel-viewport' coordinate space; agent.ts skips 0-1000 denormalization
 * for it. The final assistant message is constrained with a strict-safe
 * `outputSchema`; if the installed codex rejects the schema we fall back to
 * prompt-only JSON plus the shared parse-with-retries loop.
 *
 * All codex native tools are disabled (shell, web search, apps, plugins,
 * skills, multi-agent) and no dynamic tools are registered: the model can only
 * answer with the action JSON.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { CLI_SPECS } from '@/lib/cli/specs';
import { resolveBin } from '@/lib/cli/resolve-bin';
import { codexCliEnv, prepareCodexRuntimeHome } from '@/lib/cli/codex-env';
import { activeRuntimePaths } from '@/lib/runtime-paths';
import { ActionTrace, BrowserDownloadFile, BrowserFrameSnapshot } from './browser';
import { buildSystemPrompt, buildMemoryContext, buildActionPrompt, buildInterruptPrompt, buildIterationLimitReviewPrompt, ActionHistoryItem, TabInfo, IterationLimitReview } from './prompts';
import { getMemories } from './memory';
import {
    AgentAction,
    COORDINATE_JSON_SCHEMA,
    ITERATION_LIMIT_REVIEW_JSON_SCHEMA,
    ModelOutputParseError,
    VALID_ACTIONS,
    VisionConfig,
    VisionGenerateResponse,
    VisionRequestPart,
    VisionService,
    VisionUsage,
    buildVisionParts,
    normalizeStringArray,
    parseAgentActionsFromModelText,
    parseIterationLimitReviewFromModelText,
    requestParsedJsonWithRetries,
    sanitizeMediaResolution,
    sanitizeThinkingLevel,
} from './vision-shared';

type AnyObj = Record<string, unknown>;

const JSON_RPC_REQUEST_TIMEOUT_MS = 60_000;
const STALE_FRAME_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CODEX_VISION_MODEL = 'gpt-5.5';

// ---------------------------------------------------------------------------
// Strict-safe output schemas (root object, additionalProperties:false,
// all-required with nullable optionals, no Gemini propertyOrdering).
// ---------------------------------------------------------------------------

const NULLABLE_COORDINATE_SCHEMA = {
    ...COORDINATE_JSON_SCHEMA,
    type: ['array', 'null'],
} as const;

const CODEX_ACTION_ITEM_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        action: { type: 'string', enum: [...VALID_ACTIONS] },
        sub_objective: { type: ['string', 'null'] },
        coordinate: NULLABLE_COORDINATE_SCHEMA,
        coordinateEnd: NULLABLE_COORDINATE_SCHEMA,
        text: { type: ['string', 'null'] },
        submit: { type: ['boolean', 'null'] },
        clearBefore: { type: ['boolean', 'null'] },
        clickCount: { type: ['integer', 'null'], minimum: 1 },
        key: { type: ['string', 'null'], enum: ['Enter', 'Escape', 'Tab', 'Backspace', null] },
        scrollDirection: { type: ['string', 'null'], enum: ['up', 'down', 'left', 'right', null] },
        scrollAmount: { type: ['integer', 'null'], minimum: 1 },
        url: { type: ['string', 'null'] },
        tabIndex: { type: ['integer', 'null'], minimum: 0 },
        reasoning: { type: 'string' },
        memory: { type: ['string', 'null'] },
        durationMs: { type: ['integer', 'null'], minimum: 1 },
        expectedFilename: { type: ['string', 'null'] },
    },
    required: [
        'action',
        'sub_objective',
        'coordinate',
        'coordinateEnd',
        'text',
        'submit',
        'clearBefore',
        'clickCount',
        'key',
        'scrollDirection',
        'scrollAmount',
        'url',
        'tabIndex',
        'reasoning',
        'memory',
        'durationMs',
        'expectedFilename',
    ],
} as const;

/**
 * A top-level anyOf(single|array) is not representable in strict mode, so the
 * batch is wrapped as { actions: [...] }; the shared parser unwraps it.
 */
export const CODEX_ACTION_RESPONSE_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        actions: {
            type: 'array',
            items: CODEX_ACTION_ITEM_SCHEMA,
            minItems: 1,
            maxItems: 8,
        },
    },
    required: ['actions'],
} as const;

export const CODEX_ITERATION_REVIEW_OUTPUT_SCHEMA = (() => {
    const { propertyOrdering: _ignored, ...rest } = ITERATION_LIMIT_REVIEW_JSON_SCHEMA as AnyObj & { propertyOrdering?: unknown };
    void _ignored;
    return rest;
})();

export function mapEffortForCodex(level: string | undefined): string | null {
    switch (level) {
        case 'minimal': return 'low';
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
            return level;
        case 'max': return 'xhigh';
        default:
            return level ?? null;
    }
}

function turnTimeoutForEffort(effort: string | null): number {
    switch (effort) {
        case 'xhigh': return 600_000;
        case 'high': return 300_000;
        default: return 120_000;
    }
}

function isSchemaRejectionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(output[_\s-]?schema|outputSchema)/i.test(message)
        || (/schema/i.test(message) && /(invalid|unsupported|unknown|not supported|unexpected|failed)/i.test(message));
}

class ProcessDiedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProcessDiedError';
    }
}

interface RunTurnArgs {
    developerInstructions?: string;
    items: AnyObj[];
    outputSchema?: unknown;
    model: string;
    effort: string | null;
}

interface RunTurnResult {
    text: string;
    usage: Omit<VisionUsage, 'model'> | null;
}

// ---------------------------------------------------------------------------
// Long-lived app-server client
// ---------------------------------------------------------------------------

class CodexAppServerClient {
    private proc: ReturnType<typeof spawn> | null = null;
    private initialized = false;
    private disposed = false;
    private nextRequestId = 1;
    private stdoutBuf = '';
    private stderrBuf = '';
    private readonly diagnostics: string[] = [];
    private pending = new Map<number, {
        method: string;
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    /** Serializes turns; vision calls are sequential but this is a safety net. */
    private turnChain: Promise<unknown> = Promise.resolve();
    private activeTurn: {
        threadId: string;
        turnId?: string;
        interrupted: boolean;
    } | null = null;
    private outputSchemaUnsupported = false;

    constructor(private readonly framesDir: string) {}

    private rememberDiagnostic(text: string) {
        const trimmed = text.trim();
        if (!trimmed) return;
        this.diagnostics.push(trimmed);
        if (this.diagnostics.length > 20) this.diagnostics.shift();
    }

    private diagnosticsSuffix(): string {
        return this.diagnostics.length ? `: ${this.diagnostics.slice(-3).join(' | ')}` : '';
    }

    private send(msg: AnyObj) {
        const stdin = this.proc?.stdin;
        if (!stdin || stdin.destroyed) return;
        stdin.write(`${JSON.stringify(msg)}\n`);
    }

    private request(method: string, params: unknown, timeoutMs = JSON_RPC_REQUEST_TIMEOUT_MS): Promise<unknown> {
        const id = this.nextRequestId++;
        this.send({ method, id, params });
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
        });
    }

    private respond(id: unknown, result: unknown) {
        if (typeof id !== 'number') return;
        this.send({ id, result });
    }

    private respondError(id: unknown, message: string, code = -32603) {
        if (typeof id !== 'number') return;
        this.send({ id, error: { code, message } });
    }

    private failPending(error: Error) {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }

    private markDead(reason: string) {
        if (!this.proc) return;
        this.proc = null;
        this.initialized = false;
        this.failPending(new ProcessDiedError(reason));
        this.turnEvents?.reject(new ProcessDiedError(reason));
    }

    /** Per-turn notification collector; only one turn runs at a time. */
    private turnEvents: {
        threadId: string;
        agentMessageDeltas: Map<string, string>;
        completedMessages: string[];
        usage: Omit<VisionUsage, 'model'> | null;
        resolve: (status: { status: string; errorMessage?: string }) => void;
        reject: (err: Error) => void;
    } | null = null;

    private async ensureProcess(): Promise<void> {
        if (this.disposed) {
            throw new Error('codex vision client is disposed');
        }
        if (this.proc && this.initialized) return;

        prepareCodexRuntimeHome();
        fs.mkdirSync(this.framesDir, { recursive: true });

        const bin = resolveBin(CLI_SPECS.codex.bin);
        const args = [
            'app-server', '--listen', 'stdio://',
            '-c', 'features.shell_tool=false',
            '-c', 'features.multi_agent=false',
            '-c', 'features.apps=false',
            '-c', 'features.plugins=false',
            '-c', 'features.skills=false',
            '-c', 'apps._default.enabled=false',
            '-c', 'web_search="disabled"',
        ];

        const proc = spawn(bin, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: codexCliEnv(),
            cwd: this.framesDir,
        });
        this.proc = proc;
        this.stdoutBuf = '';
        this.stderrBuf = '';

        proc.stdout?.setEncoding('utf8');
        proc.stderr?.setEncoding('utf8');
        proc.stdin?.on('error', err => this.rememberDiagnostic(`stdin write failed: ${err.message}`));

        proc.stdout?.on('data', chunk => {
            this.stdoutBuf += chunk.toString();
            for (;;) {
                const idx = this.stdoutBuf.indexOf('\n');
                if (idx < 0) break;
                const line = this.stdoutBuf.slice(0, idx).trim();
                this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
                if (!line) continue;
                let msg: AnyObj;
                try {
                    msg = JSON.parse(line) as AnyObj;
                } catch {
                    this.rememberDiagnostic(line);
                    continue;
                }
                try {
                    this.handleMessage(msg);
                } catch (err) {
                    this.rememberDiagnostic(`message handling failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        });

        proc.stderr?.on('data', chunk => {
            this.stderrBuf += chunk.toString();
            for (;;) {
                const idx = this.stderrBuf.indexOf('\n');
                if (idx < 0) break;
                const line = this.stderrBuf.slice(0, idx).trim();
                this.stderrBuf = this.stderrBuf.slice(idx + 1);
                if (line) this.rememberDiagnostic(line);
            }
        });

        proc.on('error', err => {
            this.markDead(`codex app-server failed to start: ${err.message}`);
        });

        proc.on('exit', code => {
            this.markDead(`codex app-server exited with code ${code ?? 'null'}${this.diagnosticsSuffix()}`);
        });

        try {
            await this.request('initialize', {
                clientInfo: { name: 'orchestrator', title: 'Orchestrator Browser Agent', version: '0.0.1' },
                capabilities: { experimentalApi: true },
            });
            this.initialized = true;
        } catch (err) {
            this.killProcess();
            throw err instanceof Error ? err : new Error('codex app-server initialize failed');
        }
    }

    private handleMessage(msg: AnyObj) {
        if (typeof msg.id === 'number' && !msg.method) {
            const pendingRequest = this.pending.get(msg.id);
            if (!pendingRequest) return;
            this.pending.delete(msg.id);
            clearTimeout(pendingRequest.timer);
            if (msg.error) {
                const errObj = msg.error as AnyObj;
                const message = typeof errObj.message === 'string' ? errObj.message : JSON.stringify(msg.error);
                pendingRequest.reject(new Error(message));
            } else {
                pendingRequest.resolve(msg.result);
            }
            return;
        }

        if (typeof msg.id === 'number' && typeof msg.method === 'string') {
            // No dynamic tools are registered and approvals are policy 'never';
            // decline anything that still asks.
            if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'item/fileChange/requestApproval') {
                this.respond(msg.id, { decision: 'decline' });
                return;
            }
            this.respondError(msg.id, `Unsupported codex app-server request: ${msg.method}`, -32601);
            return;
        }

        if (typeof msg.method === 'string') {
            this.handleNotification(msg.method, msg.params as AnyObj | undefined);
        }
    }

    private handleNotification(method: string, params?: AnyObj) {
        const events = this.turnEvents;
        switch (method) {
            case 'turn/started': {
                const turn = params?.turn as AnyObj | undefined;
                if (this.activeTurn && typeof turn?.id === 'string') {
                    this.activeTurn.turnId = turn.id;
                }
                return;
            }
            case 'item/agentMessage/delta': {
                if (!events) return;
                const itemId = typeof params?.itemId === 'string' ? params.itemId : 'item';
                const delta = typeof params?.delta === 'string' ? params.delta : '';
                if (!delta) return;
                events.agentMessageDeltas.set(itemId, (events.agentMessageDeltas.get(itemId) ?? '') + delta);
                return;
            }
            case 'item/completed': {
                if (!events) return;
                const item = params?.item as AnyObj | undefined;
                if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
                    events.completedMessages.push(item.text);
                    if (typeof item.id === 'string') events.agentMessageDeltas.delete(item.id);
                }
                return;
            }
            case 'thread/tokenUsage/updated': {
                if (!events) return;
                const tokenUsage = params?.tokenUsage as AnyObj | undefined;
                const raw = (tokenUsage?.last ?? tokenUsage?.total ?? tokenUsage) as AnyObj | undefined;
                if (raw && typeof raw === 'object') {
                    const promptTokens = Number(raw.inputTokens) || 0;
                    const outputTokens = Number(raw.outputTokens) || 0;
                    const thoughtsTokens = Number(raw.reasoningOutputTokens) || 0;
                    const totalTokens = Number(raw.totalTokens) || (promptTokens + outputTokens + thoughtsTokens);
                    events.usage = { promptTokens, outputTokens, thoughtsTokens, totalTokens };
                }
                return;
            }
            case 'error': {
                const error = params?.error as AnyObj | undefined;
                const message = typeof error?.message === 'string'
                    ? error.message
                    : typeof params?.message === 'string'
                        ? params.message
                        : 'codex app-server error';
                this.rememberDiagnostic(message);
                events?.reject(new Error(message));
                return;
            }
            case 'turn/completed': {
                if (!events) return;
                const turn = params?.turn as AnyObj | undefined;
                const status = typeof turn?.status === 'string' ? turn.status : 'completed';
                const err = turn?.error as AnyObj | undefined;
                events.resolve({
                    status,
                    errorMessage: typeof err?.message === 'string' ? err.message : undefined,
                });
                return;
            }
            default:
                return;
        }
    }

    /** Runs one turn on a fresh, unpersisted thread. Serialized via turnChain. */
    runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
        const run = this.turnChain.then(() => this.runTurnWithRespawn(args), () => this.runTurnWithRespawn(args));
        this.turnChain = run.catch(() => undefined);
        return run;
    }

    private async runTurnWithRespawn(args: RunTurnArgs): Promise<RunTurnResult> {
        try {
            return await this.runTurnOnce(args);
        } catch (error) {
            // Fresh-thread turns are idempotent: retry once, transparently, on
            // process-level failures only (crash, EPIPE, failed spawn).
            if (error instanceof ProcessDiedError && !this.disposed) {
                console.warn(`[browser-agent][codex] app-server died mid-turn (${error.message}); respawning and retrying once`);
                return await this.runTurnOnce(args);
            }
            throw error;
        }
    }

    private async runTurnOnce(args: RunTurnArgs): Promise<RunTurnResult> {
        await this.ensureProcess();

        const threadResult = await this.request('thread/start', {
            cwd: this.framesDir,
            serviceName: 'orchestrator',
            experimentalRawEvents: false,
            // Vision threads are single-turn and never resumed; don't persist
            // rollout files for them.
            persistExtendedHistory: false,
            ...(args.model ? { model: args.model } : {}),
            ...(args.developerInstructions ? { developerInstructions: args.developerInstructions } : {}),
            approvalPolicy: 'never',
            sandbox: 'read-only',
            config: {
                features: {
                    shell_tool: false,
                    multi_agent: false,
                    apps: false,
                    plugins: false,
                    skills: false,
                },
                apps: {
                    _default: { enabled: false },
                },
                web_search: 'disabled',
            },
        }) as AnyObj;

        const thread = threadResult?.thread as AnyObj | undefined;
        const threadId = typeof thread?.id === 'string' ? thread.id : '';
        if (!threadId) {
            throw new Error('codex app-server did not return a thread id');
        }

        const timeoutMs = turnTimeoutForEffort(args.effort);
        this.activeTurn = { threadId, interrupted: false };

        const completion = new Promise<{ status: string; errorMessage?: string }>((resolve, reject) => {
            this.turnEvents = {
                threadId,
                agentMessageDeltas: new Map(),
                completedMessages: [],
                usage: null,
                resolve,
                reject,
            };
        });
        const events = this.turnEvents!;

        let timedOut = false;
        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            this.interruptActiveTurn();
            // Grace period for turn/completed after the interrupt; then recycle.
            setTimeout(() => {
                if (this.turnEvents === events) {
                    this.killProcess();
                    this.markDead(`codex turn timed out after ${timeoutMs}ms`);
                }
            }, 5_000);
        }, timeoutMs);

        try {
            const turnParams: AnyObj = {
                threadId,
                input: args.items,
                ...(args.model ? { model: args.model } : {}),
                ...(args.effort ? { effort: args.effort } : {}),
            };
            if (args.outputSchema && !this.outputSchemaUnsupported) {
                turnParams.outputSchema = args.outputSchema;
            }

            try {
                const turnResult = await this.request('turn/start', turnParams) as AnyObj;
                const turn = turnResult?.turn as AnyObj | undefined;
                if (this.activeTurn && typeof turn?.id === 'string') {
                    this.activeTurn.turnId = turn.id;
                }
            } catch (error) {
                if (turnParams.outputSchema && isSchemaRejectionError(error)) {
                    this.outputSchemaUnsupported = true;
                    console.warn(`[browser-agent][codex] turn/start rejected outputSchema; falling back to prompt-only JSON for this session. ${error instanceof Error ? error.message : ''}`);
                    delete turnParams.outputSchema;
                    const turnResult = await this.request('turn/start', turnParams) as AnyObj;
                    const turn = turnResult?.turn as AnyObj | undefined;
                    if (this.activeTurn && typeof turn?.id === 'string') {
                        this.activeTurn.turnId = turn.id;
                    }
                } else {
                    throw error;
                }
            }

            const outcome = await completion;
            if (timedOut) {
                throw new Error(`codex turn timed out after ${timeoutMs}ms`);
            }
            if (this.activeTurn?.interrupted) {
                throw new Error('codex turn was cancelled');
            }
            if (outcome.status === 'failed') {
                throw new Error(outcome.errorMessage || 'codex turn failed');
            }
            if (outcome.status === 'interrupted') {
                throw new Error('codex turn was interrupted');
            }

            const text = events.completedMessages.length > 0
                ? events.completedMessages.join('\n')
                : [...events.agentMessageDeltas.values()].join('\n');

            return { text, usage: events.usage };
        } finally {
            clearTimeout(timeoutTimer);
            if (this.turnEvents === events) this.turnEvents = null;
            this.activeTurn = null;
        }
    }

    private interruptActiveTurn() {
        const active = this.activeTurn;
        if (!active || !this.proc) return;
        active.interrupted = true;
        this.request('turn/interrupt', {
            threadId: active.threadId,
            ...(active.turnId ? { turnId: active.turnId } : {}),
        }, 10_000).catch(() => undefined);
    }

    cancelActive() {
        this.interruptActiveTurn();
    }

    private killProcess() {
        const proc = this.proc;
        if (!proc) return;
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        }, 1_500);
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.interruptActiveTurn();
        this.killProcess();
        this.markDead('codex vision client disposed');
        await fs.promises.rm(this.framesDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

// ---------------------------------------------------------------------------
// Frame temp files
// ---------------------------------------------------------------------------

function framesRootDir(): string {
    return path.join(activeRuntimePaths().privateStateDir, 'browser-agent', 'frames');
}

function sweepStaleFrameDirs(root: string) {
    try {
        if (!fs.existsSync(root)) return;
        const now = Date.now();
        for (const entry of fs.readdirSync(root)) {
            const dir = path.join(root, entry);
            try {
                const stat = fs.statSync(dir);
                if (stat.isDirectory() && now - stat.mtimeMs > STALE_FRAME_DIR_MAX_AGE_MS) {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            } catch { /* best-effort sweep */ }
        }
    } catch { /* best-effort sweep */ }
}

/**
 * Converts shared vision request parts into codex turn input items, writing
 * each frame to a JPEG under callDir (localImage items take a file path).
 */
function partsToCodexItems(parts: VisionRequestPart[], callDir: string): AnyObj[] {
    fs.mkdirSync(callDir, { recursive: true });
    const items: AnyObj[] = [];
    let frameIndex = 0;
    for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
            items.push({ type: 'text', text: part.text, text_elements: [] });
        } else if (part.inlineData?.data) {
            const filePath = path.join(callDir, `frame-${++frameIndex}.jpg`);
            fs.writeFileSync(filePath, Buffer.from(part.inlineData.data, 'base64'));
            items.push({ type: 'localImage', path: filePath });
        }
    }
    return items;
}

// ---------------------------------------------------------------------------
// Vision service
// ---------------------------------------------------------------------------

export function createCodexVisionService(
    initialConfig: Partial<VisionConfig> = {},
    onUsage?: (usage: VisionUsage) => void
): VisionService {
    const state: VisionConfig = {
        provider: 'codex',
        model: initialConfig.model?.trim() || DEFAULT_CODEX_VISION_MODEL,
        thinkingLevel: sanitizeThinkingLevel(initialConfig.thinkingLevel) || 'low',
        // Accepted and ignored: media resolution is a Gemini-only knob, kept so
        // updateConfig/escalation stay symmetric across providers.
        mediaResolution: sanitizeMediaResolution(initialConfig.mediaResolution) || 'medium',
    };

    const root = framesRootDir();
    sweepStaleFrameDirs(root);
    const instanceDir = path.join(root, randomUUID());
    const client = new CodexAppServerClient(instanceDir);
    let callSequence = 0;

    const codexUsageFromResponse = (response: VisionGenerateResponse): Omit<VisionUsage, 'model'> => {
        const usage = response.usageMetadata as Omit<VisionUsage, 'model'> | null | undefined;
        return usage ?? { promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, totalTokens: 0 };
    };

    const runVisionTurn = async (
        parts: VisionRequestPart[],
        systemInstruction: string | undefined,
        outputSchema: unknown,
    ): Promise<VisionGenerateResponse> => {
        const callDir = path.join(instanceDir, `call-${++callSequence}`);
        try {
            const items = partsToCodexItems(parts, callDir);
            const effort = mapEffortForCodex(state.thinkingLevel);
            const result = await client.runTurn({
                developerInstructions: systemInstruction,
                items,
                outputSchema,
                model: state.model,
                effort,
            });
            return { text: result.text, usageMetadata: result.usage };
        } finally {
            await fs.promises.rm(callDir, { recursive: true, force: true }).catch(() => undefined);
        }
    };

    const service: VisionService = {
        updateConfig(patch: Partial<VisionConfig>) {
            if (!patch || typeof patch !== 'object') return;

            if (typeof patch.model === 'string' && patch.model.trim()) {
                state.model = patch.model.trim();
            }
            if (typeof patch.thinkingLevel === 'string' && patch.thinkingLevel.trim()) {
                state.thinkingLevel = sanitizeThinkingLevel(patch.thinkingLevel) || state.thinkingLevel;
            }
            if (typeof patch.mediaResolution === 'string' && patch.mediaResolution.trim()) {
                state.mediaResolution = sanitizeMediaResolution(patch.mediaResolution) || state.mediaResolution;
            }
        },

        getConfig(): VisionConfig {
            return { ...state };
        },

        getCoordinateMode() {
            return 'pixel' as const;
        },

        async analyzeScreenshot(
            frame: BrowserFrameSnapshot,
            goal: string,
            actionHistory: ActionHistoryItem[],
            conversationHistory: string[] = [],
            recentTrace: ActionTrace | null = null,
            supplementalFrames: BrowserFrameSnapshot[] = [],
            isInterrupt = false,
            openTabs: TabInfo[] = [],
            isAdvancedMode: boolean = false,
            downloads: BrowserDownloadFile[] = [],
            escalationEnabled: boolean = true
        ): Promise<AgentAction[]> {
            const systemPrompt = buildSystemPrompt(isAdvancedMode, 'pixel-viewport', escalationEnabled, frame.viewport);
            const memoryContext = buildMemoryContext(getMemories(frame.url, goal));

            const actionPrompt = isInterrupt
                ? buildInterruptPrompt(goal)
                : buildActionPrompt(goal, actionHistory, openTabs, downloads, escalationEnabled, 'pixel-viewport');

            try {
                const historyContext = conversationHistory.length > 0
                    ? `\n## 📜 CONVERSATION HISTORY (Context):\n${conversationHistory.join('\n')}\n`
                    : '';
                const requestParts = buildVisionParts(memoryContext, historyContext, actionPrompt, frame, recentTrace, supplementalFrames, 'pixel-viewport');

                return await requestParsedJsonWithRetries({
                    contextLabel: 'browser action',
                    model: state.model,
                    requestParts,
                    systemInstruction: systemPrompt,
                    generate: (parts, systemInstruction) => runVisionTurn(parts, systemInstruction, CODEX_ACTION_RESPONSE_OUTPUT_SCHEMA),
                    parse: parseAgentActionsFromModelText,
                    extractUsage: codexUsageFromResponse,
                    onUsage,
                });
            } catch (error) {
                console.error('Vision action error (codex):', error);
                const prefix = error instanceof ModelOutputParseError ? 'Model Output Error' : 'API Error';
                return [{
                    action: 'error',
                    reasoning: `${prefix}: ${error instanceof Error ? error.message : 'Unknown'}`,
                }];
            }
        },

        async reflectOnIterationLimit(
            frame: BrowserFrameSnapshot,
            goal: string,
            actionHistory: ActionHistoryItem[],
            conversationHistory: string[] = [],
            recentTrace: ActionTrace | null = null,
            supplementalFrames: BrowserFrameSnapshot[] = [],
            openTabs: TabInfo[] = [],
            downloads: BrowserDownloadFile[] = []
        ): Promise<IterationLimitReview | null> {
            try {
                const reviewPrompt = buildIterationLimitReviewPrompt(goal, actionHistory, openTabs, downloads);
                const historyContext = conversationHistory.length > 0
                    ? `\n## 📜 CONVERSATION HISTORY (Context):\n${conversationHistory.join('\n')}\n`
                    : '';
                const requestParts = buildVisionParts('', historyContext, reviewPrompt, frame, recentTrace, supplementalFrames, 'pixel-viewport');

                const parsed = await requestParsedJsonWithRetries({
                    contextLabel: 'iteration-limit review',
                    model: state.model,
                    requestParts,
                    generate: (parts, systemInstruction) => runVisionTurn(parts, systemInstruction, CODEX_ITERATION_REVIEW_OUTPUT_SCHEMA),
                    parse: parseIterationLimitReviewFromModelText,
                    extractUsage: codexUsageFromResponse,
                    onUsage,
                });

                return {
                    whyNotFinished: String(parsed.whyNotFinished || '').trim(),
                    stuckPoint: String(parsed.stuckPoint || '').trim(),
                    whySelfRecoveryFailed: String(parsed.whySelfRecoveryFailed || '').trim(),
                    humanAssessment: String(parsed.humanAssessment || '').trim(),
                    missingToolsOrCapabilities: normalizeStringArray(parsed.missingToolsOrCapabilities),
                    hardParts: normalizeStringArray(parsed.hardParts),
                    easyParts: normalizeStringArray(parsed.easyParts),
                    futureStrategy: normalizeStringArray(parsed.futureStrategy),
                    questionsForUser: normalizeStringArray(parsed.questionsForUser),
                };
            } catch (error) {
                console.error('Vision iteration-limit reflection error (codex):', error);
                return null;
            }
        },

        async dispose() {
            await client.dispose();
        },

        cancelActive() {
            client.cancelActive();
        },
    };

    return service;
}

export const codexVisionTestHooks = {
    CODEX_ACTION_RESPONSE_OUTPUT_SCHEMA,
    CODEX_ITERATION_REVIEW_OUTPUT_SCHEMA,
    mapEffortForCodex,
    turnTimeoutForEffort,
};
