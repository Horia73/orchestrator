import fs from 'fs'
import os from 'os'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { ORCHESTRATOR_STATE_DIR, WORKSPACE_DIR } from '@/lib/runtime-paths'

// ---------------------------------------------------------------------------
// host_status — a live snapshot of the machine the runtime is sitting on.
//
// The per-turn context block already carries the STATIC facts (host_os,
// host_hostname, host_arch, node_version, runtime IPv4 candidates). What it
// can't carry is anything that changes minute to minute: free disk, memory
// pressure, uptime, load. This tool fills that gap on demand.
//
// It is gated behind the `app_guide` subsystem (activate before calling) so it
// never costs context on turns that don't need it. Pure Node built-ins only —
// no child_process, so it can't hang or trip a permission prompt; if the user
// needs host-level specifics this can't reach (docker, systemd, host df),
// reach for Bash separately.
//
// Disk is the operationally important number here: this app commonly runs in a
// container whose state dir + /tmp live on a small host filesystem that fills
// up after a few image rebuilds and then breaks runtime temp writes. The
// result flags any watched filesystem above DISK_PRESSURE_PCT.
// ---------------------------------------------------------------------------

const DISK_PRESSURE_PCT = 85

export const hostStatusTool: ToolDef = {
    id: 'host_status',
    name: 'host_status',
    description: [
        'Live operational snapshot of the machine this Orchestrator runs on: OS, CPU, load average, memory pressure, process uptime/RSS, host uptime, network interfaces, and free space on the key filesystems (state dir, workspace, /tmp).',
        'Use it for "how is the server doing / how much disk is left / is it about to run out of space / how long has it been up". The STATIC machine facts (OS, hostname, IP candidates, node version) are already in your context — call this only for the live/changing numbers.',
        'Read-only. Reports a `disk_pressure` warning when any watched filesystem is over 85% full. For host-level details this cannot see (docker, systemd, full `df`), use Bash.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {},
    },
    tags: ['read', 'diagnostics', 'host'],
}

function humanBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'n/a'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let n = bytes
    let i = 0
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024
        i++
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function humanDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return 'n/a'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const parts: string[] = []
    if (d) parts.push(`${d}d`)
    if (h) parts.push(`${h}h`)
    if (m || parts.length === 0) parts.push(`${m}m`)
    return parts.join(' ')
}

interface DiskEntry {
    label: string
    path: string
    total: string
    free: string
    used_pct: number | null
    over_threshold: boolean
    error?: string
}

async function diskFor(label: string, target: string): Promise<DiskEntry> {
    try {
        const s = await fs.promises.statfs(target)
        const total = s.blocks * s.bsize
        // bavail = blocks free to an unprivileged user; the honest "free" number.
        const free = s.bavail * s.bsize
        const usedPct = total > 0 ? Math.round(((total - free) / total) * 100) : null
        return {
            label,
            path: target,
            total: humanBytes(total),
            free: humanBytes(free),
            used_pct: usedPct,
            over_threshold: usedPct !== null && usedPct >= DISK_PRESSURE_PCT,
        }
    } catch (err) {
        return {
            label,
            path: target,
            total: 'n/a',
            free: 'n/a',
            used_pct: null,
            over_threshold: false,
            error: err instanceof Error ? err.message : 'statfs failed',
        }
    }
}

function networkAddresses(): string[] {
    const out: string[] = []
    for (const [name, entries] of Object.entries(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.internal) continue
            out.push(`${name}: ${entry.address} (${entry.family})`)
        }
    }
    return out
}

export async function executeHostStatus(): Promise<ToolResult> {
    try {
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedMemPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null
        const cpus = os.cpus()
        const load = os.loadavg() // [1m, 5m, 15m] — always [0,0,0] on Windows

        // Dedupe the watched filesystems by resolved path: state dir and
        // workspace are often the same mount, /tmp frequently a different one.
        const targets: Array<{ label: string; path: string }> = [
            { label: 'state dir', path: ORCHESTRATOR_STATE_DIR },
            { label: 'workspace', path: WORKSPACE_DIR },
            { label: 'tmp', path: os.tmpdir() },
        ]
        const seen = new Set<string>()
        const uniqueTargets = targets.filter(t => {
            if (seen.has(t.path)) return false
            seen.add(t.path)
            return true
        })
        const disks = await Promise.all(uniqueTargets.map(t => diskFor(t.label, t.path)))
        const pressured = disks.filter(d => d.over_threshold)

        const procMem = process.memoryUsage()

        return {
            success: true,
            data: {
                host: {
                    hostname: os.hostname(),
                    os: `${os.type()} ${os.release()}`,
                    platform: process.platform,
                    arch: process.arch,
                    uptime: humanDuration(os.uptime()),
                },
                cpu: {
                    model: cpus[0]?.model ?? 'unknown',
                    cores: cpus.length,
                    load_avg: load.map(n => Number(n.toFixed(2))),
                    load_note: process.platform === 'win32' ? 'load average is unavailable on Windows' : 'load average is 1m / 5m / 15m; compare to core count',
                },
                memory: {
                    total: humanBytes(totalMem),
                    free: humanBytes(freeMem),
                    used_pct: usedMemPct,
                },
                process: {
                    pid: process.pid,
                    node_version: process.version,
                    uptime: humanDuration(process.uptime()),
                    rss: humanBytes(procMem.rss),
                    heap_used: humanBytes(procMem.heapUsed),
                },
                disk: disks,
                disk_pressure: pressured.length > 0
                    ? `WARNING: ${pressured.map(d => `${d.label} (${d.path}) is ${d.used_pct}% full`).join('; ')}. Free space before runtime temp writes start failing.`
                    : `ok — all watched filesystems below ${DISK_PRESSURE_PCT}% used`,
                network: networkAddresses(),
            },
        }
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to read host status.',
        }
    }
}
