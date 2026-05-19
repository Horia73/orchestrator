"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { ScheduledTask } from "@/lib/scheduling/schema"
import type { NewTaskPayload } from "./use-scheduling"

const SYSTEM_TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } catch { return "UTC" }
})()

type ActionType = "agent" | "tool" | "monitor"
type MonitorKind = Extract<NewTaskPayload["action"], { kind: "monitor" }>["monitorKind"]
type SchedKind = "in" | "once" | "dailyAt" | "weeklyAt" | "every" | "cron"
type Unit = "m" | "h" | "d"
const UNIT_MS: Record<Unit, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const WEEKDAYS = [
    { v: 1, l: "Mon" }, { v: 2, l: "Tue" }, { v: 3, l: "Wed" }, { v: 4, l: "Thu" },
    { v: 5, l: "Fri" }, { v: 6, l: "Sat" }, { v: 0, l: "Sun" },
]
const UNIT_OPTS = [
    { value: "m", label: "minutes" }, { value: "h", label: "hours" }, { value: "d", label: "days" },
]
const SCHED_OPTS = [
    { value: "in", label: "In (relative, once)" },
    { value: "once", label: "At (absolute, once)" },
    { value: "dailyAt", label: "Daily at" },
    { value: "weeklyAt", label: "Weekly on" },
    { value: "every", label: "Every (interval)" },
    { value: "cron", label: "Cron expression" },
]
const MONITOR_INFO: Record<MonitorKind, { label: string; checks: string; execution: string; output: string }> = {
    markets: {
        label: "Markets monitor",
        checks: "Enabled watchlist instruments, price alerts, and notable move thresholds.",
        execution: "Runs the markets heartbeat cheap pass without a model. If a threshold crosses, it wakes the orchestrator once to research the cause.",
        output: "Silent checks are recorded in Past runs. Noteworthy crossings are sent to Inbox.",
    },
}

function toLocalInput(ms: number): string {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
    return d.toISOString().slice(0, 16)
}
function pad(n: number): string { return n.toString().padStart(2, "0") }
function intervalToForm(ms: number): { amount: number; unit: Unit } {
    if (ms % UNIT_MS.d === 0) return { amount: ms / UNIT_MS.d, unit: "d" }
    if (ms % UNIT_MS.h === 0) return { amount: ms / UNIT_MS.h, unit: "h" }
    return { amount: Math.max(1, Math.round(ms / UNIT_MS.m)), unit: "m" }
}

interface FormState {
    title: string
    actionType: ActionType
    agentId: string
    agentPrompt: string
    toolId: string
    toolSummary: string
    toolArgs: string
    monitorKind: MonitorKind
    schedKind: SchedKind
    onceLocal: string
    inAmount: number
    inUnit: Unit
    timeHM: string
    weekdays: number[]
    everyAmount: number
    everyUnit: Unit
    cronExpr: string
    timezone: string
    enabled: boolean
}

