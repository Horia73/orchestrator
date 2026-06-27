import fs from "fs"
import os from "os"
import path from "path"

import { emitAppEvent } from "@/lib/events"
import { activeRuntimePaths } from "@/lib/runtime-paths"
import {
  parseEnvAssignment,
  syncWorkspaceEnvToProcess,
} from "@/lib/settings/workspace-files-env"

export const LM_STUDIO_BASE_URL_ENV = "LM_STUDIO_BASE_URL"
export const LM_STUDIO_API_KEY_ENV = "LM_STUDIO_API_KEY"
export const LM_STUDIO_DEFAULT_PORT = 1234
export const LM_STUDIO_DEFAULT_CONTEXT_TOKENS = 100_000

const DEFAULT_HEALTH_TIMEOUT_MS = 1200
const DEFAULT_SCAN_TIMEOUT_MS = 650
const DEFAULT_SCAN_CONCURRENCY = 32
const MAX_SCAN_CANDIDATES = 768
const COMMON_HOME_LAN_PREFIXES = ["192.168.0", "192.168.1"]

export function normalizeLMStudioBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`${LM_STUDIO_BASE_URL_ENV} is empty.`)

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  const url = new URL(withProtocol)
  const pathname = url.pathname.replace(/\/+$/, "")
  url.pathname =
    pathname === "" || pathname === "/"
      ? "/v1"
      : pathname.endsWith("/v1")
        ? pathname
        : `${pathname}/v1`
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/+$/, "")
}

export function lmStudioChatCompletionsUrl(baseUrl: string): string {
  return `${normalizeLMStudioBaseUrl(baseUrl)}/chat/completions`
}

