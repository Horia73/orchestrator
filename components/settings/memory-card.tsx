"use client"

import * as React from "react"
import {
  AlertTriangle,
  Brain,
  Check,
  Loader2,
  RefreshCcw,
  Search,
} from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { ModelPicker } from "@/components/settings/model-picker"

type ProviderId = "google" | "openai"

interface EmbeddingSettings {
  enabled: boolean
  provider: ProviderId
  model: string
  dim: number
  threshold: number
}

interface GenerationStat {
  model: string
  dim: number
  sources: number
  chunks: number
}

interface MemoryStatus {
  activeModel: string
  activeDim: number
  sources: number
  activeSources: number
  activeChunks: number
  needsIndexing: number
  generations: GenerationStat[]
}

interface ModelOption {
  provider: ProviderId
  model: string
  label: string
  dims: number[]
}

interface LibraryStatus {
  multimodal: boolean
  assetsOnDisk: number
  indexedActive: number
  needsIndexing: number
}

interface StatusResponse {
  settings: EmbeddingSettings
  status: MemoryStatus
  libraryStatus: LibraryStatus
  embeddingsAvailable: boolean
  activeThreshold: number
  thresholds: Record<string, number>
  providers: Record<ProviderId, boolean>
  options: ModelOption[]
}

interface SearchHit {
  source: string
  title: string
  text: string
  score: number
}

interface SearchResponse {
  rawHits: SearchHit[]
  automaticHits: SearchHit[]
  threshold: number
  topK: number
}

interface Form {
  enabled: boolean
  provider: ProviderId
  model: string
  dim: number
  threshold: number
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  google: "Google · Gemini",
  openai: "OpenAI",
}

function searchHitKey(hit: SearchHit): string {
  return `${hit.source}\n${hit.title}\n${hit.text}`
}

