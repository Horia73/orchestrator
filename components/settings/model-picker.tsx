"use client"

import * as React from "react"
import { Archive, ArchiveRestore, Check, ChevronDown, ChevronUp, Loader2, RefreshCcw, Star, X } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import type { ProviderDef, ModelDef, ModelPricing } from "@/lib/config"
import { useSettings, type ProviderStatus, type SettingsBootstrap } from "./use-settings"

export interface ModelPickerProps {
  /** Current value as "providerId:modelId"; null renders the optional None row. */
  value: string | null
  onChange: (next: { providerId: string; modelId: string }) => void
  /** Optional first-row choice for settings like fallbacks. */
  noneLabel?: string
  onNone?: () => void
  /** Optional className for the trigger button */
  className?: string
  /** Disabled state */
  disabled?: boolean
  /** Optional filter for specialized agents that can only use a subset of models. */
  filterModel?: (model: ModelPickerOption) => boolean
}

// The browser provider isn't a real model source — it's an external script
// wrapper. Hide its entries from every picker (the browser agent's card
// hides the picker entirely so its "default" entry never needs to show up).
const HIDDEN_PROVIDERS = new Set(['browser'])
const CLI_PROVIDER_IDS = new Set(['claude-code', 'codex'])

export interface ModelPickerOption {
  key: string
  providerId: string
  providerName: string
  modelId: string
  model: ModelDef
}

type FlatModel = ModelPickerOption