export function lmStudioNativeModelsUrl(baseUrl: string): string {
  const url = new URL(normalizeLMStudioBaseUrl(baseUrl))
  url.pathname = "/api/v1/models"
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function lmStudioJsonHeaders(apiKey?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
  return headers
}

export interface LMStudioHealth {
  baseUrl: string
  online: boolean
  checkedAt: number
  latencyMs: number | null
  modelCount: number | null
  models: string[]
  endpoint: "native" | "openai" | null
  error: string | null
}

export interface LMStudioStatus extends LMStudioHealth {
  configured: boolean
  apiKeyConfigured: boolean
}

export interface LMStudioScanResult extends LMStudioHealth {
  host: string
}

interface LMStudioNativeLoadedInstance {
  id: string
  config?: {
    context_length?: number
  }
}

interface LMStudioNativeModel {
  id?: string
  key?: string
  selected_variant?: string
  type?: string
  max_context_length?: number | null
  loaded_instances?: LMStudioNativeLoadedInstance[]
}

interface LMStudioNativeList {
  models?: LMStudioNativeModel[]
  data?: LMStudioNativeModel[]
}

export interface LMStudioLoadResult {
  managed: boolean
  model: string
  alreadyLoaded: boolean
  unloaded: string[]
  loadedInstanceId: string | null
  contextLength: number | null
  error?: string
}

const lmStudioLoadQueues = new Map<string, Promise<void>>()

export async function checkLMStudioServer(
  rawBaseUrl: string,
  apiKey?: string | null,
  options?: { timeoutMs?: number }
): Promise<LMStudioHealth> {
  const checkedAt = Date.now()
  let baseUrl: string
  try {
    baseUrl = normalizeLMStudioBaseUrl(rawBaseUrl)
  } catch (err) {
    return {
      baseUrl: rawBaseUrl.trim(),
      online: false,
      checkedAt,
      latencyMs: null,
      modelCount: null,
      models: [],
      endpoint: null,
      error: err instanceof Error ? err.message : "Invalid LM Studio URL.",
    }
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const native = await fetchLMStudioModelIds(lmStudioNativeModelsUrl(baseUrl), apiKey, timeoutMs)
  if (native.ok) {
    return {
      baseUrl,
      online: true,
      checkedAt,
      latencyMs: native.latencyMs,
      modelCount: native.models.length,
      models: native.models.slice(0, 8),
      endpoint: "native",
      error: null,
    }
  }

  const openai = await fetchLMStudioModelIds(`${baseUrl}/models`, apiKey, timeoutMs)
  if (openai.ok) {
    return {
      baseUrl,
      online: true,
      checkedAt,
      latencyMs: openai.latencyMs,
      modelCount: openai.models.length,
      models: openai.models.slice(0, 8),
      endpoint: "openai",
      error: null,
    }
  }

  return {
    baseUrl,
    online: false,
    checkedAt,
    latencyMs: null,
    modelCount: null,
    models: [],
    endpoint: null,
    error: `${native.error}; ${openai.error}`,
  }
}

export async function scanForLMStudioServers(options?: {
  apiKey?: string | null
  includeBaseUrl?: string | null
  timeoutMs?: number
  concurrency?: number
}): Promise<LMStudioScanResult[]> {
  const candidates = lmStudioScanCandidates(options?.includeBaseUrl)
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? DEFAULT_SCAN_CONCURRENCY, 64))
  const results: LMStudioScanResult[] = []
  let index = 0

  async function worker() {
    while (index < candidates.length) {
      const candidate = candidates[index++]
      const health = await checkLMStudioServer(candidate, options?.apiKey, { timeoutMs })
      if (health.online) {
        results.push({
          ...health,
          host: hostLabel(candidate),
        })
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker())
  )

  return results
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
    .slice(0, 24)
}

export function lmStudioScanCandidates(includeBaseUrl?: string | null): string[] {
  const out: string[] = []
  const add = (value: string | null | undefined) => {
    if (!value?.trim()) return
    try {
      out.push(normalizeLMStudioBaseUrl(value))
    } catch {
      // A manually typed candidate can be invalid; scan should still proceed.
    }
  }

  add(includeBaseUrl)
  add(`http://127.0.0.1:${LM_STUDIO_DEFAULT_PORT}/v1`)
  add(`http://localhost:${LM_STUDIO_DEFAULT_PORT}/v1`)
  add(`http://host.docker.internal:${LM_STUDIO_DEFAULT_PORT}/v1`)

  for (const prefix of COMMON_HOME_LAN_PREFIXES) {
    for (let last = 1; last <= 254; last++) {
      add(`http://${prefix}.${last}:${LM_STUDIO_DEFAULT_PORT}/v1`)
      if (out.length >= MAX_SCAN_CANDIDATES) break
    }
    if (out.length >= MAX_SCAN_CANDIDATES) break
  }

  for (const ip of privateInterfaceIPv4s()) {
    add(`http://${ip}:${LM_STUDIO_DEFAULT_PORT}/v1`)
    const prefix = ip.split(".").slice(0, 3).join(".")
    for (let last = 1; last <= 254; last++) {
      const candidate = `${prefix}.${last}`
      if (candidate === ip) continue
      add(`http://${candidate}:${LM_STUDIO_DEFAULT_PORT}/v1`)
      if (out.length >= MAX_SCAN_CANDIDATES) break
    }
    if (out.length >= MAX_SCAN_CANDIDATES) break
  }

  return Array.from(new Set(out)).slice(0, MAX_SCAN_CANDIDATES)
}

export async function ensureLMStudioModelLoaded(
  rawBaseUrl: string,
  modelId: string,
  apiKey?: string | null,
  options?: {
    contextLength?: number | null
    autoUnload?: boolean
    timeoutMs?: number
  }
): Promise<LMStudioLoadResult> {
  const baseUrl = normalizeLMStudioBaseUrl(rawBaseUrl)
  return enqueueLMStudioLoad(baseUrl, async () => {
    const timeoutMs = options?.timeoutMs ?? 120_000
    const autoUnload = options?.autoUnload ?? process.env.LM_STUDIO_AUTO_UNLOAD !== "false"
    const desiredContext = positiveInt(options?.contextLength ?? undefined)
    const listed = await fetchLMStudioNativeModelList(baseUrl, apiKey, Math.min(timeoutMs, 10_000))
    if (!listed.ok) {
      return {
        managed: false,
        model: modelId,
        alreadyLoaded: false,
        unloaded: [],
        loadedInstanceId: null,
        contextLength: desiredContext ?? null,
        error: listed.error,
      }
    }

    const target = listed.models.find(model => lmStudioNativeModelMatches(model, modelId))
    if (!target) {
      throw new Error(`LM Studio model ${modelId} was not found in /api/v1/models. Refresh models from Settings, then try again.`)
    }

    const targetInstances = target.loaded_instances ?? []
    const hasSuitableTargetInstance = targetInstances.some(instance => {
      const loadedContext = positiveInt(instance.config?.context_length)
      return !desiredContext || !loadedContext || loadedContext >= desiredContext
    })
    const needsReloadForContext = targetInstances.length > 0 && !hasSuitableTargetInstance
    const instancesToUnload = autoUnload
      ? listed.models.flatMap(model => {
          const isTarget = lmStudioNativeModelMatches(model, modelId)
          if (isTarget && !needsReloadForContext) return []
          if (!isLMStudioLlmModel(model)) return []
          return (model.loaded_instances ?? []).map(instance => instance.id).filter(Boolean)
        })
      : []
    const unloaded: string[] = []
    for (const instanceId of instancesToUnload) {
      await postLMStudioJson(`${lmStudioNativeModelsApiBaseUrl(baseUrl)}/unload`, apiKey, {
        instance_id: instanceId,
      }, Math.min(timeoutMs, 30_000))
      unloaded.push(instanceId)
    }

    if (hasSuitableTargetInstance && !needsReloadForContext) {
      return {
        managed: true,
        model: modelId,
        alreadyLoaded: true,
        unloaded,
        loadedInstanceId: targetInstances[0]?.id ?? null,
        contextLength: positiveInt(targetInstances[0]?.config?.context_length) ?? desiredContext ?? null,
      }
    }

    const loadBody: Record<string, unknown> = {
      model: lmStudioNativeModelLoadId(target) ?? modelId,
      echo_load_config: true,
    }
    const maxContext = positiveInt(target.max_context_length ?? undefined)
    const contextLength = desiredContext
      ? maxContext ? Math.min(desiredContext, maxContext) : desiredContext
      : null
    if (contextLength) loadBody.context_length = contextLength

    const loaded = await postLMStudioJson(`${lmStudioNativeModelsApiBaseUrl(baseUrl)}/load`, apiKey, loadBody, timeoutMs)
    const loadedObject = loaded && typeof loaded === "object" && !Array.isArray(loaded)
      ? loaded as Record<string, unknown>
      : {}
    return {
      managed: true,
      model: modelId,
      alreadyLoaded: false,
      unloaded,
      loadedInstanceId: typeof loadedObject.instance_id === "string" ? loadedObject.instance_id : null,
      contextLength: positiveInt(objectValue(loadedObject.load_config)?.context_length) ?? contextLength,
    }
  })
}

export function saveLMStudioConfig(input: {
  baseUrl: string
  apiKey?: string | null
}): string {
  const baseUrl = normalizeLMStudioBaseUrl(input.baseUrl)
  patchWorkspaceEnvValues({
    [LM_STUDIO_BASE_URL_ENV]: baseUrl,
    ...(input.apiKey !== undefined
      ? { [LM_STUDIO_API_KEY_ENV]: input.apiKey ?? "" }
      : {}),
  })
  return baseUrl
}

export function clearLMStudioConfig(): void {
  patchWorkspaceEnvValues({
    [LM_STUDIO_BASE_URL_ENV]: "",
    [LM_STUDIO_API_KEY_ENV]: "",
  })
}

function patchWorkspaceEnvValues(values: Record<string, string>): void {
  const envPath = activeRuntimePaths().workspaceEnvPath
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : ""
  const keys = new Set(Object.keys(values))
  const replaced = new Set<string>()
  const kept: string[] = []

  for (const line of existing.replace(/\r\n/g, "\n").split("\n")) {
    const parsed = parseEnvAssignment(line)
    if (parsed && keys.has(parsed.key)) {
      const value = values[parsed.key]?.trim() ?? ""
      if (value) kept.push(`${parsed.key}=${formatEnvValue(value)}`)
      replaced.add(parsed.key)
      continue
    }
    if (line.trim()) kept.push(line)
  }

  for (const [key, rawValue] of Object.entries(values)) {
    if (replaced.has(key)) continue
    const value = rawValue.trim()
    if (value) kept.push(`${key}=${formatEnvValue(value)}`)
  }

  const next = `${kept.join("\n")}${kept.length ? "\n" : ""}`
  fs.writeFileSync(envPath, next, { encoding: "utf-8", mode: 0o600 })
  try {
    fs.chmodSync(envPath, 0o600)
  } catch {
    // Best effort on platforms without chmod.
  }
  syncWorkspaceEnvToProcess(existing, next)
  emitAppEvent({ type: "settings.changed", reason: "env" })
}

async function fetchLMStudioModelIds(
  url: string,
  apiKey: string | null | undefined,
  timeoutMs: number
): Promise<{ ok: true; models: string[]; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: lmStudioJsonHeaders(apiKey),
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, error: `${url} returned ${res.status}` }
    }
    const json = await res.json().catch(() => null)
    const data =
      json && typeof json === "object" && "data" in json
        ? (json as { data?: unknown }).data
        : json && typeof json === "object" && "models" in json
          ? (json as { models?: unknown }).models
          : null
    const rows = Array.isArray(data) ? data : []
    const models = rows
      .map((row) => {
        if (!row || typeof row !== "object") return null
        const obj = row as { id?: unknown; key?: unknown }
        return typeof obj.id === "string" ? obj.id : obj.key
      })
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    return { ok: true, models, latencyMs: Date.now() - started }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    return {
      ok: false,
      error: aborted
        ? `${url} timed out after ${timeoutMs}ms`
        : `${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function privateInterfaceIPv4s(): string[] {
  const ips: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue
      if (!isPrivateIPv4(entry.address)) continue
      ips.push(entry.address)
    }
  }
  return Array.from(new Set(ips))
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(normalizeLMStudioBaseUrl(baseUrl)).host
  } catch {
    return baseUrl
  }
}

function lmStudioNativeModelsApiBaseUrl(baseUrl: string): string {
  const url = new URL(normalizeLMStudioBaseUrl(baseUrl))
  url.pathname = "/api/v1/models"
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/+$/, "")
}

async function fetchLMStudioNativeModelList(
  baseUrl: string,
  apiKey: string | null | undefined,
  timeoutMs: number
): Promise<{ ok: true; models: LMStudioNativeModel[] } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(lmStudioNativeModelsUrl(baseUrl), {
      headers: lmStudioJsonHeaders(apiKey),
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, error: `/api/v1/models returned ${res.status}` }
    }
    const json = await res.json().catch(() => null) as LMStudioNativeList | null
    const rows = Array.isArray(json?.models)
      ? json.models
      : Array.isArray(json?.data)
        ? json.data
        : null
    if (!rows) return { ok: false, error: "/api/v1/models response did not include models." }
    return { ok: true, models: rows.filter(isObject) }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    return {
      ok: false,
      error: aborted
        ? `/api/v1/models timed out after ${timeoutMs}ms`
        : `/api/v1/models failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function postLMStudioJson(
  url: string,
  apiKey: string | null | undefined,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: lmStudioJsonHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`${url} returned ${res.status}: ${await res.text().catch(() => "")}`)
    }
    return await res.json().catch(() => null)
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${url} timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

function enqueueLMStudioLoad<T>(baseUrl: string, task: () => Promise<T>): Promise<T> {
  const previous = lmStudioLoadQueues.get(baseUrl) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(task)
  const settled = run.then(() => undefined, () => undefined)
  lmStudioLoadQueues.set(baseUrl, settled)
  void settled.finally(() => {
    if (lmStudioLoadQueues.get(baseUrl) === settled) lmStudioLoadQueues.delete(baseUrl)
  })
  return run
}

function lmStudioNativeModelMatches(model: LMStudioNativeModel, modelId: string): boolean {
  return [
    model.key,
    model.id,
    model.selected_variant,
  ].some(value => value === modelId)
}

function lmStudioNativeModelLoadId(model: LMStudioNativeModel): string | null {
  return model.key ?? model.id ?? model.selected_variant ?? null
}

function isLMStudioLlmModel(model: LMStudioNativeModel): boolean {
  const type = model.type?.toLowerCase()
  return !type || type === "llm" || type === "model" || type === "chat"
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isObject(value: unknown): value is LMStudioNativeModel {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function formatEnvValue(value: string): string {
  if (/[\s#"']/.test(value)) return `"${value.replace(/"/g, '\\"')}"`
  return value
}
