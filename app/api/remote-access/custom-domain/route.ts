import dns from 'dns/promises'
import net from 'net'

import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getCurrentProfileFromRequest, runWithRequestProfile } from '@/lib/profiles/server'

export const dynamic = 'force-dynamic'

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
} as const

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

/** POST /api/remote-access/custom-domain — validate that a custom HTTPS origin reaches Orchestrator. */
export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const current = getCurrentProfileFromRequest(request)
    if (!current?.isAdmin) {
      return NextResponse.json(
        { error: 'Admin profile required.' },
        { status: 403, headers: JSON_HEADERS },
      )
    }

    let body: { url?: unknown }
    try {
      body = (await request.json()) ?? {}
    } catch {
      body = {}
    }

    const normalized = normalizeCustomOrigin(typeof body.url === 'string' ? body.url : '')
    if (!normalized.ok) {
      return NextResponse.json(
        { ok: false, error: normalized.error },
        { status: 400, headers: JSON_HEADERS },
      )
    }

    const dnsCheck = await resolvePublicAddresses(normalized.url.hostname)
    if (!dnsCheck.ok) {
      return NextResponse.json(
        { ok: false, origin: normalized.origin, error: dnsCheck.error },
        { status: 400, headers: JSON_HEADERS },
      )
    }

    const pingUrl = new URL('/api/ping', normalized.origin).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(pingUrl, {
        method: 'HEAD',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
      })
      if (response.status !== 204) {
        return NextResponse.json(
          {
            ok: false,
            origin: normalized.origin,
            pingUrl,
            error: `The domain responded with HTTP ${response.status}, not Orchestrator's /api/ping response.`,
          },
          { status: 502, headers: JSON_HEADERS },
        )
      }
      return NextResponse.json(
        {
          ok: true,
          origin: normalized.origin,
          pingUrl,
          addresses: dnsCheck.addresses,
          env: {
            ORCHESTRATOR_PUBLIC_URL: normalized.origin,
            BROWSER_AGENT_VNC_WS_PUBLIC_URL: websocketUrlFor(normalized.url),
          },
        },
        { headers: JSON_HEADERS },
      )
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'Timed out while checking /api/ping through the custom domain.'
          : error instanceof Error
            ? error.message
            : 'Could not reach /api/ping through the custom domain.'
      return NextResponse.json(
        { ok: false, origin: normalized.origin, pingUrl, error: message },
        { status: 502, headers: JSON_HEADERS },
      )
    } finally {
      clearTimeout(timeout)
    }
  })
}

function normalizeCustomOrigin(raw: string): { ok: true; url: URL; origin: string } | { ok: false; error: string } {
  const input = raw.trim()
  if (!input) return { ok: false, error: 'Enter a custom HTTPS domain.' }

  let url: URL
  try {
    url = new URL(input.includes('://') ? input : `https://${input}`)
  } catch {
    return { ok: false, error: 'Enter a valid domain, for example https://orchestrator.example.com.' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Custom public domains must use https://.' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Do not include credentials in the public URL.' }
  }
  if (!isPublicDomainLike(url.hostname)) {
    return { ok: false, error: 'Use a public domain name, not localhost, an IP address, or a reserved/private TLD.' }
  }

  return { ok: true, url, origin: url.origin }
}

async function resolvePublicAddresses(hostname: string): Promise<{ ok: true; addresses: string[] } | { ok: false; error: string }> {
  let records: Array<{ address: string }>
  try {
    records = await dns.lookup(hostname, { all: true })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `DNS lookup failed: ${error.message}` : 'DNS lookup failed.',
    }
  }

  const addresses = records.map((record) => record.address)
  if (addresses.length === 0) return { ok: false, error: 'DNS lookup returned no addresses.' }
  const blocked = addresses.find(isPrivateOrReservedAddress)
  if (blocked) {
    return {
      ok: false,
      error: `DNS resolves to ${blocked}, which is private or reserved. Public validation only supports internet-routable domains.`,
    }
  }
  return { ok: true, addresses }
}

function websocketUrlFor(url: URL): string {
  return `wss://${url.host}/vnc`
}

function isPublicDomainLike(hostname: string): boolean {
  const host = hostname.trim().replace(/\.$/, '').toLowerCase()
  if (!host || net.isIP(host) !== 0) return false
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return false
  const tld = labels[labels.length - 1] ?? ''
  if (!/^[a-z]{2,63}$/i.test(tld)) return false
  return !RESERVED_TLDS.has(tld)
}

function isPrivateOrReservedAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return isPrivateOrReservedIPv4(address)
  if (family === 6) return isPrivateOrReservedIPv6(address)
  return true
}

function isPrivateOrReservedIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function isPrivateOrReservedIPv6(address: string): boolean {
  const host = address.toLowerCase()
  if (host === '::' || host === '::1') return true
  if (host.startsWith('fe80:')) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length)
    if (net.isIP(mapped) === 4) return isPrivateOrReservedIPv4(mapped)
  }
  return false
}
