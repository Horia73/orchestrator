"use client"

import * as React from "react"
import {
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RotateCw,
  Trash2,
  Webhook,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { cn } from "@/lib/utils"
import { useAppEvent } from "@/hooks/use-app-events"

import { asError, formatPast, useNow } from "./helpers"
import type {
  MicroscriptRow,
  WebhookAuthMode,
  WebhookDispatch,
  WebhookEndpoint,
  WebhookEvent,
  WebhookSubscription,
} from "./types"

const AUTH_OPTIONS = [
  { value: "bearer", label: "Bearer secret" },
  { value: "hmac", label: "HMAC SHA-256" },
  { value: "svix", label: "Svix / Standard Webhooks" },
  { value: "none", label: "No auth" },
]

interface CreateEndpointForm {
  title: string
  slug: string
  description: string
  source: string
  defaultEventType: string
  authMode: WebhookAuthMode
  enabled: boolean
  rateLimitPerMinute: string
  retentionDays: string
  hmacToleranceSeconds: string
}

const DEFAULT_CREATE_FORM: CreateEndpointForm = {
  title: "",
  slug: "",
  description: "",
  source: "",
  defaultEventType: "",
  authMode: "bearer",
  enabled: true,
  rateLimitPerMinute: "120",
  retentionDays: "30",
  hmacToleranceSeconds: "300",
}

interface SubscriptionForm {
  targetId: string
  eventType: string
  payloadPath: string
  payloadEquals: string
}

const DEFAULT_SUBSCRIPTION_FORM: SubscriptionForm = {
  targetId: "",
  eventType: "",
  payloadPath: "",
  payloadEquals: "",
}

export function WebhooksTab({
  microscripts,
}: {
  microscripts: MicroscriptRow[]
}) {
  const [endpoints, setEndpoints] = React.useState<WebhookEndpoint[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [selectedEndpoint, setSelectedEndpoint] =
    React.useState<WebhookEndpoint | null>(null)
  const [subscriptions, setSubscriptions] = React.useState<
    WebhookSubscription[]
  >([])
  const [events, setEvents] = React.useState<WebhookEvent[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadingDetail, setLoadingDetail] = React.useState(false)
  const [loadingEvents, setLoadingEvents] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [showCreate, setShowCreate] = React.useState(false)
  const [createForm, setCreateForm] =
    React.useState<CreateEndpointForm>(DEFAULT_CREATE_FORM)
  const [slugTouched, setSlugTouched] = React.useState(false)
  const [createdSecret, setCreatedSecret] = React.useState<{
    endpointId: string
    secret: string
  } | null>(null)
  const [busyEndpointIds, setBusyEndpointIds] = React.useState<Set<string>>(
    new Set()
  )
  const [busySubscriptionIds, setBusySubscriptionIds] = React.useState<
    Set<string>
  >(new Set())

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/webhooks", { cache: "no-store" })
      if (!res.ok) throw new Error(await asError(res))
      const data = (await res.json()) as { endpoints: WebhookEndpoint[] }
      setEndpoints(data.endpoints)
      setError(null)
      setSelectedId((current) => {
        if (!current) return current
        return data.endpoints.some((endpoint) => endpoint.id === current)
          ? current
          : null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks")
    }
  }, [])

  const fetchDetail = React.useCallback(async (endpointId: string) => {
    setLoadingDetail(true)
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(endpointId)}`,
        {
          cache: "no-store",
        }
      )
      if (!res.ok) throw new Error(await asError(res))
      const data = (await res.json()) as {
        endpoint: WebhookEndpoint
        subscriptions: WebhookSubscription[]
      }
      setSelectedEndpoint(data.endpoint)
      setSubscriptions(data.subscriptions)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhook")
      setSelectedEndpoint(null)
      setSubscriptions([])
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  const fetchEvents = React.useCallback(async (endpointId: string) => {
    setLoadingEvents(true)
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(endpointId)}/events?dispatches=1&limit=80`,
        { cache: "no-store" }
      )
      if (!res.ok) throw new Error(await asError(res))
      const data = (await res.json()) as { events: WebhookEvent[] }
      setEvents(data.events)
    } catch (err) {
      console.warn("Failed to load webhook events", err)
    } finally {
      setLoadingEvents(false)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [refresh])

  React.useEffect(() => {
    if (!selectedId) {
      setSelectedEndpoint(null)
      setSubscriptions([])
      setEvents([])
      return
    }
    void fetchDetail(selectedId)
    void fetchEvents(selectedId)
  }, [selectedId, fetchDetail, fetchEvents])

  useAppEvent(["webhooks.changed", "webhook_events.changed"], (event) => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return
    }
    const endpointId =
      (event as { endpointId?: string }).endpointId === undefined
        ? null
        : (event as { endpointId?: string }).endpointId
    const reason =
      typeof (event as { reason?: unknown }).reason === "string"
        ? (event as { reason: string }).reason
        : null
    if (selectedId && endpointId === selectedId && reason === "deleted") {
      setSelectedId(null)
      setSelectedEndpoint(null)
      setSubscriptions([])
      setEvents([])
      setError(null)
      void refresh()
      return
    }
    void refresh()
    if (selectedId && (endpointId === null || endpointId === selectedId)) {
      void fetchDetail(selectedId)
      void fetchEvents(selectedId)
    }
  })

  const createEndpoint = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setError(null)
      try {
        const body = {
          title: createForm.title.trim(),
          slug: createForm.slug.trim(),
          description: blankToUndefined(createForm.description),
          source: blankToUndefined(createForm.source),
          defaultEventType: blankToUndefined(createForm.defaultEventType),
          authMode: createForm.authMode,
          enabled: createForm.enabled,
          rateLimitPerMinute: numberOrDefault(
            createForm.rateLimitPerMinute,
            120
          ),
          retentionDays: numberOrDefault(createForm.retentionDays, 30),
          hmacToleranceSeconds: numberOrDefault(
            createForm.hmacToleranceSeconds,
            300
          ),
        }
        const res = await fetch("/api/webhooks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(await asError(res))
        const data = (await res.json()) as {
          endpoint: WebhookEndpoint
          secret?: string
        }
        setCreateForm(DEFAULT_CREATE_FORM)
        setSlugTouched(false)
        setShowCreate(false)
        setSelectedId(data.endpoint.id)
        setCreatedSecret(
          data.secret
            ? { endpointId: data.endpoint.id, secret: data.secret }
            : null
        )
        await refresh()
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create webhook"
        )
      }
    },
    [createForm, refresh]
  )

  const updateEndpointEnabled = React.useCallback(
    async (endpointId: string, enabled: boolean) => {
      setBusyEndpointIds((prev) => new Set(prev).add(endpointId))
      try {
        const res = await fetch(
          `/api/webhooks/${encodeURIComponent(endpointId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
          }
        )
        if (!res.ok) throw new Error(await asError(res))
        await refresh()
        if (selectedId === endpointId) await fetchDetail(endpointId)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed")
      } finally {
        setBusyEndpointIds((prev) => {
          const next = new Set(prev)
          next.delete(endpointId)
          return next
        })
      }
    },
    [fetchDetail, refresh, selectedId]
  )

  const activeCount = endpoints.filter((endpoint) => endpoint.enabled).length
  const erroredCount = events.filter((event) => event.status === "error").length

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-border/60 px-4 py-3 text-[12px] text-foreground/65 md:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                loading ? "bg-foreground/30" : "bg-emerald-500"
              )}
            />
            <span className="font-semibold text-foreground">Webhooks</span>
            <span>
              {loading ? "loading..." : `${activeCount} active endpoint(s)`}
            </span>
          </div>
          <span>{endpoints.length} total</span>
          {selectedEndpoint && (
            <span>{subscriptions.length} subscription(s)</span>
          )}
          {selectedEndpoint && <span>{events.length} recent event(s)</span>}
          {selectedEndpoint && erroredCount > 0 && (
            <span className="text-[#802020]">{erroredCount} errored</span>
          )}
        </div>
      </div>

      {error && (
        <div className="border-b border-border/60 bg-red-50 px-5 py-2 text-[12px] text-[#802020] dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3",
            selectedEndpoint &&
              "hidden md:block md:max-w-[420px] md:border-r md:border-border/60"
          )}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-[12px] font-semibold tracking-wider text-foreground/45 uppercase">
              Endpoints
            </div>
            <Button
              type="button"
              size="sm"
              variant={showCreate ? "secondary" : "outline"}
              onClick={() => setShowCreate((open) => !open)}
            >
              <Plus className="size-3.5" />
              New
            </Button>
          </div>

          {showCreate && (
            <CreateEndpointForm
              form={createForm}
              onChange={(patch) =>
                setCreateForm((current) => ({ ...current, ...patch }))
              }
              onTitleChange={(title) => {
                setCreateForm((current) => ({
                  ...current,
                  title,
                  slug: slugTouched ? current.slug : slugify(title),
                }))
              }}
              onSlugChange={(slug) => {
                setSlugTouched(true)
                setCreateForm((current) => ({ ...current, slug }))
              }}
              onSubmit={createEndpoint}
            />
          )}

          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="size-4 animate-spin text-foreground/40" />
            </div>
          ) : endpoints.length === 0 ? (
            <div className="mx-auto max-w-md py-10 text-center">
              <Webhook className="mx-auto mb-3 size-8 text-foreground/30" />
              <h2 className="text-[15px] font-semibold text-foreground">
                No webhooks yet
              </h2>
              <p className="mt-2 text-[13px] text-foreground/60">
                Create an endpoint to receive JSON events, persist them, and
                dispatch matching events into microscripts.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {endpoints.map((endpoint) => (
                <li key={endpoint.id}>
                  <WebhookEndpointCard
                    endpoint={endpoint}
                    selected={selectedId === endpoint.id}
                    busy={busyEndpointIds.has(endpoint.id)}
                    onSelect={() => setSelectedId(endpoint.id)}
                    onToggleEnabled={(enabled) =>
                      updateEndpointEnabled(endpoint.id, enabled)
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {selectedEndpoint && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <WebhookDetailPanel
              endpoint={selectedEndpoint}
              subscriptions={subscriptions}
              events={events}
              microscripts={microscripts}
              loading={loadingDetail}
              loadingEvents={loadingEvents}
              createdSecret={
                createdSecret?.endpointId === selectedEndpoint.id
                  ? createdSecret.secret
                  : null
              }
              busyEndpoint={busyEndpointIds.has(selectedEndpoint.id)}
              busySubscriptionIds={busySubscriptionIds}
              onClose={() => setSelectedId(null)}
              onBack={() => setSelectedId(null)}
              onDeleted={() => {
                setSelectedId(null)
                setSelectedEndpoint(null)
                setSubscriptions([])
                setEvents([])
                setError(null)
                void refresh()
              }}
              onSecretConsumed={() => setCreatedSecret(null)}
              onError={setError}
              onRefresh={() => {
                void refresh()
                void fetchDetail(selectedEndpoint.id)
                void fetchEvents(selectedEndpoint.id)
              }}
              onEndpointEnabled={(enabled) =>
                updateEndpointEnabled(selectedEndpoint.id, enabled)
              }
              setBusyEndpointIds={setBusyEndpointIds}
              setBusySubscriptionIds={setBusySubscriptionIds}
              setCreatedSecret={(secret) =>
                setCreatedSecret({ endpointId: selectedEndpoint.id, secret })
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}

function CreateEndpointForm({
  form,
  onChange,
  onTitleChange,
  onSlugChange,
  onSubmit,
}: {
  form: CreateEndpointForm
  onChange: (patch: Partial<CreateEndpointForm>) => void
  onTitleChange: (title: string) => void
  onSlugChange: (slug: string) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="mb-3 rounded-lg border border-border/60 bg-background px-3 py-3"
    >
      <div className="grid gap-2">
        <LabeledField label="Title">
          <Input
            value={form.title}
            onChange={(event) => onTitleChange(event.target.value)}
            required
            placeholder="Linear issue events"
            className="h-9 text-[13px]"
          />
        </LabeledField>
        <LabeledField label="Slug">
          <Input
            value={form.slug}
            onChange={(event) =>
              onSlugChange(event.target.value.trim().toLowerCase())
            }
            required
            placeholder="linear-events"
            className="h-9 font-mono text-[13px]"
          />
        </LabeledField>
        <div className="grid gap-2 sm:grid-cols-2">
          <LabeledField label="Source">
            <Input
              value={form.source}
              onChange={(event) => onChange({ source: event.target.value })}
              placeholder="linear"
              className="h-9 text-[13px]"
            />
          </LabeledField>
          <LabeledField label="Default event">
            <Input
              value={form.defaultEventType}
              onChange={(event) =>
                onChange({ defaultEventType: event.target.value })
              }
              placeholder="issue.updated"
              className="h-9 text-[13px]"
            />
          </LabeledField>
        </div>
        <LabeledField label="Auth">
          <Select
            value={form.authMode}
            onValueChange={(authMode) =>
              onChange({ authMode: authMode as WebhookAuthMode })
            }
            options={AUTH_OPTIONS}
          />
        </LabeledField>
        <div className="grid gap-2 sm:grid-cols-3">
          <LabeledField label="Rate/min">
            <Input
              type="number"
              min={1}
              value={form.rateLimitPerMinute}
              onChange={(event) =>
                onChange({ rateLimitPerMinute: event.target.value })
              }
              className="h-9 text-[13px]"
            />
          </LabeledField>
          <LabeledField label="Retention days">
            <Input
              type="number"
              min={1}
              value={form.retentionDays}
              onChange={(event) =>
                onChange({ retentionDays: event.target.value })
              }
              className="h-9 text-[13px]"
            />
          </LabeledField>
          <LabeledField label="HMAC window">
            <Input
              type="number"
              min={30}
              value={form.hmacToleranceSeconds}
              onChange={(event) =>
                onChange({ hmacToleranceSeconds: event.target.value })
              }
              className="h-9 text-[13px]"
            />
          </LabeledField>
        </div>
        <LabeledField label="Description">
          <textarea
            value={form.description}
            onChange={(event) => onChange({ description: event.target.value })}
            rows={2}
            placeholder="Optional note for what this endpoint accepts."
            className="min-h-16 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-[16px] md:text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </LabeledField>
        <div className="mt-1 flex items-center justify-between gap-3">
          <label className="flex min-w-0 items-center gap-2 text-[13px] text-foreground/70">
            <Switch
              checked={form.enabled}
              onCheckedChange={(enabled) => onChange({ enabled })}
              aria-label="Enable webhook"
            />
            Enabled
          </label>
          <Button type="submit" size="sm">
            Create
          </Button>
        </div>
      </div>
    </form>
  )
}

function WebhookEndpointCard({
  endpoint,
  selected,
  busy,
  onSelect,
  onToggleEnabled,
}: {
  endpoint: WebhookEndpoint
  selected: boolean
  busy: boolean
  onSelect: () => void
  onToggleEnabled: (enabled: boolean) => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "group w-full min-w-0 cursor-pointer rounded-lg border border-border/60 bg-background px-3 py-3 text-left transition-colors hover:bg-[#f0ede6]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 dark:hover:bg-muted",
        selected && "border-foreground/40 bg-[#f0ede6] dark:bg-muted",
        !endpoint.enabled && "opacity-65"
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 shrink-0 text-foreground/55">
          <Webhook className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[14px] font-semibold text-foreground">
              {endpoint.title}
            </span>
            {!endpoint.enabled && (
              <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] text-foreground/65">
                paused
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-foreground/55">
            /api/webhooks/{endpoint.slug}
          </div>
          <div className="mt-1 truncate text-[12px] text-foreground/60">
            {endpoint.source}
            {endpoint.defaultEventType ? ` · ${endpoint.defaultEventType}` : ""}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground/45">
            <span>{authLabel(endpoint.authMode)}</span>
            <span>{endpoint.rateLimitPerMinute}/min</span>
            <span>{endpoint.retentionDays}d retention</span>
          </div>
        </div>
        <div
          className="ml-2 shrink-0"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Switch
            checked={endpoint.enabled}
            disabled={busy}
            onCheckedChange={onToggleEnabled}
            aria-label={endpoint.enabled ? "Disable webhook" : "Enable webhook"}
          />
        </div>
      </div>
    </div>
  )
}

function WebhookDetailPanel({
  endpoint,
  subscriptions,
  events,
  microscripts,
  loading,
  loadingEvents,
  createdSecret,
  busyEndpoint,
  busySubscriptionIds,
  onClose,
  onBack,
  onDeleted,
  onSecretConsumed,
  onError,
  onRefresh,
  onEndpointEnabled,
  setBusyEndpointIds,
  setBusySubscriptionIds,
  setCreatedSecret,
}: {
  endpoint: WebhookEndpoint
  subscriptions: WebhookSubscription[]
  events: WebhookEvent[]
  microscripts: MicroscriptRow[]
  loading: boolean
  loadingEvents: boolean
  createdSecret: string | null
  busyEndpoint: boolean
  busySubscriptionIds: Set<string>
  onClose: () => void
  onBack: () => void
  onDeleted: () => void
  onSecretConsumed: () => void
  onError: (error: string | null) => void
  onRefresh: () => void
  onEndpointEnabled: (enabled: boolean) => void
  setBusyEndpointIds: React.Dispatch<React.SetStateAction<Set<string>>>
  setBusySubscriptionIds: React.Dispatch<React.SetStateAction<Set<string>>>
  setCreatedSecret: (secret: string) => void
}) {
  const [origin, setOrigin] = React.useState("")
  const [subscriptionForm, setSubscriptionForm] =
    React.useState<SubscriptionForm>(DEFAULT_SUBSCRIPTION_FORM)
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null)
  const { confirm, dialog } = useConfirm()
  const now = useNow(1000)

  React.useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  React.useEffect(() => {
    setSubscriptionForm((current) => {
      if (current.targetId || microscripts.length === 0) return current
      return { ...current, targetId: microscripts[0].id }
    })
  }, [microscripts])

  const ingressUrl = `${origin}/api/webhooks/${endpoint.slug}`

  const copy = React.useCallback((key: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey(null), 1200)
    })
  }, [])

  const rotateSecret = React.useCallback(async () => {
    if (
      !(await confirm({
        title: "Rotate webhook secret?",
        message:
          "External callers must switch to the new secret immediately after this.",
        confirmLabel: "Rotate",
      }))
    ) {
      return
    }
    setBusyEndpointIds((prev) => new Set(prev).add(endpoint.id))
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(endpoint.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rotateSecret: true }),
        }
      )
      if (!res.ok) throw new Error(await asError(res))
      const data = (await res.json()) as {
        endpoint: WebhookEndpoint
        secret?: string
      }
      if (data.secret) setCreatedSecret(data.secret)
      onRefresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to rotate secret")
    } finally {
      setBusyEndpointIds((prev) => {
        const next = new Set(prev)
        next.delete(endpoint.id)
        return next
      })
    }
  }, [
    confirm,
    endpoint.id,
    onError,
    onRefresh,
    setBusyEndpointIds,
    setCreatedSecret,
  ])

  const deleteEndpoint = React.useCallback(async () => {
    if (
      !(await confirm({
        title: `Delete "${endpoint.title}"?`,
        message:
          "This removes the endpoint, its recent webhook events, and subscriptions.",
        destructive: true,
        confirmLabel: "Delete",
      }))
    ) {
      return
    }
    setBusyEndpointIds((prev) => new Set(prev).add(endpoint.id))
    try {
      const res = await fetch(
        `/api/webhooks/${encodeURIComponent(endpoint.id)}`,
        {
          method: "DELETE",
        }
      )
      if (!res.ok) throw new Error(await asError(res))
      onDeleted()
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete webhook")
    } finally {
      setBusyEndpointIds((prev) => {
        const next = new Set(prev)
        next.delete(endpoint.id)
        return next
      })
    }
  }, [
    confirm,
    endpoint.id,
    endpoint.title,
    onDeleted,
    onError,
    setBusyEndpointIds,
  ])

  const createSubscription = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      onError(null)
      try {
        let payloadEquals: unknown | undefined
        const rawPayloadEquals = subscriptionForm.payloadEquals.trim()
        if (rawPayloadEquals) payloadEquals = JSON.parse(rawPayloadEquals)
        const body = {
          targetKind: "microscript",
          targetId: subscriptionForm.targetId,
          eventType: blankToNull(subscriptionForm.eventType),
          payloadPath: blankToNull(subscriptionForm.payloadPath),
          ...(rawPayloadEquals ? { payloadEquals } : {}),
        }
        const res = await fetch(
          `/api/webhooks/${encodeURIComponent(endpoint.id)}/subscriptions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        )
        if (!res.ok) throw new Error(await asError(res))
        setSubscriptionForm({
          ...DEFAULT_SUBSCRIPTION_FORM,
          targetId: microscripts[0]?.id ?? "",
        })
        onRefresh()
      } catch (err) {
        onError(
          err instanceof Error ? err.message : "Failed to create subscription"
        )
      }
    },
    [endpoint.id, microscripts, onError, onRefresh, subscriptionForm]
  )

  const updateSubscriptionEnabled = React.useCallback(
    async (subscriptionId: string, enabled: boolean) => {
      setBusySubscriptionIds((prev) => new Set(prev).add(subscriptionId))
      try {
        const res = await fetch(
          `/api/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
          }
        )
        if (!res.ok) throw new Error(await asError(res))
        onRefresh()
      } catch (err) {
        onError(
          err instanceof Error ? err.message : "Failed to update subscription"
        )
      } finally {
        setBusySubscriptionIds((prev) => {
          const next = new Set(prev)
          next.delete(subscriptionId)
          return next
        })
      }
    },
    [onError, onRefresh, setBusySubscriptionIds]
  )

  const deleteSubscription = React.useCallback(
    async (subscription: WebhookSubscription) => {
      if (
        !(await confirm({
          title: "Delete subscription?",
          message:
            "Matching future webhook events will stop dispatching to this microscript.",
          destructive: true,
          confirmLabel: "Delete",
        }))
      ) {
        return
      }
      setBusySubscriptionIds((prev) => new Set(prev).add(subscription.id))
      try {
        const res = await fetch(
          `/api/webhooks/subscriptions/${encodeURIComponent(subscription.id)}`,
          { method: "DELETE" }
        )
        if (!res.ok) throw new Error(await asError(res))
        onRefresh()
      } catch (err) {
        onError(
          err instanceof Error ? err.message : "Failed to delete subscription"
        )
      } finally {
        setBusySubscriptionIds((prev) => {
          const next = new Set(prev)
          next.delete(subscription.id)
          return next
        })
      }
    },
    [confirm, onError, onRefresh, setBusySubscriptionIds]
  )

  return (
    <>
      {dialog}
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-4 py-3 md:gap-3 md:px-5 md:py-4">
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 rounded-md p-1.5 text-foreground/55 hover:bg-[#f0ede6] md:hidden dark:hover:bg-muted"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="shrink-0 text-foreground/55">
          <Webhook className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[16px] font-semibold">
              {endpoint.title}
            </span>
            {!endpoint.enabled && (
              <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] text-foreground/65">
                paused
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-foreground/55">
            {endpoint.slug}
          </div>
        </div>
        {loading && (
          <Loader2 className="size-4 animate-spin text-foreground/35" />
        )}
        <Switch
          checked={endpoint.enabled}
          disabled={busyEndpoint}
          onCheckedChange={onEndpointEnabled}
          aria-label={endpoint.enabled ? "Disable webhook" : "Enable webhook"}
        />
        {endpoint.authMode !== "none" && (
          <button
            type="button"
            title="Rotate secret"
            disabled={busyEndpoint}
            onClick={() => void rotateSecret()}
            className="shrink-0 rounded-md p-2 text-foreground/55 hover:bg-[#f0ede6] disabled:opacity-50 dark:hover:bg-muted"
          >
            <RotateCw className="size-4" />
          </button>
        )}
        <button
          type="button"
          title="Delete webhook"
          disabled={busyEndpoint}
          onClick={() => void deleteEndpoint()}
          className="shrink-0 rounded-md p-2 text-[#802020] hover:bg-red-50 disabled:opacity-50"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          type="button"
          title="Close"
          onClick={onClose}
          className="hidden shrink-0 rounded-md p-2 text-foreground/55 hover:bg-[#f0ede6] md:inline-flex dark:hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 md:px-5 md:py-5">
        {createdSecret && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
            <div className="flex min-w-0 items-start gap-2">
              <KeyRound className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Save this secret now.</div>
                <div className="mt-1 font-mono text-[12px] break-words">
                  {createdSecret}
                </div>
              </div>
              <CopyButton
                copied={copiedKey === "secret"}
                onClick={() => copy("secret", createdSecret)}
                label="Copy secret"
              />
              <button
                type="button"
                className="shrink-0 rounded-md px-2 py-1 text-[12px] hover:bg-amber-100 dark:hover:bg-amber-900/40"
                onClick={onSecretConsumed}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <Section title="Connection">
          <div className="space-y-2">
            <CopyableValue
              label="Ingress URL"
              value={ingressUrl}
              copied={copiedKey === "url"}
              onCopy={() => copy("url", ingressUrl)}
            />
            <div className="grid gap-2 text-[12px] text-foreground/65 sm:grid-cols-2">
              <KeyValue label="Auth" value={authLabel(endpoint.authMode)} />
              <KeyValue
                label="Secret"
                value={
                  endpoint.authMode === "none"
                    ? "not required"
                    : (endpoint.secretPreview ?? "missing")
                }
              />
              <KeyValue label="Source" value={endpoint.source} />
              <KeyValue
                label="Default event"
                value={endpoint.defaultEventType ?? "payload-derived"}
              />
              <KeyValue
                label="Rate limit"
                value={`${endpoint.rateLimitPerMinute}/min`}
              />
              <KeyValue
                label="Retention"
                value={`${endpoint.retentionDays} day(s)`}
              />
            </div>
          </div>
        </Section>

        {endpoint.description && (
          <Section title="Description">
            <div className="rounded-md border border-border/60 bg-background px-3 py-2 text-[13px] break-words text-foreground/80">
              {endpoint.description}
            </div>
          </Section>
        )}

        <Section title={`Subscriptions (${subscriptions.length})`}>
          <form
            onSubmit={createSubscription}
            className="mb-3 rounded-md border border-border/60 bg-background px-3 py-3"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <LabeledField label="Microscript">
                <Select
                  value={subscriptionForm.targetId}
                  onValueChange={(targetId) =>
                    setSubscriptionForm((current) => ({
                      ...current,
                      targetId,
                    }))
                  }
                  options={microscripts.map((script) => ({
                    value: script.id,
                    label: script.title,
                  }))}
                  placeholder={
                    microscripts.length === 0
                      ? "No microscripts"
                      : "Choose microscript"
                  }
                  disabled={microscripts.length === 0}
                />
              </LabeledField>
              <LabeledField label="Event type">
                <Input
                  value={subscriptionForm.eventType}
                  onChange={(event) =>
                    setSubscriptionForm((current) => ({
                      ...current,
                      eventType: event.target.value,
                    }))
                  }
                  placeholder="Any event"
                  className="h-9 text-[13px]"
                />
              </LabeledField>
              <LabeledField label="Payload path">
                <Input
                  value={subscriptionForm.payloadPath}
                  onChange={(event) =>
                    setSubscriptionForm((current) => ({
                      ...current,
                      payloadPath: event.target.value,
                    }))
                  }
                  placeholder="data.status"
                  className="h-9 text-[13px]"
                />
              </LabeledField>
              <LabeledField label="Payload equals JSON">
                <Input
                  value={subscriptionForm.payloadEquals}
                  onChange={(event) =>
                    setSubscriptionForm((current) => ({
                      ...current,
                      payloadEquals: event.target.value,
                    }))
                  }
                  placeholder='"done"'
                  className="h-9 font-mono text-[13px]"
                />
              </LabeledField>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                type="submit"
                size="sm"
                disabled={
                  !subscriptionForm.targetId || microscripts.length === 0
                }
              >
                <Plus className="size-3.5" />
                Add
              </Button>
            </div>
          </form>

          {subscriptions.length === 0 ? (
            <p className="text-[12px] text-foreground/55">
              No subscriptions yet. Events are still persisted, but nothing is
              dispatched until a subscription matches.
            </p>
          ) : (
            <ul className="space-y-2">
              {subscriptions.map((subscription) => (
                <li
                  key={subscription.id}
                  className="rounded-md border border-border/60 bg-background px-3 py-2"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-foreground">
                        {subscriptionLabel(subscription, microscripts)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-foreground/50">
                        <span>
                          {subscription.eventType ?? "any event type"}
                        </span>
                        {subscription.payloadPath && (
                          <span className="font-mono">
                            {subscription.payloadPath}
                            {subscription.payloadEquals === null
                              ? " exists"
                              : ` = ${codeJsonInline(subscription.payloadEquals)}`}
                          </span>
                        )}
                        {!subscription.enabled && <span>paused</span>}
                      </div>
                    </div>
                    <Switch
                      checked={subscription.enabled}
                      disabled={busySubscriptionIds.has(subscription.id)}
                      onCheckedChange={(enabled) =>
                        updateSubscriptionEnabled(subscription.id, enabled)
                      }
                      aria-label={
                        subscription.enabled
                          ? "Disable subscription"
                          : "Enable subscription"
                      }
                    />
                    <button
                      type="button"
                      title="Delete subscription"
                      disabled={busySubscriptionIds.has(subscription.id)}
                      onClick={() => void deleteSubscription(subscription)}
                      className="shrink-0 rounded-md p-1 text-foreground/45 hover:bg-red-50 hover:text-[#802020] disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent events">
          {loadingEvents ? (
            <div className="flex items-center gap-2 text-[12px] text-foreground/55">
              <Loader2 className="size-3 animate-spin" /> Loading...
            </div>
          ) : events.length === 0 ? (
            <p className="text-[12px] text-foreground/55">
              No webhook events recorded yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {events.map((event) => (
                <WebhookEventRow
                  key={event.id}
                  event={event}
                  microscripts={microscripts}
                  now={now}
                />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  )
}

function WebhookEventRow({
  event,
  microscripts,
  now,
}: {
  event: WebhookEvent
  microscripts: MicroscriptRow[]
  now: number
}) {
  return (
    <li className="min-w-0 rounded-md border border-border/60 bg-background px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
            webhookStatusClass(event.status)
          )}
        >
          {event.status}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <span className="font-semibold text-foreground">
              {event.eventType}
            </span>
            <span className="text-foreground/45">
              {formatPast(event.receivedAt, now)}
            </span>
          </div>
          <div className="mt-1 text-[12px] break-words text-foreground/65">
            {event.normalized.summary}
          </div>
          {event.error && (
            <div className="mt-1 text-[12px] break-words text-[#802020]">
              {event.error}
            </div>
          )}
          {event.dispatches && event.dispatches.length > 0 && (
            <ul className="mt-2 space-y-1">
              {event.dispatches.map((dispatch) => (
                <WebhookDispatchRow
                  key={dispatch.id}
                  dispatch={dispatch}
                  microscripts={microscripts}
                />
              ))}
            </ul>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] font-medium text-foreground/45 hover:text-foreground/70">
              Payload
            </summary>
            <pre className="mt-1 max-h-56 overflow-auto rounded bg-foreground/[0.03] p-2 text-[11px] leading-4">
              <code>{codeJson(event.payload)}</code>
            </pre>
          </details>
        </div>
      </div>
    </li>
  )
}

function WebhookDispatchRow({
  dispatch,
  microscripts,
}: {
  dispatch: WebhookDispatch
  microscripts: MicroscriptRow[]
}) {
  return (
    <li className="rounded bg-foreground/[0.03] px-2 py-1 text-[11px] text-foreground/60">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            "rounded px-1 py-0.5 font-semibold uppercase",
            webhookDispatchClass(dispatch.status)
          )}
        >
          {dispatch.status}
        </span>
        <span className="min-w-0 truncate">
          {subscriptionTargetLabel(dispatch.targetId, microscripts)}
        </span>
      </div>
      {(dispatch.runSummary || dispatch.error) && (
        <div className="mt-0.5 break-words">
          {dispatch.error ?? dispatch.runSummary}
        </div>
      )}
    </li>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-6 min-w-0">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-foreground/45 uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function LabeledField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-semibold tracking-wider text-foreground/45 uppercase">
        {label}
      </span>
      {children}
    </label>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background px-3 py-2">
      <div className="text-[11px] font-semibold tracking-wider text-foreground/40 uppercase">
        {label}
      </div>
      <div className="mt-0.5 break-words text-foreground/75">{value}</div>
    </div>
  )
}

function CopyableValue({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="rounded-md border border-border/60 bg-background px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold tracking-wider text-foreground/40 uppercase">
        {label}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 font-mono text-[12px] [overflow-wrap:anywhere] text-foreground/75">
          {value}
        </div>
        <CopyButton copied={copied} onClick={onCopy} label={`Copy ${label}`} />
      </div>
    </div>
  )
}

function CopyButton({
  copied,
  onClick,
  label,
}: {
  copied: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 rounded-md p-1.5 text-foreground/55 hover:bg-[#f0ede6] hover:text-foreground dark:hover:bg-muted"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function authLabel(authMode: WebhookAuthMode): string {
  switch (authMode) {
    case "bearer":
      return "Bearer secret"
    case "hmac":
      return "HMAC SHA-256"
    case "svix":
      return "Svix / Standard Webhooks"
    case "none":
      return "No auth"
  }
}

function subscriptionLabel(
  subscription: WebhookSubscription,
  microscripts: MicroscriptRow[]
): string {
  return subscriptionTargetLabel(subscription.targetId, microscripts)
}

function subscriptionTargetLabel(
  targetId: string,
  microscripts: MicroscriptRow[]
): string {
  return (
    microscripts.find((script) => script.id === targetId)?.title ?? targetId
  )
}

function webhookStatusClass(status: WebhookEvent["status"]): string {
  switch (status) {
    case "processed":
      return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
    case "processing":
    case "received":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
    case "duplicate":
      return "bg-slate-100 text-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
    case "error":
      return "bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-300"
  }
}

function webhookDispatchClass(status: WebhookDispatch["status"]): string {
  switch (status) {
    case "ok":
      return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
    case "queued":
    case "running":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
    case "skipped":
      return "bg-slate-100 text-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
    case "error":
      return "bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-300"
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function numberOrDefault(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function codeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return "(unserializable)"
  }
}

function codeJsonInline(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return "(unserializable)"
  }
}