function initialState(task?: ScheduledTask): FormState {
    const base: FormState = {
        title: "", actionType: "agent", agentId: "orchestrator", agentPrompt: "",
        toolId: "", toolSummary: "", toolArgs: "{}", monitorKind: "markets",
        schedKind: "in", onceLocal: toLocalInput(Date.now() + 3_600_000),
        inAmount: 7, inUnit: "h", timeHM: "09:00", weekdays: [1, 2, 3, 4, 5],
        everyAmount: 1, everyUnit: "h", cronExpr: "0 9 * * *", timezone: SYSTEM_TZ, enabled: true,
    }
    if (!task) return base
    const next: FormState = { ...base, title: task.title, enabled: task.enabled }
    if (task.action.kind === "agent") {
        next.actionType = "agent"; next.agentId = task.action.agentId; next.agentPrompt = task.action.prompt
    } else if (task.action.kind === "tool") {
        next.actionType = "tool"; next.toolId = task.action.toolId
        next.toolSummary = task.action.summary; next.toolArgs = JSON.stringify(task.action.args ?? {}, null, 2)
    } else if (task.action.kind === "monitor") {
        next.actionType = "monitor"; next.monitorKind = task.action.monitorKind
    }
    const s = task.schedule
    if (s.kind === "once") { next.schedKind = "once"; next.onceLocal = toLocalInput(s.fireAt) }
    else if (s.kind === "every") {
        const every = intervalToForm(s.everyMs)
        next.schedKind = "every"; next.everyAmount = every.amount; next.everyUnit = every.unit
    }
    else if (s.kind === "dailyAt") { next.schedKind = "dailyAt"; next.timeHM = `${pad(s.hour)}:${pad(s.minute)}`; next.timezone = s.timezone }
    else if (s.kind === "weeklyAt") { next.schedKind = "weeklyAt"; next.weekdays = s.weekdays; next.timeHM = `${pad(s.hour)}:${pad(s.minute)}`; next.timezone = s.timezone }
    else if (s.kind === "cron") { next.schedKind = "cron"; next.cronExpr = s.expression; next.timezone = s.timezone }
    return next
}

function buildPayload(f: FormState): NewTaskPayload | { error: string } {
    if (!f.title.trim()) return { error: "Title is required." }
    let action: NewTaskPayload["action"]
    if (f.actionType === "agent") {
        if (!f.agentPrompt.trim()) return { error: "Prompt is required for an agent task." }
        action = { kind: "agent", agentId: f.agentId.trim() || "orchestrator", prompt: f.agentPrompt.trim() }
    } else if (f.actionType === "tool") {
        if (!f.toolId.trim()) return { error: "Tool id is required for a tool task." }
        let args: Record<string, unknown> = {}
        try {
            const parsed = f.toolArgs.trim() ? JSON.parse(f.toolArgs) : {}
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed
            else return { error: "Tool args must be a JSON object." }
        } catch { return { error: "Tool args is not valid JSON." } }
        action = { kind: "tool", toolId: f.toolId.trim(), args, summary: f.toolSummary.trim() || `Run ${f.toolId.trim()}` }
    } else {
        action = { kind: "monitor", monitorKind: f.monitorKind }
    }

    let schedule: NewTaskPayload["schedule"]
    const hm = /^(\d{1,2}):(\d{2})$/.exec(f.timeHM)
    if (f.schedKind === "once") {
        const ts = new Date(f.onceLocal).getTime()
        if (Number.isNaN(ts)) return { error: "Pick a valid date/time." }
        if (ts <= Date.now()) return { error: "The chosen time is in the past." }
        schedule = { kind: "once", fireAt: ts }
    } else if (f.schedKind === "in") {
        if (!(f.inAmount > 0)) return { error: "Delay must be greater than 0." }
        schedule = { kind: "once", fireAt: Date.now() + f.inAmount * UNIT_MS[f.inUnit] }
    } else if (f.schedKind === "every") {
        const everyMs = f.everyAmount * UNIT_MS[f.everyUnit]
        if (everyMs < 60_000) return { error: "Interval must be at least 1 minute." }
        schedule = { kind: "every", everyMs }
    } else if (f.schedKind === "dailyAt") {
        if (!hm) return { error: "Time must be HH:MM." }
        schedule = { kind: "dailyAt", hour: +hm[1], minute: +hm[2], timezone: f.timezone.trim() || SYSTEM_TZ }
    } else if (f.schedKind === "weeklyAt") {
        if (!hm) return { error: "Time must be HH:MM." }
        if (f.weekdays.length === 0) return { error: "Pick at least one weekday." }
        schedule = { kind: "weeklyAt", weekdays: [...f.weekdays].sort(), hour: +hm[1], minute: +hm[2], timezone: f.timezone.trim() || SYSTEM_TZ }
    } else {
        if (!f.cronExpr.trim()) return { error: "Cron expression is required." }
        schedule = { kind: "cron", expression: f.cronExpr.trim(), timezone: f.timezone.trim() || SYSTEM_TZ }
    }
    return { title: f.title.trim(), action, schedule, enabled: f.enabled }
}

