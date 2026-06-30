"use client"

import * as React from "react"
import { Globe, Wifi, Webhook, Loader2, CheckCircle2, AlertCircle, Copy, Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { appApiPath } from "@/lib/app-path"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  publishedAppFunnels?: Array<{ slug: string; path: string; url: string | null }>
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

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy selection-based copy path.
    }
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.top = "0"
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback(async () => {
    if (!(await copyText(url))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }, [url])
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-2 py-1 font-mono text-xs text-foreground hover:border-border"
    >
      <span className="truncate">{url}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-emerald-500" /> : <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </button>
  )
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback(async () => {
    if (!(await copyText(command))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }, [command])
  return (
    <div className="relative rounded-lg border border-border/60 bg-muted/40 p-3">
      <pre className="overflow-x-auto pr-9 text-[11px] leading-relaxed text-muted-foreground">
        <code>{command}</code>
      </pre>
      <button
        type="button"
        title="Copy command"
        onClick={() => void copy()}
        className="absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground hover:text-foreground"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
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

const MANUAL_HTTPS_SETUP_COMMAND = `cd /path/to/orchestrator
ORCHESTRATOR_DUCKDNS_DOMAIN=your-duckdns-subdomain \\
ORCHESTRATOR_DUCKDNS_TOKEN=your-duckdns-token \\
ORCHESTRATOR_LETSENCRYPT_EMAIL=you@example.com \\
bash scripts/install.sh setup-https`

function ManualHttpsSetupFallback({ bridgeError }: { bridgeError: string | null }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">Automatic setup is not connected on this install.</p>
          <p>
            {bridgeError ||
              "The host bridge is missing, so Orchestrator cannot run the DuckDNS and nginx setup from the browser."}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Replace the placeholders and run this on the machine that hosts Orchestrator. It installs the
          DuckDNS updater, gets a Let&apos;s Encrypt certificate, configures nginx, and writes{" "}
          <span className="font-mono">ORCHESTRATOR_PUBLIC_URL</span>.
        </p>
        <CopyCommand command={MANUAL_HTTPS_SETUP_COMMAND} />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          After it prints <span className="font-mono">ORCHESTRATOR_PUBLIC_URL=...</span>, restart the app
          if it is still using the old environment, then press Refresh here.
        </p>
      </div>
    </div>
  )
}

function HttpsSetupForm({ onDone }: { onDone: () => Promise<void> | void }) {
  const [domain, setDomain] = React.useState("")
  const [token, setToken] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [output, setOutput] = React.useState<string | null>(null)
  const [doneUrl, setDoneUrl] = React.useState<string | null>(null)

  const canSubmit = domain.trim().length > 0 && token.trim().length > 0 && !busy

  const submit = React.useCallback(async () => {
    setBusy(true)
    setError(null)
    setOutput(null)
    try {
      const res = await fetch(appApiPath("/api/remote-access/https"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domain.trim(), token: token.trim(), email: email.trim() }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.ok) {
        if (json?.output) setOutput(String(json.output))
        throw new Error(json?.error || "HTTPS setup didn't complete — see the details below.")
      }
      setDoneUrl(json.publicUrl ?? null)
      await onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : "HTTPS setup failed.")
    } finally {
      setBusy(false)
    }
  }, [domain, token, email, onDone])

  if (doneUrl) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        <span>HTTPS is set up — open Orchestrator at</span>
        <CopyLink url={doneUrl} />
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="DuckDNS domain (e.g. my-orchestrator)"
          className="h-8 text-[13px]"
        />
        <Input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="DuckDNS token"
          type="password"
          className="h-8 text-[13px]"
        />
      </div>
      <Input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Let's Encrypt email (optional)"
        className="h-8 text-[13px]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Set up HTTPS"}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Provisions a Let&apos;s Encrypt cert + reverse proxy on the host (needs root).
        </span>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {output ? (
        <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-[10px] leading-snug text-muted-foreground">
          {output}
        </pre>
      ) : null}
    </div>
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
  const [showReconfig, setShowReconfig] = React.useState(false)
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
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span>HTTPS is set up.</span>
              {access.publicUrl ? <CopyLink url={access.publicUrl} /> : null}
            </div>
            {bridge.available ? (
              showReconfig ? (
                <HttpsSetupForm onDone={load} />
              ) : (
                <button
                  type="button"
                  onClick={() => setShowReconfig(true)}
                  className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Change HTTPS domain (DuckDNS)
                </button>
              )
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
              No public HTTPS URL yet. HTTPS is needed for Google/Gmail sign-in and browser
              notifications. Set it up with your own domain on DuckDNS:
            </p>
            {bridge.available ? (
              <HttpsSetupForm onDone={load} />
            ) : (
              <ManualHttpsSetupFallback bridgeError={bridge.error} />
            )}
          </div>
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
