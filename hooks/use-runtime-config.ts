"use client"

import * as React from "react"
import { useAppEvent } from "@/hooks/use-app-events"

export interface RuntimeNameConfig {
  assistantName: string
  userName: string
  updatedAt?: number
}

const DEFAULT_CONFIG: RuntimeNameConfig = {
  assistantName: "Orchestrator",
  userName: "User",
}

let cachedConfig: RuntimeNameConfig | null = null
const listeners = new Set<() => void>()

function normalizeConfig(raw: unknown): RuntimeNameConfig {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const assistantName = typeof data.assistantName === "string" && data.assistantName.trim()
    ? data.assistantName.trim()
    : DEFAULT_CONFIG.assistantName
  const userName = typeof data.userName === "string" && data.userName.trim()
    ? data.userName.trim()
    : DEFAULT_CONFIG.userName
  const updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : undefined
  return { assistantName, userName, updatedAt }
}

function publish(next: RuntimeNameConfig) {
  const current = cachedConfig
  if (
    current &&
    current.assistantName === next.assistantName &&
    current.userName === next.userName &&
    current.updatedAt === next.updatedAt
  ) {
    return
  }
  cachedConfig = next
  for (const listener of listeners) listener()
}

async function fetchRuntimeConfig(signal?: AbortSignal) {
  const res = await fetch("/api/config", { cache: "no-store", signal })
  if (!res.ok) throw new Error(`Failed to load config (${res.status})`)
  publish(normalizeConfig(await res.json()))
}

export function refreshRuntimeConfig() {
  void fetchRuntimeConfig().catch(() => {
    // Surfaces keep the last known value. Config refresh should not break chat.
  })
}

export function useRuntimeConfig(): RuntimeNameConfig {
  const [config, setConfig] = React.useState<RuntimeNameConfig>(() => cachedConfig ?? DEFAULT_CONFIG)

  useAppEvent(["config.updated"], () => {
    refreshRuntimeConfig()
  })

  React.useEffect(() => {
    const listener = () => setConfig(cachedConfig ?? DEFAULT_CONFIG)
    listeners.add(listener)

    const controller = new AbortController()
    void fetchRuntimeConfig(controller.signal).catch(() => {
      if (!controller.signal.aborted) setConfig(cachedConfig ?? DEFAULT_CONFIG)
    })

    const onFocus = () => refreshRuntimeConfig()
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshRuntimeConfig()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("orchestrator:config-updated", onFocus)

    return () => {
      controller.abort()
      listeners.delete(listener)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("orchestrator:config-updated", onFocus)
    }
  }, [])

  React.useEffect(() => {
    document.title = config.assistantName || DEFAULT_CONFIG.assistantName
  }, [config.assistantName])

  return config
}

export function displayUserName(userName: string): string {
  const trimmed = userName.trim()
  if (!trimmed || trimmed.toLowerCase() === "user") return ""
  return trimmed
}
