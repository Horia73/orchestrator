"use client"

import * as React from "react"
import { Globe, Wifi, Webhook, Loader2, CheckCircle2, AlertCircle, Copy, Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { appApiPath } from "@/lib/app-path"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"

interface RuntimeAccessInfo {
  appPort: string
  publicUrl: string | null
  runtimeIPv4: string[]
  envHostLanIp: string | null
}

interface TailscaleState {
  installed: boolean
  running: boolean
  loggedIn: boolean
  dnsName: string | null
  webhookFunnelEnabled: boolean
  funnelUrl: string | null
}

interface RemoteAccessStatus {
  access: RuntimeAccessInfo
  bridge: { available: boolean; tailscale: TailscaleState | null; error: string | null }
}

export function isPublicHttps(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(u.hostname)
  } catch {
    return false
  }
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(url)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-2 py-1 font-mono text-xs text-foreground hover:border-border"
    >
      <span className="truncate">{url}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-emerald-500" /> : <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </button>
  )
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  )
}

export function RemoteAccessPanel({
  onStatus,
}: {
  /** Called whenever status (re)loads, so a host can derive httpsConfigured etc. */
  onStatus?: (status: RemoteAccessStatus) => void
}) {
  const [status, setStatus] = React.useState<RemoteAccessStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [installing, setInstalling] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { confirm, dialog } = useConfirm()

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(appApiPath("/api/remote-access"), { cache: "no-store" })
      const json = (await res.json().catch(() => null)) as RemoteAccessStatus | null
      if (json) {
        setStatus(json)
        onStatus?.(json)
      }
    } finally {
      setLoading(false)
    }
  }, [onStatus])

  React.useEffect(() => {
    void load()
  }, [load])

  const toggleFunnel = React.useCallback(
    async (enable: boolean) => {
      if (enable) {
        const ok = await confirm({
          title: "Expose the webhook endpoint?",
          message:
            "This publishes ONLY /api/webhooks to the internet via Tailscale Funnel so services can send events. Every webhook still requires its signed secret. The rest of Orchestrator stays private.",
          confirmLabel: "Enable",
          cancelLabel: "Cancel",
        })
        if (!ok) return
      }
      setBusy(true)
      setError(null)
      try {
        const res = await fetch(appApiPath("/api/remote-access/funnel"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enable }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok || !json?.ok) {
          throw new Error(json?.error || json?.output || "Couldn't update the funnel.")
        }
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't update the funnel.")
      } finally {
        setBusy(false)
      }
    },
    [confirm, load],
  )

  const runInstall = React.useCallback(async () => {
    setInstalling(true)
    setError(null)
    try {
      const res = await fetch(appApiPath("/api/remote-access/install-tailscale"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.ok) {
        throw new Error(
          json?.error || json?.output || "Couldn't install Tailscale automatically — use the command below.",
        )
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't install Tailscale.")
    } finally {
      setInstalling(false)
    }
  }, [load])

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking your connectivity…
      </div>
    )
  }
  if (!status) {
    return <p className="text-sm text-destructive">Couldn&apos;t load connectivity status.</p>
  }

  const { access, bridge } = status
  const ts = bridge.tailscale
  const lanUrls = Array.from(
    new Set([access.envHostLanIp, ...access.runtimeIPv4].filter(Boolean) as string[]),
  ).map((ip) => `http://${ip}:${access.appPort}`)
  const hasHttps = isPublicHttps(access.publicUrl)

  return (
    <div className="space-y-3">
      {dialog}

      <Section icon={<Wifi className="h-4 w-4" />} title="On your network">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Reach Orchestrator directly on your LAN — the fastest path. Point your own domain at one of
          these addresses for HTTPS at home, and use Tailscale to reach the same address when you&apos;re away.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {lanUrls.length > 0 ? (
            lanUrls.map((u) => <CopyLink key={u} url={u} />)
          ) : (
            <span className="text-xs text-muted-foreground">No LAN address detected.</span>
          )}
        </div>
      </Section>

      <Section icon={<Globe className="h-4 w-4" />} title="HTTPS / public address">
        {hasHttps ? (
          <div className="flex items-center gap-2 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <span>HTTPS is set up.</span>
            {access.publicUrl ? <CopyLink url={access.publicUrl} /> : null}
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
            No public HTTPS URL configured. HTTPS is needed for Google/Gmail sign-in and browser
            notifications. Set <span className="font-mono">ORCHESTRATOR_PUBLIC_URL</span> to your
            HTTPS domain, or run the installer&apos;s HTTPS setup.
          </p>
        )}
      </Section>

      <Section icon={<Webhook className="h-4 w-4" />} title="Inbound webhooks">
        {!bridge.available ? (
          <p className="text-xs text-muted-foreground">
            Public webhook ingress is managed on Docker installs.
          </p>
        ) : !ts?.installed ? (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Tailscale lets you reach Orchestrator from anywhere and expose a public webhook endpoint
              without opening your router. Install it on the server:
            </p>
            <Button size="sm" disabled={installing} onClick={() => void runInstall()}>
              {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Install Tailscale"}
            </Button>
            <p className="text-[11px] text-muted-foreground">Or run it yourself on the server (needs root):</p>
            <CopyLink url="curl -fsSL https://tailscale.com/install.sh | sh" />
          </div>
        ) : !ts.loggedIn ? (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Tailscale is installed but not signed in. Run this on the server, authenticate in your
              browser, then Refresh:
            </p>
            <CopyLink url="sudo tailscale up" />
          </div>
        ) : ts.webhookFunnelEnabled ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span>Webhook endpoint is public.</span>
            </div>
            {ts.funnelUrl ? <CopyLink url={ts.funnelUrl} /> : null}
            <div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggleFunnel(false)}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disable"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Publish only <span className="font-mono">/api/webhooks</span> to the internet via Tailscale
              Funnel{ts.dnsName ? ` (${ts.dnsName})` : ""}. Everything else stays private.
            </p>
            <Button size="sm" disabled={busy} onClick={() => void toggleFunnel(true)}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Enable public webhooks"}
            </Button>
          </div>
        )}
      </Section>

      {error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void load()}
        className={cn(
          "text-xs font-medium text-muted-foreground hover:text-foreground",
          loading && "pointer-events-none opacity-50",
        )}
      >
        Refresh
      </button>
    </div>
  )
}
