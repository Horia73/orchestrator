// Consolidated markets monitor — the price "heartbeat".
//
// This is the CHEAP CODE LOOP, deliberately NOT adaptive:
//  - Runs at a FIXED cadence (the scheduled task's own `every` schedule).
//    It is pure code (HTTP quote + numeric threshold checks), so it can run
//    often and cheaply; there is no algorithmic cadence tuning here.
//  - ONE pass per tick, NO model: refresh quotes, record observations,
//    evaluate hard alerts + notable %-moves. Many instruments, zero LLM cost.
//  - Wake a model ONLY when something crosses a threshold, and then ONCE for
//    ALL movers together (consolidated brief) — never one wake per symbol.
//  - Silent by default; cooldown/dedupe via per-task state so a 3% move that
//    hovers doesn't re-explain every tick; reference is previous close, reset
//    each trading session.
//  - Decoupled from the watchlist data layer via an injected MarketsAdapter.
//
// NOTE: model-driven adaptive pacing (a recurring AGENT monitor that notices
// quiet periods / learned user routine and reschedules ITSELF) lives in the
// orchestrator prompt + the `reschedule_task` tool — NOT here. This loop stays
// dumb, fixed and cheap on purpose.

export interface MonitoredInstrument {
  id: string
  symbol: string
  providerSymbol: string
  name: string
  assetClass: "stock" | "etf" | "crypto" | "forex" | "index" | "fund" | "other"
  /** Notable %-move threshold; null → asset-class default. */
  movePercent: number | null
  monitorEnabled: boolean
  price: number | null
  previousClose: number | null
  changePercent: number | null
}

export interface MonitoredAlert {
  id: string
  instrumentId: string
  condition: "above" | "below"
  value: number
  enabled: boolean
  lastTriggeredAt: number | null
}

export interface MarketsAdapter {
  /** Configured = a market-data provider key is set. */
  snapshot(): Promise<{
    configured: boolean
    message?: string
    instruments: MonitoredInstrument[]
    alerts: MonitoredAlert[]
  }>
  appendObservation(o: {
    instrumentId: string
    providerSymbol: string
    price: number | null
    changePercent: number | null
    ts: number
  }): void
  markAlertTriggered(alertId: string, at: number): void
}

let adapter: MarketsAdapter | null = null
/** Wire the watchlist data layer to the monitor once that refactor settles. */
export function registerMarketsAdapter(a: MarketsAdapter): void {
  adapter = a
}
export function getMarketsAdapter(): MarketsAdapter | null {
  return adapter
}

/**
 * Idempotently create the single system "Markets monitor" heartbeat task.
 * Gated on a registered adapter so we never run a useless no-op loop before
 * the watchlist data layer is wired. Call this right after registerMarketsAdapter().
 */
export async function ensureMarketsHeartbeat(options: {
  enabled: boolean
}): Promise<void> {
  if (!adapter) return
  const { listScheduledTasks, createScheduledTask, updateScheduledTask } =
    await import("@/lib/scheduling/store")
  const existing = listScheduledTasks().find(
    (t) => t.action.kind === "monitor" && t.action.monitorKind === "markets"
  )
  if (existing) {
    if (
      existing.createdBy === "system" &&
      existing.enabled !== options.enabled
    ) {
      updateScheduledTask(existing.id, { enabled: options.enabled })
    }
    return
  }
  createScheduledTask({
    title: "Markets monitor",
    action: { kind: "monitor", monitorKind: "markets" },
    // FIXED cheap cadence (intentionally not adaptive). 5 min keeps well
    // under free market-data rate limits while staying responsive; tune by
    // editing this task, not by any in-code algorithm.
    schedule: { kind: "every", everyMs: 5 * 60_000 },
    enabled: options.enabled,
    createdBy: "system",
  })
}

/** Asset-class-aware default "notable move" — crypto is noisy, indices calm. */
export function assetClassDefaultMovePercent(
  assetClass: MonitoredInstrument["assetClass"]
): number {
  switch (assetClass) {
    case "crypto":
      return 8
    case "forex":
      return 2
    case "index":
      return 1.5
    case "etf":
      return 2.5
    case "fund":
      return 2.5
    default:
      return 3 // stock / other
  }
}

// US cash-session heuristic (approx, no holiday calendar): Mon-Fri 09:30-16:00
// America/New_York. Good enough to suppress weekend/overnight stock noise;
// crypto/forex are 24/7 so always "open".
function isMarketOpen(
  assetClass: MonitoredInstrument["assetClass"],
  now: number
): boolean {
  if (assetClass === "crypto" || assetClass === "forex") return true
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(now))
  const wd = parts.find((p) => p.type === "weekday")?.value ?? ""
  if (wd === "Sat" || wd === "Sun") return false
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0")
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0")
  const mins = h * 60 + m
  return mins >= 9 * 60 + 30 && mins <= 16 * 60
}

function sessionKey(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now))
}

interface SymbolState {
  /** %-move already notified this session (signed). */
  lastNotifiedPct?: number
  lastNotifiedAt?: number
  session?: string
}
interface HeartbeatState {
  symbols?: Record<string, SymbolState>
  lastRunAt?: number
}