const fieldCls = "h-9 w-full rounded-md border border-border/70 bg-background px-3 text-[14px] outline-none focus:ring-2 focus:ring-foreground/15"
const labelCls = "mb-1 block text-[12px] font-medium tracking-wide text-foreground/55 uppercase"

export function TaskForm({
    task, onSubmit, onCancel,
}: {
    task?: ScheduledTask
    onSubmit: (payload: NewTaskPayload) => Promise<void>
    onCancel: () => void
}) {
    const [f, setF] = React.useState<FormState>(() => initialState(task))
    const [error, setError] = React.useState<string | null>(null)
    const [saving, setSaving] = React.useState(false)
    const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF(prev => ({ ...prev, [k]: v }))
    const taskId = task?.id ?? null
    const seededTaskId = React.useRef<string | null>(taskId)

    React.useEffect(() => {
        if (seededTaskId.current === taskId) return
        seededTaskId.current = taskId
        setF(initialState(task))
        setError(null)
        setSaving(false)
    }, [task, taskId])

    const submit = async () => {
        const built = buildPayload(f)
        if ("error" in built) { setError(built.error); return }
        setSaving(true); setError(null)
        try { await onSubmit(built) }
        catch (err) { setError(err instanceof Error ? err.message : "Failed to save task") }
        finally { setSaving(false) }
    }

    const needsTz = f.schedKind === "dailyAt" || f.schedKind === "weeklyAt" || f.schedKind === "cron"
    const actionOptions: ActionType[] = f.actionType === "monitor" ? ["monitor"] : ["agent", "tool"]

    return (
        <div className="space-y-5">
            <div>
                <label className={labelCls}>Title</label>
                <input className={fieldCls} value={f.title} placeholder="e.g. Morning email digest"
                    onChange={e => set("title", e.target.value)} />
            </div>

            <div>
                <label className={labelCls}>Action</label>
                <div className="mb-3 flex gap-2">
                    {actionOptions.map(t => (
                        <button key={t} type="button" onClick={() => t !== "monitor" && set("actionType", t)}
                            disabled={t === "monitor"}
                            className={cn("rounded-md px-3 py-1.5 text-[13px] ring-1 ring-border/70",
                                f.actionType === t ? "bg-[#f0ede6] text-foreground dark:bg-muted" : "text-foreground/60 hover:text-foreground")}>
                            {t === "agent" ? "Agent (wake a model)" : t === "tool" ? "Tool (deterministic)" : "Monitor (system)"}
                        </button>
                    ))}
                </div>
                {f.actionType === "monitor" ? (
                    <MonitorActionDetails monitorKind={f.monitorKind} />
                ) : f.actionType === "agent" ? (
                    <div className="space-y-3">
                        <textarea className={cn(fieldCls, "h-48 py-2 leading-relaxed")} value={f.agentPrompt}
                            placeholder="What should the agent do when this fires? For a monitor, say: do the check, and call notify_inbox only if <criteria>; otherwise stay silent."
                            onChange={e => set("agentPrompt", e.target.value)} />
                        <div>
                            <label className={labelCls}>Agent id</label>
                            <input className={fieldCls} value={f.agentId} onChange={e => set("agentId", e.target.value)} />
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <input className={fieldCls} value={f.toolId} placeholder="Tool id, e.g. HomeAssistantSetLight"
                            onChange={e => set("toolId", e.target.value)} />
                        <input className={fieldCls} value={f.toolSummary} placeholder="Summary shown in Inbox/Past runs"
                            onChange={e => set("toolSummary", e.target.value)} />
                        <textarea className={cn(fieldCls, "h-32 py-2 font-mono text-[13px]")} value={f.toolArgs}
                            placeholder='{"entity_id": "light.living_room", "state": "on"}'
                            onChange={e => set("toolArgs", e.target.value)} />
                    </div>
                )}
            </div>

            <div>
                <label className={labelCls}>When</label>
                <Select className="mb-3" value={f.schedKind} options={SCHED_OPTS}
                    onValueChange={v => set("schedKind", v as SchedKind)} />

                {f.schedKind === "in" && (
                    <div className="flex gap-2">
                        <input type="number" min={1} className={fieldCls} value={f.inAmount}
                            onChange={e => set("inAmount", Number(e.target.value))} />
                        <Select className="w-40" value={f.inUnit} options={UNIT_OPTS}
                            onValueChange={v => set("inUnit", v as Unit)} />
                    </div>
                )}
                {f.schedKind === "once" && (
                    <input type="datetime-local" className={fieldCls} value={f.onceLocal}
                        onChange={e => set("onceLocal", e.target.value)} />
                )}
                {f.schedKind === "every" && (
                    <div className="flex gap-2">
                        <input type="number" min={1} className={fieldCls} value={f.everyAmount}
                            onChange={e => set("everyAmount", Number(e.target.value))} />
                        <Select className="w-40" value={f.everyUnit} options={UNIT_OPTS}
                            onValueChange={v => set("everyUnit", v as Unit)} />
                    </div>
                )}
                {(f.schedKind === "dailyAt" || f.schedKind === "weeklyAt") && (
                    <input type="time" className={cn(fieldCls, "mb-2")} value={f.timeHM}
                        onChange={e => set("timeHM", e.target.value)} />
                )}
                {f.schedKind === "weeklyAt" && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                        {WEEKDAYS.map(d => {
                            const on = f.weekdays.includes(d.v)
                            return (
                                <button key={d.v} type="button"
                                    onClick={() => set("weekdays", on ? f.weekdays.filter(x => x !== d.v) : [...f.weekdays, d.v])}
                                    className={cn("rounded-md px-2.5 py-1 text-[12px] ring-1 ring-border/70",
                                        on ? "bg-[#f0ede6] text-foreground dark:bg-muted" : "text-foreground/55")}>
                                    {d.l}
                                </button>
                            )
                        })}
                    </div>
                )}
                {f.schedKind === "cron" && (
                    <input className={cn(fieldCls, "font-mono")} value={f.cronExpr} placeholder="0 9 * * 1-5"
                        onChange={e => set("cronExpr", e.target.value)} />
                )}
                {needsTz && (
                    <div className="mt-2">
                        <label className={labelCls}>Timezone</label>
                        <input className={fieldCls} value={f.timezone} onChange={e => set("timezone", e.target.value)} />
                    </div>
                )}
            </div>

            <div className="flex items-center gap-2 text-[14px] text-foreground/75">
                <Switch checked={f.enabled} onCheckedChange={v => set("enabled", v)} aria-label="Enabled" />
                Enabled
            </div>

            {error && <div className="rounded-md bg-red-50 px-3 py-2 text-[13px] text-[#802020]">{error}</div>}

            <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
                <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : task ? "Save changes" : "Create task"}</Button>
            </div>
        </div>
    )
}

function MonitorActionDetails({ monitorKind }: { monitorKind: MonitorKind }) {
    const info = MONITOR_INFO[monitorKind]
    return (
        <div className="grid gap-3 rounded-md border border-border/70 bg-muted/25 p-3 text-[13px]">
            <div>
                <label className={labelCls}>Monitor id</label>
                <div className={cn(fieldCls, "flex items-center font-mono text-[13px] text-foreground/75")}>
                    monitor:{monitorKind}
                </div>
            </div>
            <InfoRow label="Handler" value={info.label} />
            <InfoRow label="Checks" value={info.checks} />
            <InfoRow label="Execution" value={info.execution} />
            <InfoRow label="Output" value={info.output} />
        </div>
    )
}

function InfoRow({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className={labelCls}>{label}</div>
            <div className="text-[13px] leading-relaxed text-foreground/70">{value}</div>
        </div>
    )
}
