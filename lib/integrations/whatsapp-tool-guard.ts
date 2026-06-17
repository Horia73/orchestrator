export type WhatsAppToolOperationKind = 'setup' | 'read' | 'deep_read' | 'download' | 'write'

type SleepFn = (ms: number) => Promise<void>
type NowFn = () => number
interface WhatsAppToolGuardOptions {
    signal?: AbortSignal
}

const DEFAULT_MIN_GAP_MS: Record<WhatsAppToolOperationKind, number> = {
    setup: 1_200,
    read: 450,
    deep_read: 900,
    download: 650,
    write: 1_200,
}

const DEFAULT_JITTER_MS: Record<WhatsAppToolOperationKind, number> = {
    setup: 450,
    read: 250,
    deep_read: 450,
    download: 350,
    write: 500,
}

const realSleep: SleepFn = ms => new Promise(resolve => setTimeout(resolve, ms))
const realNow: NowFn = () => Date.now()

let tail: Promise<void> = Promise.resolve()
let lastCompletedAt = 0
let sequence = 0
let testSleep: SleepFn | null = null
let testNow: NowFn | null = null

export async function withWhatsAppToolGuard<T>(
    kind: WhatsAppToolOperationKind,
    fingerprint: string,
    action: () => Promise<T>,
    options: WhatsAppToolGuardOptions = {}
): Promise<T> {
    const previous = tail.catch(() => undefined)
    const run = previous.then(async () => {
        throwIfAborted(options.signal)
        await waitForTurn(kind, fingerprint, options.signal)
        throwIfAborted(options.signal)
        try {
            return await action()
        } finally {
            lastCompletedAt = now()
        }
    })
    tail = run.then(() => undefined, () => undefined)
    return run
}

export function __resetWhatsAppToolGuardForTests(): void {
    tail = Promise.resolve()
    lastCompletedAt = 0
    sequence = 0
    testSleep = null
    testNow = null
}

export function __setWhatsAppToolGuardTestClock(options: { now: NowFn; sleep: SleepFn }): void {
    testNow = options.now
    testSleep = options.sleep
}

async function waitForTurn(kind: WhatsAppToolOperationKind, fingerprint: string, signal?: AbortSignal): Promise<void> {
    if (lastCompletedAt <= 0) return

    const current = now()
    const minGap = DEFAULT_MIN_GAP_MS[kind]
    const jitter = stableJitter(kind, fingerprint, DEFAULT_JITTER_MS[kind])
    const waitMs = Math.max(0, lastCompletedAt + minGap - current) + jitter
    if (waitMs > 0) await sleep(waitMs, signal)
}

function stableJitter(kind: WhatsAppToolOperationKind, fingerprint: string, maxMs: number): number {
    if (maxMs <= 0) return 0
    sequence += 1
    const input = `${kind}:${fingerprint}:${sequence}`
    let hash = 2166136261
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return Math.abs(hash) % (maxMs + 1)
}

function now(): number {
    return testNow ? testNow() : realNow()
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('WhatsApp operation cancelled before it started.')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return testSleep ? testSleep(ms) : realSleep(ms)
    throwIfAborted(signal)
    const abortSignal = signal
    if (testSleep) {
        return testSleep(ms).then(() => {
            throwIfAborted(abortSignal)
        })
    }
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        function cleanup() {
            if (timer) clearTimeout(timer)
            abortSignal.removeEventListener('abort', onAbort)
        }
        function onAbort() {
            cleanup()
            reject(new Error('WhatsApp operation cancelled before it started.'))
        }
        timer = setTimeout(() => {
            cleanup()
            resolve()
        }, ms)
        abortSignal.addEventListener('abort', onAbort, { once: true })
    })
}
