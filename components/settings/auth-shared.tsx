"use client"

import * as React from "react"
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  ExternalLink,
} from "lucide-react"

import { copyTextToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import type { NoticeTone } from "./auth-types"

export function ConfigInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: "text" | "password"
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[11.5px] font-medium text-foreground/60">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 rounded-lg border border-border bg-background px-2.5 text-[12px] text-foreground transition-colors outline-none placeholder:text-foreground/35 focus:border-ring"
      />
    </label>
  )
}

export function CopyableCode({
  value,
  openable = false,
}: {
  value: string
  openable?: boolean
}) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    if (!(await copyTextToClipboard(value))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={copy}
        className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-left font-mono text-[11.5px] text-foreground/80 transition-colors hover:bg-muted/80"
        title={copied ? "Copied" : "Click to copy"}
      >
        {value}
      </button>
      <button
        type="button"
        onClick={copy}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
        title={copied ? "Copied" : "Copy redirect URI"}
      >
        <Clipboard className="size-3.5" />
      </button>
      {openable && (
        <button
          type="button"
          onClick={() => window.open(value, "_blank", "noopener,noreferrer")}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
          title="Open URI"
        >
          <ExternalLink className="size-3.5" />
        </button>
      )}
    </span>
  )
}

export function InlineNotice({
  tone,
  text,
}: {
  tone: NoticeTone
  text: string
}) {
  const success = tone === "success"
  const warning = tone === "warning"
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px]",
        success
          ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
          : warning
            ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
            : "border-destructive/30 bg-destructive/5 text-destructive"
      )}
    >
      {success ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      )}
      <p>{text}</p>
    </div>
  )
}

export function Badge({
  tone,
  icon,
  children,
}: {
  tone: "success" | "warn" | "muted"
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const cls =
    tone === "success"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : tone === "warn"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "bg-muted text-foreground/55"
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap",
        cls
      )}
    >
      {icon}
      {children}
    </span>
  )
}

export function GuideLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-foreground/75 underline underline-offset-2 hover:text-foreground"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  )
}
