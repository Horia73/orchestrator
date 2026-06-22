// Memory observability + OOM watchdog for the main Node server process.
//
// Context (2026-06-22 incident): the server OOM-crashed at ~10.7 GB anon-rss
// even though the V8 heap cap (--max-old-space-size=6144) was active. That
// means most of the growth was EXTERNAL / Buffer memory (off-heap), which the
// heap cap does NOT govern — so the cap couldn't stop it. The climb is slow:
// it accrues over hours under light background load (scheduler heartbeats),
// not from an agent burst (the concurrency gate already bounds that).
//
// Until the leak itself is found and fixed, this module does two things:
//   1. Logs process.memoryUsage() periodically (rss / heapUsed / external /
//      arrayBuffers) so we can see WHICH pool grows and correlate it with what
//      the app was doing — the data needed to locate the leak.
//   2. If RSS stays above a high-water mark for a few consecutive samples, it
//      restarts the process (controlled exit → Docker `unless-stopped` brings
//      it back in seconds) BEFORE the kernel global-OOM fires. A controlled
//      restart only drops this app's in-flight work; a kernel OOM can instead
//      kill a neighbour container (frigate/jellyfin) on the shared 16 GB host.
//
// All thresholds are env-tunable. Set MEMORY_WATCHDOG_RSS_MB=0 to disable the
// restart while keeping the logging.

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
}

const LOG_INTERVAL_MS = envInt('MEMORY_LOG_INTERVAL_MS', 300_000) // 5 min
const CHECK_INTERVAL_MS = envInt('MEMORY_WATCHDOG_INTERVAL_MS', 60_000) // 1 min
const RSS_RESTART_MB = envInt('MEMORY_WATCHDOG_RSS_MB', 8500) // 0 = disabled
const CONSECUTIVE_OVER = 3

const globalForWatchdog = globalThis as unknown as {
    __orchestratorMemoryWatchdog?: boolean
}

function mb(bytes: number): number {
    return Math.round(bytes / 1048576)
}

function snapshot(): string {
    const m = process.memoryUsage()
    return `rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers)}MB`
}

/** Arm the periodic memory log + the high-RSS restart watchdog. Idempotent;
 *  safe to call once at boot. No-op restart side when MEMORY_WATCHDOG_RSS_MB=0. */
export function startMemoryWatchdog(): void {
    if (globalForWatchdog.__orchestratorMemoryWatchdog) return
    globalForWatchdog.__orchestratorMemoryWatchdog = true

    console.log(
        `[memory] watchdog armed — log/${Math.round(LOG_INTERVAL_MS / 1000)}s, ` +
            `restart if rss>=${RSS_RESTART_MB}MB x${CONSECUTIVE_OVER} (0=off). ${snapshot()}`
    )

    const logTimer = setInterval(() => {
        console.log(`[memory] ${snapshot()}`)
    }, LOG_INTERVAL_MS)
    logTimer.unref?.()

    if (RSS_RESTART_MB <= 0) return

    let over = 0
    const checkTimer = setInterval(() => {
        const rssMb = mb(process.memoryUsage().rss)
        if (rssMb < RSS_RESTART_MB) {
            over = 0
            return
        }
        over += 1
        console.error(
            `[memory] WATCHDOG high RSS ${rssMb}MB >= ${RSS_RESTART_MB}MB (${over}/${CONSECUTIVE_OVER}) ${snapshot()}`
        )
        if (over >= CONSECUTIVE_OVER) {
            console.error(`[memory] WATCHDOG restarting process to avoid host OOM — ${snapshot()}`)
            // Docker's restart policy brings us back in seconds — far safer than
            // a kernel global-OOM that might evict a neighbour container.
            process.exit(1)
        }
    }, CHECK_INTERVAL_MS)
    checkTimer.unref?.()
}