export function ModelPicker({ value, onChange, noneLabel, onNone, className, disabled, filterModel }: ModelPickerProps) {
  const { data, setFavorites, setArchived, refreshModels, refreshing } = useSettings()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [showArchived, setShowArchived] = React.useState(false)
  // Controlled cmdk highlight — reset on popover mouse leave so items don't
  // stay visually "stuck" when the cursor moves outside the dropdown.
  const [highlight, setHighlight] = React.useState("")

  // Only the keyboard highlight resets on close. The search text and the
  // expanded "Archived" section persist so the dropdown reopens exactly as
  // the user left it (it should never reset itself).
  React.useEffect(() => {
    if (!open) setHighlight("")
  }, [open])

  if (!data) return null

  // All models from providers that should be visible in Settings. API-backed
  // providers still require a configured key before they show up. CLI-backed
  // providers remain visible while logged out so existing selections don't
  // collapse to "No model loaded"; the row/group badges carry the auth state.
  const allModels = flattenModels(data.providers)
    .filter(m => !HIDDEN_PROVIDERS.has(m.providerId))
    .filter(m => isProviderVisibleInPicker(m.providerId, data))
    .filter(m => !filterModel || filterModel(m))

  // Split archived from active. Archived only show when the user expands the
  // section explicitly so the main list stays uncluttered.
  const activeModels = allModels.filter(m => !m.model.archived)
  const archivedModels = allModels.filter(m => m.model.archived)
  // Auto-expand the archived section while a search query is active so cmdk
  // can match archived models too — without that, the rows aren't mounted and
  // the search misses them.
  const effectiveShowArchived = showArchived || query.trim().length > 0
  const modelsByKey = new Map(allModels.map(m => [m.key, m]))
  const activeKeys = new Set(activeModels.map(m => m.key))

  const favorites = data.config.favorites
  // Favorites filtered to active + visible-under-kind. Archiving auto-removes
  // a model from favorites server-side, so this filter is just defensive.
  const favoriteModels = favorites
    .map(k => modelsByKey.get(k))
    .filter((m): m is FlatModel => m !== undefined && activeKeys.has(m.key))

  const groupedNonFavorites = groupByProvider(
    activeModels.filter(m => !favorites.includes(m.key))
  )

  // The current value lookup tolerates being out-of-kind — useful when an
  // agent references a model whose kind metadata changed.
  const current = value
    ? modelsByKey.get(value) ?? (allModels.find(m => m.key === value) ?? undefined)
    : undefined
  const currentProviderLabel = current ? providerUnavailableLabel(current.providerId, data) : null

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen && current && activeKeys.has(current.key)) {
      setHighlight(current.key)
    }
  }

  const handleSelect = (key: string) => {
    const m = modelsByKey.get(key)
    if (!m) return
    onChange({ providerId: m.providerId, modelId: m.modelId })
    setOpen(false)
    setQuery("")
  }

  const handleToggleFavorite = (key: string, e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const next = favorites.includes(key)
      ? favorites.filter(k => k !== key)
      : [...favorites, key]
    void setFavorites(next).catch(() => {
      /* useSettings already re-syncs from server on error */
    })
  }

  const handleMoveFavorite = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= favorites.length) return
    const next = [...favorites]
    ;[next[index], next[target]] = [next[target], next[index]]
    void setFavorites(next)
  }

  const handleToggleArchive = (m: FlatModel, e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    e.preventDefault()
    void setArchived(m.providerId, m.modelId, !m.model.archived).catch(() => { /* re-synced by hook */ })
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "group/picker flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-left text-[14px] font-medium text-foreground outline-none transition-colors",
            "hover:bg-muted/50",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "data-[state=open]:bg-muted/50",
            "disabled:pointer-events-none disabled:opacity-50",
            className
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            {current ? (
              <>
                <ProviderDot providerId={current.providerId} />
                <span className="min-w-0 truncate">{current.model.name}</span>
                {currentProviderLabel && (
                  <span className="hidden max-w-[160px] shrink-0 truncate rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 sm:inline dark:text-amber-400">
                    {currentProviderLabel.long}
                  </span>
                )}
              </>
            ) : noneLabel && value === null ? (
              <span className="text-foreground/60">{noneLabel}</span>
            ) : (
              <span className="text-foreground/50">No model loaded</span>
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 text-foreground/45 transition-transform group-data-[state=open]/picker:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-(--radix-popover-trigger-width) min-w-[320px] p-0"
        onMouseLeave={() => setHighlight("")}
        // Don't yank focus back to the trigger on close — that caused a scroll
        // jump and contributed to the dropdown feeling like it moved on its own.
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <Command
          shouldFilter={true}
          value={highlight}
          onValueChange={setHighlight}
        >
          <div className="px-2 pt-2">
            <div className="px-0.5 pb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/50">
                Search models
              </span>
            </div>
            <CommandInput
              placeholder="Search models…"
              value={query}
              onValueChange={setQuery}
              endSlot={query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={() => setQuery("")}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            />
          </div>
          <CommandList className="[scrollbar-gutter:stable]">
            <CommandEmpty>
              {activeModels.length === 0 && archivedModels.length === 0
                ? "No models shown. Add an API key or unarchive a CLI model."
                : `No models match “${query}”.`}
            </CommandEmpty>

            {noneLabel && onNone && (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__none__"
                    onSelect={() => {
                      onNone()
                      setOpen(false)
                      setQuery("")
                    }}
                    data-active={value === null ? true : undefined}
                    className={cn(
                      "items-start gap-2 py-2 pr-2 data-[selected=true]:bg-muted/45",
                      value === null && "bg-muted/75 ring-1 ring-border/70 data-[selected=true]:bg-muted/75"
                    )}
                  >
                    <span className="mt-1.5 size-2.5 rounded-full border border-foreground/25" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                      {noneLabel}
                    </span>
                    <Check
                      aria-hidden
                      className={cn(
                        "mt-1 size-4 shrink-0 text-foreground/65 transition-opacity",
                        value === null ? "opacity-100" : "opacity-0"
                      )}
                    />
                  </CommandItem>
                </CommandGroup>
                {(favoriteModels.length > 0 || Object.keys(groupedNonFavorites).length > 0 || archivedModels.length > 0) && <CommandSeparator />}
              </>
            )}

            {favoriteModels.length > 0 && (
              <>
                <CommandGroup
                  heading={
                    <span className="flex items-center gap-1.5">
                      <Star className="size-3 fill-amber-400 text-amber-400" />
                      Favorites
                    </span>
                  }
                >
                  {favoriteModels.map((m, idx) => (
                    <ModelRow
                      key={m.key}
                      model={m}
                      providerLabel={providerUnavailableLabel(m.providerId, data)}
                      isActive={m.key === value}
                      isFavorite
                      onSelect={handleSelect}
                      onToggleFavorite={handleToggleFavorite}
                      onToggleArchive={handleToggleArchive}
                      reorderIndex={favoriteModels.length > 1 ? idx : undefined}
                      reorderTotal={favoriteModels.length}
                      onMove={handleMoveFavorite}
                    />
                  ))}
                </CommandGroup>
                {Object.keys(groupedNonFavorites).length > 0 && <CommandSeparator />}
              </>
            )}

            {Object.entries(groupedNonFavorites).map(([providerId, models]) => (
              <CommandGroup key={providerId} heading={<ProviderGroupHeading providerId={providerId} data={data} />}>
                {models.map(m => (
                  <ModelRow
                    key={m.key}
                    model={m}
                    providerLabel={providerUnavailableLabel(m.providerId, data)}
                    isActive={m.key === value}
                    isFavorite={false}
                    onSelect={handleSelect}
                    onToggleFavorite={handleToggleFavorite}
                    onToggleArchive={handleToggleArchive}
                  />
                ))}
              </CommandGroup>
            ))}

            {archivedModels.length > 0 && (
              <>
                {(favoriteModels.length > 0 || Object.keys(groupedNonFavorites).length > 0) && <CommandSeparator />}
                {/*
                  Plain CommandItem keeps the row inside cmdk's keyboard nav
                  but `forceMount` lets us toggle the visual collapse state
                  without losing the option from the search index.
                */}
                <CommandGroup
                  heading={
                    <button
                      type="button"
                      onClick={e => { e.preventDefault(); e.stopPropagation(); setShowArchived(s => !s) }}
                      onPointerDown={e => e.stopPropagation()}
                      className="flex w-full items-center gap-1.5 text-left text-foreground/55 transition-colors hover:text-foreground"
                    >
                      <Archive className="size-3" />
                      Archived
                      <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground/55">
                        {archivedModels.length}
                      </span>
                      <ChevronDown
                        className={cn(
                          "ml-auto size-3 text-foreground/40 transition-transform",
                          effectiveShowArchived && "rotate-180"
                        )}
                      />
                    </button>
                  }
                >
                  {effectiveShowArchived && archivedModels.map(m => (
                    <ModelRow
                      key={m.key}
                      model={m}
                      providerLabel={providerUnavailableLabel(m.providerId, data)}
                      isActive={m.key === value}
                      isFavorite={false}
                      onSelect={handleSelect}
                      onToggleFavorite={handleToggleFavorite}
                      onToggleArchive={handleToggleArchive}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>

          <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 text-[11px] text-foreground/45">
            <span>
              {activeModels.length} models · {favoriteModels.length} favorited
              {archivedModels.length > 0 && ` · ${archivedModels.length} archived`}
            </span>
            <button
              type="button"
              disabled={refreshing}
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                void refreshModels().catch(() => { /* hook re-syncs */ })
              }}
              onPointerDown={e => e.stopPropagation()}
              title="Refresh model list from provider APIs"
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground/55 transition-colors",
                "hover:bg-muted hover:text-foreground",
                refreshing && "opacity-60"
              )}
            >
              {refreshing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCcw className="size-3" />}
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ---------- Internals ----------

type ProviderUnavailableLabel = {
  short: string
  long: string
}

function ProviderGroupHeading({ providerId, data }: { providerId: string; data: SettingsBootstrap }) {
  const label = providerUnavailableLabel(providerId, data)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="truncate">{data.providers[providerId]?.name ?? providerId}</span>
      {label && (
        <span
          className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 normal-case dark:text-amber-400"
          title={label.long}
        >
          {label.short}
        </span>
      )}
    </span>
  )
}

function ModelRow({
  model,
  providerLabel,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
  onToggleArchive,
  reorderIndex,
  reorderTotal,
  onMove,
}: {
  model: FlatModel
  providerLabel: ProviderUnavailableLabel | null
  isActive: boolean
  isFavorite: boolean
  onSelect: (key: string) => void
  onToggleFavorite: (key: string, e: React.MouseEvent | React.KeyboardEvent) => void
  onToggleArchive: (m: FlatModel, e: React.MouseEvent | React.KeyboardEvent) => void
  /** When defined, this row is in the Favorites group and shows up/down controls. */
  reorderIndex?: number
  reorderTotal?: number
  onMove?: (index: number, direction: -1 | 1) => void
}) {
  // Keep cmdk's selected value unique while still matching display names and ids.
  // Searches like "flash-lite", "google", "2.5", or "gemini" all hit.
  const cmdkKeywords = [model.providerName, model.model.name, model.providerId, model.modelId]

  const showReorder = reorderIndex !== undefined && reorderTotal !== undefined && onMove !== undefined
  const canMoveUp = showReorder && reorderIndex! > 0
  const canMoveDown = showReorder && reorderIndex! < reorderTotal! - 1
  const isPreview = Boolean(model.model.notes && model.model.notes.includes("Preview"))
  const isIncomplete = model.model.dataCompleteness === "incomplete"

  return (
    <CommandItem
      value={model.key}
      keywords={cmdkKeywords}
      onSelect={() => onSelect(model.key)}
      data-active={isActive || undefined}
      className={cn(
        "items-start gap-2 py-2 pr-2 data-[selected=true]:bg-muted/45",
        isActive && "bg-muted/75 ring-1 ring-border/70 data-[selected=true]:bg-muted/75"
      )}
    >
      <ProviderDot providerId={model.providerId} className="mt-1.5" />

      <div className="min-w-0 flex-1">
        {/* Row 1: model name, full-width, only truncates if it overflows */}
        <div className="truncate text-[13px] font-medium text-foreground" title={model.model.name}>
          {model.model.name}
        </div>
        {/* Row 2: badges + ctx + price, wrapping before they overflow. */}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] tabular-nums text-foreground/50">
          {isPreview && (
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              preview
            </span>
          )}
          {isIncomplete && (
            <span
              className="rounded-full bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400"
              title="Pricing, thinking levels, or context size unknown"
            >
              no data
            </span>
          )}
          {providerLabel && (
            <span
              className="rounded-full bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400"
              title={providerLabel.long}
            >
              {providerLabel.short}
            </span>
          )}
          <span>{formatContext(model.model.contextWindow)}</span>
          <span className="text-foreground/30">·</span>
          <span>{formatPricingShort(model.model.pricing)}</span>
        </div>
      </div>

      <Check
        aria-hidden
        className={cn(
          "mt-1 size-4 shrink-0 text-foreground/65 transition-opacity",
          isActive ? "opacity-100" : "opacity-0"
        )}
      />

      {/* Up/down arrows for favorites — stacked vertically, same total height as star */}
      {showReorder && (
        <div className="flex shrink-0 flex-col -my-0.5">
          <ReorderButton
            disabled={!canMoveUp}
            label="Move up"
            onClick={e => {
              e.stopPropagation()
              e.preventDefault()
              if (canMoveUp) onMove!(reorderIndex!, -1)
            }}
          >
            <ChevronUp className="size-3" />
          </ReorderButton>
          <ReorderButton
            disabled={!canMoveDown}
            label="Move down"
            onClick={e => {
              e.stopPropagation()
              e.preventDefault()
              if (canMoveDown) onMove!(reorderIndex!, 1)
            }}
          >
            <ChevronDown className="size-3" />
          </ReorderButton>
        </div>
      )}

      {/*
        Archived models can't be favorited (server-side, archiving drops the
        favorite). Hide the star to keep the row uncluttered, replace with the
        unarchive (ArchiveRestore) action and keep the trash hidden.
      */}
      {!model.model.archived && (
        <button
          type="button"
          onClick={e => onToggleFavorite(model.key, e)}
          onKeyDown={e => {
            if (e.key === "Enter" || e.key === " ") {
              onToggleFavorite(model.key, e)
            }
          }}
          // Prevent cmdk from selecting the item when this button is clicked
          onPointerDown={e => e.stopPropagation()}
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/30 transition-colors",
            "hover:bg-amber-500/10 hover:text-amber-500",
            isFavorite && "text-amber-500"
          )}
        >
          <Star className={cn("size-3.5", isFavorite && "fill-current")} />
        </button>
      )}

      <button
        type="button"
        onClick={e => onToggleArchive(model, e)}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") onToggleArchive(model, e)
        }}
        onPointerDown={e => e.stopPropagation()}
        aria-label={model.model.archived ? "Unarchive model" : "Archive model"}
        title={model.model.archived ? "Unarchive" : "Archive"}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/30 transition-colors",
          model.model.archived
            ? "hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-500"
            : "hover:bg-foreground/10 hover:text-foreground/70"
        )}
      >
        {model.model.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
      </button>
    </CommandItem>
  )
}

