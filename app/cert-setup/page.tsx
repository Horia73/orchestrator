import type { Metadata } from "next"
import Link from "next/link"
import type { ReactNode } from "react"
import {
  BellRing,
  CheckCircle2,
  Download,
  ExternalLink,
  HousePlus,
  KeyRound,
  Laptop,
  ShieldCheck,
  Smartphone,
} from "lucide-react"

import { Button } from "@/components/ui/button"

export const metadata: Metadata = {
  title: "LAN HTTPS Setup - Orchestrator",
  description: "Install and trust the Orchestrator LAN certificate.",
}

const appleSteps = [
  "Download the Apple profile on this device.",
  "Open Settings and install the downloaded profile.",
  "Go to General > About > Certificate Trust Settings.",
  "Enable full trust for Orchestrator LAN Root CA.",
]

const desktopSteps = [
  "Download the certificate file.",
  "Open it in Keychain Access or your system certificate manager.",
  "Mark Orchestrator LAN Root CA as trusted for SSL/TLS.",
  "Reopen the browser and open the HTTPS app.",
]

export default function CertSetupPage() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
              <ShieldCheck className="size-4" />
            </div>
            <div>
              <p className="font-medium text-foreground">Orchestrator LAN</p>
              <p>Private HTTPS setup for orchestrator.lan</p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/">
              <ExternalLink className="size-3.5" />
              App
            </Link>
          </Button>
        </header>

        <section className="grid gap-7 lg:grid-cols-[minmax(0,1.04fr)_minmax(320px,0.96fr)] lg:items-start">
          <div className="flex flex-col gap-5">
            <div className="inline-flex w-fit items-center gap-2 rounded-md border border-border bg-muted/45 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
              <KeyRound className="size-3.5" />
              Local CA, no public domain required
            </div>
            <div className="space-y-4">
              <h1 className="max-w-3xl text-4xl leading-none font-semibold tracking-normal text-balance sm:text-5xl lg:text-6xl">
                Trust Orchestrator on this device.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                Install the local Orchestrator LAN root certificate once, then
                use the app through HTTPS and enable push notifications like a
                production app.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4 shadow-[0_18px_70px_-55px_rgba(0,0,0,0.65)]">
            <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-950 dark:bg-emerald-950/35 dark:text-emerald-100">
              <div className="flex gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                <p>
                  The app stays private on your LAN. HTTP is only used for this
                  certificate setup page and certificate downloads.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2">
              <Button asChild size="lg" className="h-11 justify-start">
                <a href="/orchestrator-lan-root-ca.mobileconfig">
                  <Download className="size-4" />
                  Download Apple profile
                </a>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="h-11 justify-start"
              >
                <a href="/orchestrator-lan-root-ca.crt">
                  <Download className="size-4" />
                  Download .crt certificate
                </a>
              </Button>
              <Button
                asChild
                variant="secondary"
                size="lg"
                className="h-11 justify-start"
              >
                <a href="https://orchestrator.lan/">
                  <ExternalLink className="size-4" />
                  Open HTTPS app
                </a>
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          <InstructionPanel
            icon={<Smartphone className="size-4" />}
            title="iPhone and iPad"
            description="Apple requires one manual trust step after installing a local root certificate."
            steps={appleSteps}
          />
          <InstructionPanel
            icon={<Laptop className="size-4" />}
            title="Mac, Windows, Android"
            description="Install the root certificate into the system trust store used by your browser."
            steps={desktopSteps}
          />
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          <InfoTile
            icon={<ShieldCheck className="size-4" />}
            title="What expires?"
            text="The local root CA is long-lived. The server certificate renews on the OpenMediaVault box before it expires."
          />
          <InfoTile
            icon={<HousePlus className="size-4" />}
            title="iOS notifications"
            text="After HTTPS works, add Orchestrator to the Home Screen and open that app before enabling notifications."
          />
          <InfoTile
            icon={<BellRing className="size-4" />}
            title="Prompt behavior"
            text="If you tap Not now on the notification prompt, it stays hidden only for that page load and returns after reload."
          />
        </section>
      </section>
    </main>
  )
}

function InstructionPanel({
  icon,
  title,
  description,
  steps,
}: {
  icon: ReactNode
  title: string
  description: string
  steps: string[]
}) {
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
          {icon}
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <ol className="mt-4 grid gap-2">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-sm leading-6">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground">
              {index + 1}
            </span>
            <span className="text-muted-foreground">{step}</span>
          </li>
        ))}
      </ol>
    </article>
  )
}

function InfoTile({
  icon,
  title,
  text,
}: {
  icon: ReactNode
  title: string
  text: string
}) {
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="flex size-7 items-center justify-center rounded-md bg-muted">
          {icon}
        </span>
        {title}
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{text}</p>
    </article>
  )
}