export interface CheapPassResult {
  noteworthy: boolean
  /** One-line summary recorded in Past runs even when silent. */
  summary: string
  /** Self-contained brief for the single consolidated model wake (only when noteworthy). */
  briefPrompt?: string
  /** New per-task state to persist. */
  nextState: Record<string, unknown>
}

/**
 * The no-model pass. Pure given the adapter; never throws.
 */
export async function runMarketsCheapPass(args: {
  priorState: Record<string, unknown> | null
  now: number
}): Promise<CheapPassResult> {
  const prior = (args.priorState ?? {}) as HeartbeatState
  const symbols: Record<string, SymbolState> = { ...(prior.symbols ?? {}) }
  const baseState: Record<string, unknown> = {
    ...prior,
    symbols,
    lastRunAt: args.now,
  }

  if (!adapter) {
    return {
      noteworthy: false,
      summary: "Markets monitor: watchlist data layer not wired yet — no-op.",
      nextState: baseState,
    }
  }

  let snap: Awaited<ReturnType<MarketsAdapter["snapshot"]>>
  try {
    snap = await adapter.snapshot()
  } catch (err) {
    return {
      noteworthy: false,
      summary: `Markets monitor: snapshot failed — ${err instanceof Error ? err.message : "unknown error"}.`,
      nextState: baseState,
    }
  }

  if (!snap.configured) {
    return {
      noteworthy: false,
      summary: snap.message || "Markets monitor: data provider not configured.",
      nextState: baseState,
    }
  }

  const session = sessionKey(args.now)
  const instrumentsById = new Map(snap.instruments.map((i) => [i.id, i]))
  const events: string[] = []
  let observed = 0
  let monitoredCount = 0
  let anyMarketOpen = false

  for (const inst of snap.instruments) {
    if (!inst.monitorEnabled) continue
    monitoredCount++
    adapter.appendObservation({
      instrumentId: inst.id,
      providerSymbol: inst.providerSymbol,
      price: inst.price,
      changePercent: inst.changePercent,
      ts: args.now,
    })
    observed++

    const open = isMarketOpen(inst.assetClass, args.now)
    if (open) anyMarketOpen = true
    if (inst.price == null) continue
    if (!open) continue

    const stateKey = inst.id
    const st = symbols[stateKey] ?? {}
    if (st.session !== session) {
      st.lastNotifiedPct = undefined
      st.lastNotifiedAt = undefined
      st.session = session
    }

    const threshold =
      inst.movePercent ?? assetClassDefaultMovePercent(inst.assetClass)
    const pct = inst.changePercent
    if (pct != null && Math.abs(pct) >= threshold) {
      // Dedupe: only (re-)notify if we haven't this session, OR it moved a
      // further half-threshold in the same direction since last notice.
      const last = st.lastNotifiedPct
      const movedFurther =
        last == null
          ? true
          : (pct > 0 && pct >= last + threshold / 2) ||
            (pct < 0 && pct <= last - threshold / 2)
      if (movedFurther) {
        events.push(
          `${inst.symbol} (${inst.name}) ${pct > 0 ? "+" : ""}${pct.toFixed(2)}% today → ${inst.price} (notable-move threshold ${threshold}%)`
        )
        st.lastNotifiedPct = pct
        st.lastNotifiedAt = args.now
      }
    }
    symbols[stateKey] = st
  }

  for (const alert of snap.alerts) {
    if (!alert.enabled) continue
    const inst = instrumentsById.get(alert.instrumentId)
    if (!inst || inst.price == null) continue
    const crossed =
      alert.condition === "above"
        ? inst.price >= alert.value
        : inst.price <= alert.value
    if (!crossed) continue
    // Don't re-fire the same alert within the same session.
    const firedThisSession =
      alert.lastTriggeredAt != null &&
      sessionKey(alert.lastTriggeredAt) === session
    if (firedThisSession) continue
    events.push(
      `${inst.symbol} (${inst.name}) ${alert.condition} ${alert.value} → now ${inst.price} (your price alert)`
    )
    adapter.markAlertTriggered(alert.id, args.now)
  }

  const nextState: Record<string, unknown> = {
    ...baseState,
    symbols,
  }

  if (events.length === 0) {
    return {
      noteworthy: false,
      summary: `Markets check: ${observed} observed, ${monitoredCount} monitored, ${anyMarketOpen ? "market open" : "market closed"} — nothing crossed thresholds.`,
      nextState,
    }
  }

  const briefPrompt = buildMarketsBriefPrompt(events)

  return {
    noteworthy: true,
    summary: `Markets monitor: ${events.length} crossing(s) — ${events.map((e) => e.split(" ")[0]).join(", ")}.`,
    briefPrompt,
    nextState,
  }
}

export function buildMarketsBriefPrompt(events: string[]): string {
  return [
    "Role: Run the scheduled markets monitor after the cheap pass detected threshold crossings.",
    "",
    "Goal: Explain the likely current catalyst for each crossing and send one factual grouped Inbox notification.",
    "",
    'Success criteria: every crossing has one concise move-and-catalyst line with a source link or "no clear catalyst"; notify_inbox is called exactly once; no investment advice or new schedule is created.',
    "",
    "Detected crossings:",
    "",
    ...events.map((e) => `- ${e}`),
    "",
    'Constraints and stop rules: research recent news, catalysts, earnings, or macro evidence; do not guess. Group all results into the single notification, call it once, then stop. Do not schedule anything.',
  ].join("\n")
}
