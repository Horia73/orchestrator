import { dockerBridgeEndpoint } from '@/lib/update/manager'

export interface TailscaleState {
  installed: boolean
  running: boolean
  loggedIn: boolean
  dnsName: string | null
  webhookFunnelEnabled: boolean
  funnelUrl: string | null
  appFunnelEnabled: boolean
  appFunnelUrl: string | null
  publishedAppFunnels: Array<{ slug: string; path: string; url: string | null }>
}

export interface RemoteAccessBridgeStatus {
  /** Whether a host bridge is reachable (Docker installs only). */
  available: boolean
  tailscale: TailscaleState | null
  error: string | null
}

const NO_BRIDGE: RemoteAccessBridgeStatus = {
  available: false,
  tailscale: null,
  error: 'The host bridge is only available on Docker installs.',
}

async function callBridge(
  segment: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<{ ok: boolean; status: number; json: unknown } | null> {
  const cfg = dockerBridgeEndpoint(segment)
  if (!cfg) return null
  try {
    const res = await fetch(cfg.url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    })
    const json = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, json }
  } catch (e) {
    return { ok: false, status: 0, json: { error: e instanceof Error ? e.message : 'Bridge unreachable.' } }
  }
}

function tailscaleFromPayload(payload: unknown): TailscaleState | null {
  if (!payload || typeof payload !== 'object') return null
  const ts = (payload as { tailscale?: unknown }).tailscale
  if (!ts || typeof ts !== 'object') return null
  const r = ts as Record<string, unknown>
  return {
    installed: r.installed === true,
    running: r.running === true,
    loggedIn: r.loggedIn === true,
    dnsName: typeof r.dnsName === 'string' ? r.dnsName : null,
    webhookFunnelEnabled: r.webhookFunnelEnabled === true,
    funnelUrl: typeof r.funnelUrl === 'string' ? r.funnelUrl : null,
    appFunnelEnabled: r.appFunnelEnabled === true,
    appFunnelUrl: typeof r.appFunnelUrl === 'string' ? r.appFunnelUrl : null,
    publishedAppFunnels: Array.isArray(r.publishedAppFunnels)
      ? r.publishedAppFunnels.flatMap((item) => {
          if (!item || typeof item !== 'object') return []
          const v = item as Record<string, unknown>
          const slug = typeof v.slug === 'string' ? v.slug : ''
          const path = typeof v.path === 'string' ? v.path : ''
          if (!slug || !path) return []
          return [{ slug, path, url: typeof v.url === 'string' ? v.url : null }]
        })
      : [],
  }
}

export async function getRemoteAccessStatus(): Promise<RemoteAccessBridgeStatus> {
  const result = await callBridge('remote-access')
  if (!result) return NO_BRIDGE
  if (!result.ok) {
    const error =
      (result.json as { error?: string })?.error ?? `Host bridge returned ${result.status}.`
    return { available: true, tailscale: null, error }
  }
  return { available: true, tailscale: tailscaleFromPayload(result.json), error: null }
}

export interface SetFunnelResult {
  ok: boolean
  tailscale: TailscaleState | null
  error: string | null
  output?: string
}

export async function setWebhookFunnel(enable: boolean): Promise<SetFunnelResult> {
  const result = await callBridge('remote-access/funnel', { method: 'POST', body: { enable } })
  if (!result) {
    return { ok: false, tailscale: null, error: NO_BRIDGE.error }
  }
  const json = (result.json ?? {}) as Record<string, unknown>
  return {
    ok: result.ok && json.ok === true,
    tailscale: tailscaleFromPayload(json),
    error: result.ok ? null : (typeof json.error === 'string' ? json.error : `Bridge returned ${result.status}.`),
    output: typeof json.output === 'string' ? json.output : undefined,
  }
}

export async function setAppFunnel(enable: boolean): Promise<SetFunnelResult> {
  const result = await callBridge('remote-access/app-funnel', { method: 'POST', body: { enable } })
  if (!result) {
    return { ok: false, tailscale: null, error: NO_BRIDGE.error }
  }
  const json = (result.json ?? {}) as Record<string, unknown>
  return {
    ok: result.ok && json.ok === true,
    tailscale: tailscaleFromPayload(json),
    error: result.ok ? null : (typeof json.error === 'string' ? json.error : `Bridge returned ${result.status}.`),
    output: typeof json.output === 'string' ? json.output : undefined,
  }
}

export interface SetPublishedAppFunnelResult extends SetFunnelResult {
  slug: string | null
  path: string | null
  funnelUrl: string | null
}

export async function setPublishedAppFunnel(
  slug: string,
  enable: boolean,
): Promise<SetPublishedAppFunnelResult> {
  const result = await callBridge('remote-access/published-app-funnel', {
    method: 'POST',
    body: { enable, slug },
  })
  if (!result) {
    return {
      ok: false,
      tailscale: null,
      error: NO_BRIDGE.error,
      slug: null,
      path: null,
      funnelUrl: null,
    }
  }
  const json = (result.json ?? {}) as Record<string, unknown>
  return {
    ok: result.ok && json.ok === true,
    tailscale: tailscaleFromPayload(json),
    error: result.ok ? null : (typeof json.error === 'string' ? json.error : `Bridge returned ${result.status}.`),
    output: typeof json.output === 'string' ? json.output : undefined,
    slug: typeof json.slug === 'string' ? json.slug : null,
    path: typeof json.path === 'string' ? json.path : null,
    funnelUrl: typeof json.funnelUrl === 'string' && json.funnelUrl ? json.funnelUrl : null,
  }
}

export async function installTailscale(): Promise<SetFunnelResult> {
  const result = await callBridge('remote-access/install-tailscale', { method: 'POST', body: {} })
  if (!result) {
    return { ok: false, tailscale: null, error: NO_BRIDGE.error }
  }
  const json = (result.json ?? {}) as Record<string, unknown>
  return {
    ok: result.ok && json.ok === true,
    tailscale: tailscaleFromPayload(json),
    error: result.ok ? null : (typeof json.error === 'string' ? json.error : `Bridge returned ${result.status}.`),
    output: typeof json.output === 'string' ? json.output : undefined,
  }
}

export interface SetupHttpsResult {
  ok: boolean
  publicUrl: string | null
  error: string | null
  output?: string
}

export async function setupHttps(input: {
  domain: string
  token: string
  email?: string
}): Promise<SetupHttpsResult> {
  const result = await callBridge('remote-access/https', {
    method: 'POST',
    body: { domain: input.domain, token: input.token, email: input.email ?? '' },
  })
  if (!result) return { ok: false, publicUrl: null, error: NO_BRIDGE.error }
  const json = (result.json ?? {}) as Record<string, unknown>
  return {
    ok: result.ok && json.ok === true,
    publicUrl: typeof json.publicUrl === 'string' ? json.publicUrl : null,
    error: result.ok ? null : (typeof json.error === 'string' ? json.error : `Bridge returned ${result.status}.`),
    output: typeof json.output === 'string' ? json.output : undefined,
  }
}