function ReorderButton({
  disabled,
  label,
  onClick,
  children,
}: {
  disabled: boolean
  label: string
  onClick: (e: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onPointerDown={e => e.stopPropagation()}
      aria-label={label}
      className={cn(
        "flex h-3.5 w-5 items-center justify-center rounded-sm transition-colors",
        disabled
          ? "cursor-not-allowed text-foreground/15"
          : "text-foreground/40 hover:bg-muted hover:text-foreground/85"
      )}
    >
      {children}
    </button>
  )
}

function ProviderDot({ providerId, className }: { providerId: string; className?: string }) {
  const color =
    providerId === "google"
      ? "bg-blue-500"
      : providerId === "anthropic"
        ? "bg-orange-500"
        : providerId === "openai"
          ? "bg-emerald-500"
          : "bg-foreground/40"
  return (
    <span
      className={cn("inline-block size-1.5 shrink-0 rounded-full", color, className)}
      aria-hidden
    />
  )
}

// ---------- Helpers ----------

function flattenModels(providers: Record<string, ProviderDef>): FlatModel[] {
  const out: FlatModel[] = []
  for (const [providerId, providerDef] of Object.entries(providers)) {
    for (const [modelId, model] of Object.entries(providerDef.models)) {
      out.push({
        key: `${providerId}:${modelId}`,
        providerId,
        providerName: providerDef.name,
        modelId,
        model,
      })
    }
  }
  return out
}

function isProviderAvailable(providerId: string, data: SettingsBootstrap): boolean {
  const status = data.providerStatus?.[providerId]
  if (typeof status?.available === "boolean") return status.available
  const provider = data.providers[providerId]
  return Boolean(provider?.apiKeyEnv?.includes("NO_API_KEY") || status?.apiKeyConfigured)
}

function isProviderVisibleInPicker(providerId: string, data: SettingsBootstrap): boolean {
  if (isCliProvider(providerId, data.providerStatus?.[providerId])) return true
  return isProviderAvailable(providerId, data)
}

function isCliProvider(providerId: string, status: ProviderStatus | undefined): boolean {
  return status?.authKind === "cli" || CLI_PROVIDER_IDS.has(providerId)
}

function providerUnavailableLabel(providerId: string, data: SettingsBootstrap): ProviderUnavailableLabel | null {
  const status = data.providerStatus?.[providerId]
  if (!status || status.available || status.authKind !== "cli") return null

  const providerName = status.cliName ?? data.providers[providerId]?.name ?? providerId
  const reason = (status.unavailableReason ?? "").toLowerCase()
  if (status.cliInstalled === false) {
    return { short: "not installed", long: `${providerName} not installed` }
  }
  if (reason.includes("expired")) {
    return { short: "session expired", long: `${providerName} session expired` }
  }
  if (status.cliLoggedIn === false) {
    return { short: "not logged in", long: `${providerName} not logged in` }
  }
  return {
    short: "unavailable",
    long: status.unavailableReason ?? `${providerName} unavailable`,
  }
}

function groupByProvider(models: FlatModel[]): Record<string, FlatModel[]> {
  const out: Record<string, FlatModel[]> = {}
  for (const m of models) {
    if (!out[m.providerId]) out[m.providerId] = []
    out[m.providerId].push(m)
  }
  return out
}

function formatContext(n: number): string {
  if (!n || n <= 0) return "ctx ?"
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M ctx`
  }
  if (n >= 1_000) return `${Math.round(n / 1000)}K ctx`
  return `${n} ctx`
}

function formatPrice(n: number): string {
  if (n === 0) return "0"
  if (n < 1) return n.toFixed(2).replace(/\.?0+$/, "") || "0"
  return n.toFixed(2).replace(/\.?0+$/, "")
}

function formatPricingShort(pricing: ModelPricing | null): string {
  if (pricing === null) return "price ?"
  if (pricing.kind === "subscription") return "subscription"
  if (pricing.kind === "unit") {
    const currency = pricing.currency ?? "$"
    if (typeof pricing.pricePerUnit === "number") return `${currency}${formatPrice(pricing.pricePerUnit)} / ${pricing.unit}`
    if (pricing.tiers?.length) return `${pricing.tiers.length} tiers`
    return pricing.unit
  }
  const tiered = pricing.inputPerMillionLarge !== undefined || pricing.outputPerMillionLarge !== undefined || pricing.tiers?.length ? " tiered" : ""
  return `$${formatPrice(pricing.inputPerMillion)} / $${formatPrice(pricing.outputPerMillion)} per M${tiered}`
}
