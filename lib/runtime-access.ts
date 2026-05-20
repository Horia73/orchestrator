import dns from 'dns/promises'
import os from 'os'

import { isLoopbackHost } from '@/lib/app-origin'
import { getEnvValue } from '@/lib/config'

export interface RuntimeAccessInfo {
    appOrigin: string
    appHost: string | null
    appPort: string
    publicUrl: string | null
    serverHostname: string
    sshUser: string | null
    envHostLanIp: string | null
    runtimeIPv4: string[]
    resolvedAppHostIPv4: string[]
    sshHostCandidates: string[]
    tunnel: {
        localPort: string
        remotePort: string
        remoteHost: string
        command: string
        openUrl: string
        keepOpen: string
        stop: string
    }
}

export async function getRuntimeAccessInfo(appOrigin: string): Promise<RuntimeAccessInfo> {
    const base = buildRuntimeAccessInfo(appOrigin, [])
    const resolved = base.appHost && !isLoopbackHost(base.appHost)
        ? await resolveIPv4(base.appHost)
        : []
    return buildRuntimeAccessInfo(appOrigin, resolved)
}

export function buildRuntimeAccessContext(appOrigin: string): string[] {
    const info = buildRuntimeAccessInfo(appOrigin, [])
    const lines: string[] = []
    if (info.appHost) lines.push(`app_host: ${info.appHost}`)
    if (info.publicUrl) lines.push(`effective_public_url: ${info.publicUrl}`)
    if (info.envHostLanIp) lines.push(`configured_host_lan_ip: ${info.envHostLanIp}`)
    if (info.runtimeIPv4.length > 0) lines.push(`runtime_ipv4_candidates: ${info.runtimeIPv4.join(', ')}`)
    if (info.sshHostCandidates.length > 0) lines.push(`ssh_host_candidates: ${info.sshHostCandidates.join(', ')}`)
    if (info.sshUser) lines.push(`ssh_user_hint: ${info.sshUser}`)
    lines.push(`oauth_tunnel_template: ${info.tunnel.command}`)
    lines.push(`oauth_tunnel_open_url: ${info.tunnel.openUrl}`)
    lines.push(`oauth_tunnel_lifetime: ${info.tunnel.keepOpen} ${info.tunnel.stop}`)
    return lines
}

function buildRuntimeAccessInfo(appOrigin: string, resolvedAppHostIPv4: string[]): RuntimeAccessInfo {
    const url = parseOrigin(appOrigin)
    const appHost = url?.hostname ?? null
    const appPort = url?.port || defaultPort(url?.protocol)
    const publicUrl = effectivePublicUrl(appOrigin)
    const envHostLanIp = cleanEnv(getEnvValue('ORCHESTRATOR_HOST_LAN_IP'))
    const sshUser = cleanEnv(getEnvValue('ORCHESTRATOR_SSH_USER'))
    const runtimeIPv4 = getRuntimeIPv4()
    const sshHostCandidates = uniqueStrings([
        cleanEnv(getEnvValue('ORCHESTRATOR_SSH_HOST')),
        appHost && !isLoopbackHost(appHost) ? appHost : null,
        ...resolvedAppHostIPv4,
        envHostLanIp,
        ...runtimeIPv4,
        os.hostname(),
    ])
    const remoteHost = sshHostCandidates[0] ?? 'server'
    const remotePort = getEnvValue('ORCHESTRATOR_PORT') || '3000'
    const localPort = appPort || remotePort
    const userHost = sshUser ? `${sshUser}@${remoteHost}` : `user@${remoteHost}`

    return {
        appOrigin,
        appHost,
        appPort,
        publicUrl,
        serverHostname: os.hostname(),
        sshUser,
        envHostLanIp,
        runtimeIPv4,
        resolvedAppHostIPv4,
        sshHostCandidates,
        tunnel: {
            localPort,
            remotePort,
            remoteHost,
            command: `ssh -N -L ${localPort}:127.0.0.1:${remotePort} ${userHost}`,
            openUrl: `http://localhost:${localPort}/settings`,
            keepOpen: 'Keep the SSH command running until Google redirects back and the integration status says Connected.',
            stop: 'After status is Connected, stop the tunnel with Ctrl+C in that terminal.',
        },
    }
}

async function resolveIPv4(hostname: string): Promise<string[]> {
    try {
        const records = await dns.lookup(hostname, { all: true, family: 4 })
        return uniqueStrings(records.map(record => record.address))
    } catch {
        return []
    }
}

function getRuntimeIPv4(): string[] {
    const out: string[] = []
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) continue
            out.push(entry.address)
        }
    }
    return uniqueStrings(out)
}

function parseOrigin(origin: string): URL | null {
    try {
        return new URL(origin)
    } catch {
        return null
    }
}

function defaultPort(protocol?: string): string {
    if (protocol === 'https:') return '443'
    return '3000'
}

function effectivePublicUrl(appOrigin: string): string | null {
    const appUrl = parseOrigin(appOrigin)
    const configured = configuredPublicUrl()
    const configuredUrl = configured ? parseOrigin(configured) : null

    if (appUrl && isPublicHttpsUrl(appUrl)) {
        if (!configuredUrl || configuredUrl.origin !== appUrl.origin) {
            return appUrl.origin
        }
    }

    return configuredUrl?.origin ?? (appUrl && isPublicHttpsUrl(appUrl) ? appUrl.origin : null)
}

function configuredPublicUrl(): string | null {
    return cleanEnv(getEnvValue('ORCHESTRATOR_PUBLIC_URL'))
        || cleanEnv(getEnvValue('ORCHESTRATOR_APP_URL'))
        || cleanEnv(getEnvValue('NEXT_PUBLIC_APP_URL'))
}

function isPublicHttpsUrl(url: URL): boolean {
    if (url.protocol !== 'https:' || isLoopbackHost(url.hostname) || isIpAddress(url.hostname)) {
        return false
    }
    const labels = url.hostname.split('.').filter(Boolean)
    if (labels.length < 2) return false
    const tld = labels[labels.length - 1]?.toLowerCase()
    return Boolean(tld && /^[a-z]{2,63}$/.test(tld) && !RESERVED_TLDS.has(tld))
}

function isIpAddress(hostname: string): boolean {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')
}

const RESERVED_TLDS = new Set([
    'example',
    'home',
    'internal',
    'invalid',
    'lan',
    'local',
    'localhost',
    'test',
])

function cleanEnv(value: string | null | undefined): string | null {
    const clean = value?.trim()
    return clean || null
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const value of values) {
        const clean = value?.trim()
        if (!clean || seen.has(clean)) continue
        seen.add(clean)
        out.push(clean)
    }
    return out
}
