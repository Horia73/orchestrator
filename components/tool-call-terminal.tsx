"use client"

import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import type { ToolCallReasoningEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

type ParsedData = Record<string, unknown> | null

export const TERMINAL_MIN_WIDTH_CLASS = "min-w-[560px]"

export function LiveTerminal({
  entry,
  data,
  className,
}: {
  entry: ToolCallReasoningEntry
  data: ParsedData
  className?: string
}) {
  const streamText = React.useMemo(() => terminalText(entry, data), [entry, data])

  return (
    <TerminalOutput
      text={streamText}
      cursorBlink={entry.status === "running"}
      resetKey={entry.toolCallId || entry.id}
      className={className}
    />
  )
}

export function TerminalOutput({
  text,
  cursorBlink = false,
  resetKey,
  className,
}: {
  text: string
  cursorBlink?: boolean
  resetKey?: string
  className?: string
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const renderedTextRef = React.useRef("")
  const resetKeyRef = React.useRef(resetKey)

  React.useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      cursorStyle: "block",
      disableStdin: true,
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.22,
      scrollback: 8000,
      theme: {
        background: "#0c0c0e",
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        black: "#1f1f23",
        red: "#f87171",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fcd34d",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#fafafa",
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {}
    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
      renderedTextRef.current = ""
    }
  }, [])

  React.useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorBlink = cursorBlink
  }, [cursorBlink])

  React.useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (resetKeyRef.current !== resetKey || !text.startsWith(renderedTextRef.current)) {
      term.reset()
      renderedTextRef.current = ""
      resetKeyRef.current = resetKey
    }
    const next = text.slice(renderedTextRef.current.length)
    if (next) {
      term.write(next)
      renderedTextRef.current = text
    }
  }, [resetKey, text])

  React.useEffect(() => {
    const el = containerRef.current
    const fit = fitRef.current
    if (!el || !fit) return
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {}
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      className={cn("min-h-0 flex-1 px-2 py-2", className)}
    />
  )
}

function terminalText(entry: ToolCallReasoningEntry, data: ParsedData): string {
  const streamed = (entry.deltas ?? []).map((delta) => delta.text).join("")
  const command = stringArg(entry.args, "command")
  const commandPrefix = command && !terminalTextContainsCommand(streamed, command)
    ? `\x1b[2m$ ${command}\x1b[0m\r\n`
    : ""
  const output = stringField(data, "output") || stringField(data, "stdout")
  const stderr = stringField(data, "stderr")
  const exitCode = numberField(data, "exitCode") ?? numberField(data, "exit_code")
  const fallback = data ? "" : entry.content.replace(/^Error:\s*/, "")
  const finalText = `${output || fallback}${stderr ? `\r\n\x1b[31m${stderr}\x1b[0m` : ""}`
  const exitText = typeof exitCode === "number" && exitCode !== 0 ? `\r\n\x1b[2m(exit ${exitCode})\x1b[0m` : ""
  const tail = `${finalText}${exitText}`
  if (!streamed) return `${commandPrefix}${tail}`
  if (!tail.trim()) return `${commandPrefix}${streamed}`
  if (terminalTextIncludes(streamed, tail)) return `${commandPrefix}${streamed}`
  const appendedTail = finalText.trim() && terminalTextIncludes(streamed, finalText)
    ? exitText
    : tail
  if (!appendedTail.trim() || terminalTextIncludes(streamed, appendedTail)) {
    return `${commandPrefix}${streamed}`
  }
  return `${commandPrefix}${streamed}${streamed.endsWith("\n") || streamed.endsWith("\r") ? "" : "\r\n"}${appendedTail}`
}

function terminalTextContainsCommand(text: string, command: string): boolean {
  if (!text || !command) return false
  const normalized = normalizeTerminalText(text)
  return normalized.includes(`$ ${command}`) || normalized.includes(command)
}

function terminalTextIncludes(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeTerminalText(haystack)
  const normalizedNeedle = normalizeTerminalText(needle).trim()
  if (!normalizedNeedle) return true
  return normalizedHaystack.includes(normalizedNeedle)
}

function normalizeTerminalText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key]
  return typeof value === "string" ? value : ""
}

function stringField(data: unknown, key: string): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return ""
  const value = (data as Record<string, unknown>)[key]
  return typeof value === "string" ? value : ""
}

function numberField(data: unknown, key: string): number | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  const value = (data as Record<string, unknown>)[key]
  return typeof value === "number" ? value : undefined
}
