import {
    __resetWhatsAppToolGuardForTests,
    __setWhatsAppToolGuardTestClock,
    withWhatsAppToolGuard,
} from '@/lib/integrations/whatsapp-tool-guard'

let failures = 0

function check(label: string, condition: boolean): void {
    if (condition) {
        console.log(`ok ${label}`)
        return
    }
    failures += 1
    console.error(`FAIL ${label}`)
}

let currentTime = 1_000
let waits: number[] = []

function installFakeClock(): void {
    __setWhatsAppToolGuardTestClock({
        now: () => currentTime,
        sleep: async ms => {
            waits.push(ms)
            currentTime += ms
        },
    })
}

__resetWhatsAppToolGuardForTests()
installFakeClock()

const first = await withWhatsAppToolGuard('read', 'chat-a', async () => {
    currentTime += 10
    return 'first'
})
const second = await withWhatsAppToolGuard('read', 'chat-a', async () => {
    currentTime += 10
    return 'second'
})

check('guard returns action result', first === 'first' && second === 'second')
check('first operation is not delayed', waits.length === 1)
check('second read waits at least the minimum gap', (waits[0] ?? 0) >= 450)
check('second read wait stays bounded by jitter cap', (waits[0] ?? 0) <= 700)

__resetWhatsAppToolGuardForTests()
currentTime = 10_000
waits = []
installFakeClock()

const order: string[] = []
let releaseFirst!: () => void
let signalFirstStarted: (() => void) | null = null
const firstStarted = new Promise<void>(resolve => {
    signalFirstStarted = resolve
})
const firstRelease = new Promise<void>(resolve => {
    releaseFirst = resolve
})
const firstQueued = withWhatsAppToolGuard('write', 'one', async () => {
    order.push('first:start')
    signalFirstStarted?.()
    await firstRelease
    order.push('first:end')
    return 'first'
})
const secondQueued = withWhatsAppToolGuard('write', 'two', async () => {
    order.push('second:start')
    return 'second'
})

const started = await Promise.race([
    firstStarted.then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
])
check('first queued operation starts', started)
check('guard serializes concurrent operations', order.join(',') === 'first:start')

releaseFirst()
await Promise.all([firstQueued, secondQueued])

check('queued operation runs after first completes', order.join(',') === 'first:start,first:end,second:start')
check('queued write waits at least the write minimum gap', (waits[0] ?? 0) >= 1_200)
check('queued write wait stays bounded by jitter cap', (waits[0] ?? 0) <= 1_700)

__resetWhatsAppToolGuardForTests()
currentTime = 20_000
waits = []
installFakeClock()

let releaseBlocking!: () => void
let signalBlockingStarted: (() => void) | null = null
const blockingStarted = new Promise<void>(resolve => {
    signalBlockingStarted = resolve
})
const blockingRelease = new Promise<void>(resolve => {
    releaseBlocking = resolve
})
const blocking = withWhatsAppToolGuard('read', 'blocking', async () => {
    signalBlockingStarted?.()
    await blockingRelease
    return 'blocking'
})

const abortController = new AbortController()
let cancelledRan = false
const cancelled = withWhatsAppToolGuard('read', 'cancelled', async () => {
    cancelledRan = true
    return 'cancelled'
}, { signal: abortController.signal }).catch(err => err)

await blockingStarted
abortController.abort()
releaseBlocking()
const cancelledResult = await cancelled
await blocking

check('aborted queued operation returns an error', cancelledResult instanceof Error)
check('aborted queued operation does not run later', !cancelledRan)

__resetWhatsAppToolGuardForTests()

if (failures > 0) {
    console.error(`\n${failures} WhatsApp tool guard smoke check(s) failed.`)
    process.exit(1)
}

console.log('\nWhatsApp tool guard smoke checks passed.')