export function MemoryCard() {
  const [data, setData] = React.useState<StatusResponse | null>(null)
  const [form, setForm] = React.useState<Form | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [rebuilding, setRebuilding] = React.useState(false)
  const [savedAt, setSavedAt] = React.useState(0)

  const [query, setQuery] = React.useState("")
  const [searching, setSearching] = React.useState(false)
  const [searchResult, setSearchResult] = React.useState<SearchResponse | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/memory/status", { cache: "no-store" })
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      const json = (await res.json()) as StatusResponse
      setData(json)
      setForm((prev) =>
        prev ?? {
          enabled: json.settings.enabled,
          provider: json.settings.provider,
          model: json.settings.model,
          dim: json.settings.dim,
          threshold: json.activeThreshold,
        }
      )
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load memory status")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const dimOptions = React.useMemo(() => {
    if (!data || !form) return [768]
    return (
      data.options.find((o) => o.model === form.model)?.dims ?? [form.dim]
    )
  }, [data, form])

  const dirty = React.useMemo(() => {
    if (!data || !form) return false
    const s = data.settings
    return (
      form.enabled !== s.enabled ||
      form.provider !== s.provider ||
      form.model !== s.model ||
      form.dim !== s.dim ||
      Math.abs(form.threshold - data.activeThreshold) > 1e-9
    )
  }, [data, form])

  const thresholdFor = React.useCallback(
    (provider: ProviderId, model: string, dim: number): number | undefined => {
      return data?.thresholds[`${provider}:${model}:${dim}`]
    },
    [data]
  )

  // Selection comes from the shared ModelPicker (favorites/archive, grouped by
  // provider), filtered to embedding-kind models. Provider is derived from the
  // picked model's provider id.
  const onModelPicked = (providerId: string, model: string) => {
    const provider: ProviderId = providerId === "openai" ? "openai" : "google"
    setForm((f) => {
      if (!f || !data) return f
      const dims = data.options.find((o) => o.model === model)?.dims ?? [768]
      const dim = dims.includes(f.dim) ? f.dim : dims[0]
      return {
        ...f,
        provider,
        model,
        dim,
        threshold: thresholdFor(provider, model, dim) ?? f.threshold,
      }
    })
  }

  const onDimChange = (dim: number) => {
    setForm((f) =>
      f
        ? {
            ...f,
            dim,
            threshold: thresholdFor(f.provider, f.model, dim) ?? f.threshold,
          }
        : f
    )
  }

  const save = React.useCallback(async () => {
    if (!form) return
    setSaving(true)
    setError(null)
    try {
      const cfgRes = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memoryEmbedding: {
            enabled: form.enabled,
            provider: form.provider,
            model: form.model,
            dim: form.dim,
            threshold: form.threshold,
          },
        }),
      })
      if (!cfgRes.ok) {
        const j = await cfgRes.json().catch(() => ({}))
        throw new Error(j.error || `Save failed (${cfgRes.status})`)
      }
      // Persist the per-generation threshold for the now-active model.
      await fetch("/api/memory/threshold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: form.threshold }),
      }).catch(() => {})
      setSavedAt(Date.now())
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }, [form, load])

  const rebuild = React.useCallback(async () => {
    setRebuilding(true)
    setError(null)
    try {
      const res = await fetch("/api/memory/reindex", { method: "POST" })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || `Rebuild failed (${res.status})`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rebuild failed")
    } finally {
      setRebuilding(false)
    }
  }, [load])

  const runSearch = React.useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setError(null)
    try {
      const res = await fetch("/api/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, limit: 10 }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || `Search failed (${res.status})`)
      const rawHits = ((j.rawHits ?? j.hits ?? []) as SearchHit[])
      setSearchResult({
        rawHits,
        automaticHits: ((j.automaticHits ?? []) as SearchHit[]),
        threshold: typeof j.threshold === "number" ? j.threshold : form?.threshold ?? 0,
        topK: typeof j.topK === "number" ? j.topK : 4,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed")
    } finally {
      setSearching(false)
    }
  }, [form?.threshold, query])

  const status = data?.status
  const cachedGenerations = (status?.generations ?? []).filter(
    (g) => !(g.model === status?.activeModel && g.dim === status?.activeDim)
  )
  const providerHasKey = form ? data?.providers[form.provider] : false
  const automaticHitKeys = React.useMemo(
    () => new Set((searchResult?.automaticHits ?? []).map(searchHitKey)),
    [searchResult]
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-foreground/70" />
          <CardTitle className="text-[15px]">Memory (embeddings)</CardTitle>
        </div>
        <CardDescription>
          The embeddings backend that powers semantic recall (the automatic
          per-turn hint) and the <code>memory_search</code> tool. Changing the
          model is safe — older vectors stay on disk, so switching back is free;
          switching to a new one needs a one-time rebuild.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {loading || !form ? (
          <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
        ) : (
          <>
            {/* Enable */}
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-medium text-foreground/90">
                  Enable semantic recall
                </div>
                <div className="text-[12.5px] text-foreground/55">
                  Automatic per-turn recall + the memory_search tool.
                </div>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => (f ? { ...f, enabled: v } : f))}
                aria-label="Enable semantic recall"
              />
            </div>

            <Separator />

            {/* Embedding model (same picker as agents — favorites/archive —
                filtered to embedding-kind models) + dimensions */}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground/70">
                  Embedding model
                </label>
                <ModelPicker
                  value={`${form.provider}:${form.model}`}
                  onChange={({ providerId, modelId }) => onModelPicked(providerId, modelId)}
                  filterModel={(m) => (m.model.kinds ?? []).includes("embedding")}
                  disabled={!form.enabled}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium text-foreground/70">
                  Dimensions
                </label>
                <Select
                  value={String(form.dim)}
                  onValueChange={(v) => onDimChange(Number(v))}
                  options={dimOptions.map((d) => ({ value: String(d), label: `${d}` }))}
                  disabled={!form.enabled}
                />
              </div>
            </div>

            {form.model !== "gemini-embedding-2" && (
              <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[12.5px] text-foreground/60">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-foreground/40" />
                <span>
                  This model embeds <strong>text only</strong>. Semantic search
                  over Library <strong>images/PDFs</strong> needs a multimodal
                  model — pick <strong>Gemini Embedding 2</strong> for that.
                </span>
              </div>
            )}

            {!providerHasKey && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  No API key for {PROVIDER_LABELS[form.provider]}. Add it in
                  Settings Files — recall stays inactive until then.
                </span>
              </div>
            )}

            {/* Threshold */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground/70">
                Recall threshold ({form.threshold.toFixed(2)})
              </label>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={form.threshold}
                disabled={!form.enabled}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n)) {
                    setForm((f) =>
                      f ? { ...f, threshold: Math.min(1, Math.max(0, n)) } : f
                    )
                  }
                }}
                className="max-w-[140px]"
              />
              <p className="text-[12px] text-foreground/45">
                Higher = stricter. Stored per model, so switching models restores
                each one&apos;s tuned value. Use the test search below to
                calibrate.
              </p>
            </div>

            {/* Status */}
            {status && (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 text-[12.5px] text-foreground/70">
                <div>
                  Active:{" "}
                  <span className="font-medium text-foreground/85">
                    {status.activeModel}@{status.activeDim}
                  </span>{" "}
                  — {status.activeChunks} chunk(s) across {status.activeSources}/
                  {status.sources} source(s).
                </div>
                {status.needsIndexing > 0 && (
                  <div className="mt-1.5 flex items-start gap-2 text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {status.needsIndexing} source(s) not embedded for the active
                      model. Recall runs partial until you rebuild.
                    </span>
                  </div>
                )}
                {cachedGenerations.length > 0 && (
                  <div className="mt-1.5 text-foreground/50">
                    Cached (free to switch back):{" "}
                    {cachedGenerations.map((g) => `${g.model}@${g.dim}`).join(", ")}.
                  </div>
                )}
                {data?.libraryStatus && (
                  <div className="mt-1.5 border-t border-border/40 pt-1.5 text-foreground/55">
                    Library (images/PDFs):{" "}
                    {data.libraryStatus.multimodal ? (
                      <>
                        {data.libraryStatus.indexedActive}/
                        {data.libraryStatus.assetsOnDisk} indexed for{" "}
                        <code>library_search</code>.
                        {data.libraryStatus.needsIndexing > 0 &&
                          " Rebuild to index the rest."}
                      </>
                    ) : (
                      <>not indexed — needs a multimodal model (Gemini Embedding 2).</>
                    )}
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={save} disabled={!dirty || saving} size="sm">
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : savedAt && !dirty ? (
                  <Check className="size-3.5" />
                ) : null}
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                onClick={rebuild}
                disabled={rebuilding || !data?.embeddingsAvailable}
                variant="outline"
                size="sm"
              >
                {rebuilding ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCcw className="size-3.5" />
                )}
                {rebuilding ? "Rebuilding…" : "Rebuild index"}
              </Button>
              {dirty && (
                <span className="text-[12px] text-foreground/45">
                  Unsaved changes
                </span>
              )}
            </div>

            <Separator />

            {/* Dry-run calibration search */}
            <div className="flex flex-col gap-2">
              <label className="text-[12.5px] font-medium text-foreground/70">
                Test search (raw scores + automatic recall)
              </label>
              <div className="flex gap-2">
                <Input
                  value={query}
                  placeholder="Type a query to see what recall would match + scores…"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runSearch()
                  }}
                  disabled={!data?.embeddingsAvailable}
                />
                <Button
                  onClick={runSearch}
                  disabled={searching || !query.trim() || !data?.embeddingsAvailable}
                  variant="outline"
                  size="sm"
                >
                  {searching ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Search className="size-3.5" />
                  )}
                  Search
                </Button>
              </div>
              {searchResult && (
                <div className="flex flex-col gap-2">
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                    <div className="flex items-center justify-between gap-2 text-[12.5px] font-medium text-foreground/75">
                      <span>Automatic recall preview</span>
                      <span className="shrink-0 text-foreground/45">
                        threshold {searchResult.threshold.toFixed(2)} · top {searchResult.topK}
                      </span>
                    </div>
                    {searchResult.automaticHits.length === 0 ? (
                      <p className="mt-1 text-[12.5px] text-foreground/45">
                        Nothing would be injected for this message.
                      </p>
                    ) : (
                      <div className="mt-2 flex flex-col gap-1.5">
                        {searchResult.automaticHits.map((h, i) => (
                          <div
                            key={`${h.source}-${i}`}
                            className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5 text-[12.5px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-foreground/65">
                                {h.title || h.source}
                              </span>
                              <span className="shrink-0 font-medium text-emerald-700 tabular-nums dark:text-emerald-500">
                                {h.score.toFixed(3)}
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-foreground/75">
                              {h.text}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="text-[12.5px] font-medium text-foreground/60">
                      Raw score distribution
                    </div>
                    {searchResult.rawHits.length === 0 ? (
                      <p className="text-[12.5px] text-foreground/45">No matches.</p>
                    ) : (
                      searchResult.rawHits.map((h, i) => {
                        const auto = automaticHitKeys.has(searchHitKey(h))
                        const above = h.score >= searchResult.threshold
                        return (
                          <div
                            key={`${h.source}-${i}`}
                            className="rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-[12.5px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-foreground/60">
                                {h.title || h.source}
                              </span>
                              <span
                                className={
                                  auto
                                    ? "shrink-0 font-medium text-emerald-700 tabular-nums dark:text-emerald-500"
                                    : above
                                      ? "shrink-0 text-amber-700 tabular-nums dark:text-amber-400"
                                      : "shrink-0 text-foreground/40 tabular-nums"
                                }
                              >
                                {h.score.toFixed(3)}
                                {auto ? " auto" : above ? " gated" : ""}
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-foreground/75">
                              {h.text}
                            </p>
                          </div>
                        )
                      })
                    )}
                    <p className="text-[12px] text-foreground/40">
                      <span className="font-medium text-emerald-700 dark:text-emerald-500">
                        auto
                      </span>{" "}
                      = would be injected.{" "}
                      <span className="text-amber-700 dark:text-amber-400">
                        gated
                      </span>{" "}
                      = above threshold but excluded by context, dedup, or coverage.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
