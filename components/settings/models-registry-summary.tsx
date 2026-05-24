import { cn } from "@/lib/utils"

import type { ProviderDef } from "@/lib/config"
import type { ProviderStatus } from "@/components/settings/use-settings"

export function ModelRegistrySummary({
  providers,
  providerStatus,
}: {
  providers: Record<string, ProviderDef>
  providerStatus: Record<string, ProviderStatus>
}) {
  const rows = Object.entries(providers)
    .filter(([providerId]) => providerId !== "browser")
    .map(([providerId, provider]) => {
      const models = Object.values(provider.models)
      const archived = models.filter((model) => model.archived).length
      const incomplete = models.filter(
        (model) => !model.archived && model.dataCompleteness === "incomplete"
      ).length
      const active = models.length - archived
      const usable = providerStatus[providerId]?.available ?? false
      return {
        providerId,
        providerName: provider.name,
        active,
        incomplete,
        archived,
        total: models.length,
        usable,
      }
    })

  const totals = rows.reduce(
    (acc, row) => ({
      active: acc.active + (row.usable ? row.active : 0),
      incomplete: acc.incomplete + (row.usable ? row.incomplete : 0),
      archived: acc.archived + row.archived,
      total: acc.total + row.total,
    }),
    { active: 0, incomplete: 0, archived: 0, total: 0 }
  )

  return (
    <section className="mt-4 rounded-2xl border border-border/70 bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-4 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold text-foreground/85">
            Model registry
          </h2>
          <p className="mt-0.5 text-[12px] text-foreground/50">
            Catalog models are tracked separately from providers that are ready
            to use.
          </p>
        </div>
        <div className="flex gap-2 text-[11.5px] tabular-nums">
          <RegistryPill label="Ready" value={totals.active} />
          <RegistryPill
            label="Incomplete"
            value={totals.incomplete}
            tone="amber"
          />
          <RegistryPill label="Archived" value={totals.archived} tone="muted" />
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {rows.map((row) => (
          <div
            key={row.providerId}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-4 py-2.5 text-[13px]"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground/80">
                {row.providerName}
              </p>
              <p className="text-[11.5px] text-foreground/45">
                {row.providerId} · {row.usable ? "ready" : "not connected"}
              </p>
            </div>
            <CountCell
              label="catalog"
              value={row.active}
              tone={row.usable ? "default" : "muted"}
            />
            <CountCell
              label="incomplete"
              value={row.usable ? row.incomplete : 0}
              tone={row.usable && row.incomplete > 0 ? "amber" : "muted"}
            />
            <CountCell label="archived" value={row.archived} tone="muted" />
          </div>
        ))}
      </div>
    </section>
  )
}

function RegistryPill({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: number
  tone?: "default" | "amber" | "muted"
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2",
        tone === "amber"
          ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : tone === "muted"
            ? "border-border bg-muted/40 text-foreground/55"
            : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-500"
      )}
    >
      <span>{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  )
}

function CountCell({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: number
  tone?: "default" | "amber" | "muted"
}) {
  return (
    <div
      className={cn(
        "w-20 text-right tabular-nums",
        tone === "amber"
          ? "text-amber-700 dark:text-amber-400"
          : tone === "muted"
            ? "text-foreground/45"
            : "text-foreground/70"
      )}
      title={label}
    >
      <span className="font-medium">{value}</span>
      <span className="ml-1 hidden text-[11px] text-foreground/35 sm:inline">
        {label}
      </span>
    </div>
  )
}
