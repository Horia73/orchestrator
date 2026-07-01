import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { getRemoteAccessStatus, setWebhookFunnel, installTailscale, setupHttps } from '@/lib/remote-access/manager'
import { getRuntimeAccessInfo } from '@/lib/runtime-access'

const EMPTY_SCHEMA = { type: 'object' as const, properties: {}, additionalProperties: false }

export const remoteAccessStatusTool: ToolDef = {
  id: 'remote_access_status',
  name: 'remote_access_status',
  description:
    'Report how Orchestrator is reachable: LAN URLs, whether a public HTTPS URL is configured, and Tailscale state (installed / signed-in, tailnet name, whether the full-UI Funnel or public /api/webhooks Funnel is currently on, and any published-app Funnel paths). Read-only — use this before suggesting or making any remote-access change.',
  input_schema: EMPTY_SCHEMA,
  tags: ['read', 'remote-access'],
}

export async function executeRemoteAccessStatus(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _args: Record<string, unknown> = {},
  ctx?: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const origin = ctx?.appOrigin ?? process.env.ORCHESTRATOR_PUBLIC_URL ?? 'http://localhost:3000'
    const [access, bridge] = await Promise.all([getRuntimeAccessInfo(origin), getRemoteAccessStatus()])
    const lanUrls = Array.from(
      new Set([access.envHostLanIp, ...access.runtimeIPv4].filter(Boolean) as string[]),
    ).map((ip) => `http://${ip}:${access.appPort}`)
    return {
      success: true,
      data: {
        lanUrls,
        publicUrl: access.publicUrl,
        httpsConfigured: !!access.publicUrl && /^https:/i.test(access.publicUrl),
        bridgeAvailable: bridge.available,
        tailscale: bridge.tailscale,
        bridgeError: bridge.error,
      },
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Failed to read remote access status.' }
  }
}

export const remoteAccessEnableWebhookFunnelTool: ToolDef = {
  id: 'remote_access_enable_webhook_funnel',
  name: 'remote_access_enable_webhook_funnel',
  description:
    'Expose ONLY the /api/webhooks path to the public internet via Tailscale Funnel so external services can deliver inbound webhooks. The rest of the app stays private and every webhook still needs its signed secret. This is an outward-facing change that makes an endpoint internet-reachable — confirm with the user before calling. Requires Tailscale installed + signed in on the host (Docker installs); on success it returns the public funnel URL.',
  input_schema: EMPTY_SCHEMA,
  tags: ['write', 'remote-access'],
}

export async function executeRemoteAccessEnableWebhookFunnel(): Promise<ToolResult> {
  const r = await setWebhookFunnel(true)
  if (!r.ok) {
    return { success: false, error: r.error ?? 'Failed to enable the webhook funnel.', data: { output: r.output, tailscale: r.tailscale } }
  }
  return { success: true, data: { funnelUrl: r.tailscale?.funnelUrl ?? null, tailscale: r.tailscale } }
}

export const remoteAccessDisableWebhookFunnelTool: ToolDef = {
  id: 'remote_access_disable_webhook_funnel',
  name: 'remote_access_disable_webhook_funnel',
  description: 'Stop exposing /api/webhooks to the public internet (turn off the Tailscale Funnel).',
  input_schema: EMPTY_SCHEMA,
  tags: ['write', 'remote-access'],
}

export async function executeRemoteAccessDisableWebhookFunnel(): Promise<ToolResult> {
  const r = await setWebhookFunnel(false)
  if (!r.ok) return { success: false, error: r.error ?? 'Failed to disable the webhook funnel.' }
  return { success: true, data: { tailscale: r.tailscale } }
}

export const remoteAccessInstallTailscaleTool: ToolDef = {
  id: 'remote_access_install_tailscale',
  name: 'remote_access_install_tailscale',
  description:
    'Best-effort install of Tailscale on the host (Docker installs). Needs root, so it may fail on hosts without passwordless sudo — if it fails, tell the user to run `curl -fsSL https://tailscale.com/install.sh | sh` on the server themselves. After install the node still needs `sudo tailscale up` (interactive browser auth) before it can be used or expose a funnel.',
  input_schema: EMPTY_SCHEMA,
  tags: ['write', 'remote-access'],
}

export async function executeRemoteAccessInstallTailscale(): Promise<ToolResult> {
  const r = await installTailscale()
  if (!r.ok) {
    return { success: false, error: r.error ?? 'Tailscale install did not complete — guide the user to run it manually.', data: { output: r.output, tailscale: r.tailscale } }
  }
  return {
    success: true,
    data: { tailscale: r.tailscale, note: 'Installed. The user still needs to run `sudo tailscale up` to authenticate the node.' },
  }
}

export const remoteAccessSetupHttpsTool: ToolDef = {
  id: 'remote_access_setup_https',
  name: 'remote_access_setup_https',
  description:
    "Provision public HTTPS for the UI via DuckDNS + Let's Encrypt + nginx, given the user's DuckDNS domain + token (and optional email). This sets up the user's own domain (domain→LAN is the fast primary path) and the resulting https URL also unblocks Google/Gmail sign-in and browser notifications. Needs root on the host (Docker installs) — if it fails, guide the user to run the installer's HTTPS step with sudo. Outward-facing host change — confirm the domain/token with the user before calling.",
  input_schema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'DuckDNS subdomain, e.g. my-orchestrator or my-orchestrator.duckdns.org.' },
      token: { type: 'string', description: 'DuckDNS token (sensitive).' },
      email: { type: 'string', description: "Optional Let's Encrypt email." },
    },
    required: ['domain', 'token'],
    additionalProperties: false,
  },
  tags: ['write', 'remote-access'],
}

export async function executeRemoteAccessSetupHttps(args: Record<string, unknown> = {}): Promise<ToolResult> {
  const domain = typeof args.domain === 'string' ? args.domain.trim() : ''
  const token = typeof args.token === 'string' ? args.token.trim() : ''
  const email = typeof args.email === 'string' ? args.email.trim() : ''
  if (!domain || !token) return { success: false, error: 'A DuckDNS domain and token are required.' }
  const r = await setupHttps({ domain, token, email })
  if (!r.ok) return { success: false, error: r.error ?? 'HTTPS setup did not complete.', data: { output: r.output } }
  return { success: true, data: { publicUrl: r.publicUrl } }
}

export const remoteAccessTools: ToolDef[] = [
  remoteAccessStatusTool,
  remoteAccessEnableWebhookFunnelTool,
  remoteAccessDisableWebhookFunnelTool,
  remoteAccessInstallTailscaleTool,
  remoteAccessSetupHttpsTool,
]
