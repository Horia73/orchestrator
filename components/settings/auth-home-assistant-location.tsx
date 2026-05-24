"use client"

import * as React from "react"
import {
    AlertCircle,
    CheckCircle2,
    LocateFixed,
    Loader2,
    MapPinned,
    RefreshCcw,
} from "lucide-react"

import { Badge, InlineNotice } from "@/components/settings/auth-shared"
import type { NoticeTone } from "@/components/settings/auth-types"
import { Button } from "@/components/ui/button"
import type { HomeAssistantIntegrationStatusEntry } from "@/components/settings/use-integrations-status"

interface HomeAssistantLocationSource {
    provider: "home-assistant"
    entityId: string
    label?: string
    confirmedAt: number
}

interface HomeAssistantLocationCandidate {
    provider: "home-assistant"
    entityId: string
    domain: string
    label: string
    state: string
    position: [number, number] | null
    accuracyMeters: number | null
    lastUpdated: string | null
    selected: boolean
}

export function HomeAssistantLocationSourcePanel({ entry }: { entry: HomeAssistantIntegrationStatusEntry }) {
    const connected = entry.connected && !entry.needsReconnect
    const [source, setSource] = React.useState<HomeAssistantLocationSource | null>(null)
    const [candidates, setCandidates] = React.useState<HomeAssistantLocationCandidate[]>([])
    const [selectedEntityId, setSelectedEntityId] = React.useState("")
    const [loading, setLoading] = React.useState(false)
    const [saving, setSaving] = React.useState(false)
    const [feedback, setFeedback] = React.useState<{
        tone: NoticeTone
        text: string
    } | null>(null)

    const load = React.useCallback(async () => {
        if (!connected) {
            setSource(null)
            setCandidates([])
            setSelectedEntityId("")
            return
        }

        setLoading(true)
        setFeedback(null)
        try {
            const res = await fetch("/api/maps/location-source?candidates=1", {
                cache: "no-store",
            })
            const json = (await res.json().catch(() => ({}))) as {
                source?: HomeAssistantLocationSource | null
                candidates?: HomeAssistantLocationCandidate[]
                candidatesError?: string
            }
            if (!res.ok) throw new Error(json.candidatesError || `Could not load location entities (${res.status}).`)
            const nextSource = json.source ?? null
            const nextCandidates = json.candidates ?? []
            setSource(nextSource)
            setCandidates(nextCandidates)
            setSelectedEntityId(
                nextSource?.entityId ?? nextCandidates.find((candidate) => candidate.selected)?.entityId ?? ""
            )
            if (json.candidatesError) setFeedback({ tone: "warning", text: json.candidatesError })
        } catch (err) {
            setFeedback({
                tone: "error",
                text: err instanceof Error ? err.message : "Could not load Home Assistant location entities.",
            })
        } finally {
            setLoading(false)
        }
    }, [connected])

    React.useEffect(() => {
        void load()
    }, [load])

    const selectedCandidate = candidates.find((candidate) => candidate.entityId === selectedEntityId) ?? null

    const save = async () => {
        if (!selectedEntityId) return
        setSaving(true)
        setFeedback(null)
        try {
            const res = await fetch("/api/maps/location-source", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    provider: "home-assistant",
                    entityId: selectedEntityId,
                    label: selectedCandidate?.label,
                }),
            })
            const json = (await res.json().catch(() => ({}))) as {
                source?: HomeAssistantLocationSource
                error?: string
            }
            if (!res.ok) throw new Error(json.error || `Could not save location source (${res.status}).`)
            setSource(json.source ?? null)
            setFeedback({
                tone: "success",
                text: "Home Assistant live location source saved.",
            })
        } catch (err) {
            setFeedback({
                tone: "error",
                text: err instanceof Error ? err.message : "Could not save Home Assistant location source.",
            })
        } finally {
            setSaving(false)
        }
    }

    const clear = async () => {
        setSaving(true)
        setFeedback(null)
        try {
            const res = await fetch("/api/maps/location-source", { method: "DELETE" })
            const json = (await res.json().catch(() => ({}))) as { error?: string }
            if (!res.ok) throw new Error(json.error || `Could not clear location source (${res.status}).`)
            setSource(null)
            setSelectedEntityId("")
            setFeedback({
                tone: "success",
                text: "Home Assistant live location source cleared.",
            })
        } catch (err) {
            setFeedback({
                tone: "error",
                text: err instanceof Error ? err.message : "Could not clear Home Assistant location source.",
            })
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3 text-[12px] text-foreground/65">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <MapPinned className="size-3.5 text-foreground/55" />
                        <span className="font-medium text-foreground/75">Live location source</span>
                        <Badge
                            tone={source ? "success" : "muted"}
                            icon={source ? <CheckCircle2 className="size-3" /> : <AlertCircle className="size-3" />}
                        >
                            {source ? source.entityId : "Not selected"}
                        </Badge>
                    </div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-foreground/55">
                        Default for Smart Maps. Browser geolocation is used only when this Home Assistant source is
                        missing or unavailable.
                    </p>
                </div>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void load()}
                    disabled={!connected || loading || saving}
                >
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
                    Refresh
                </Button>
            </div>

            {!connected ? (
                <p className="mt-3 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-2 text-[11.5px] text-foreground/55">
                    Connect Home Assistant to choose a live location entity.
                </p>
            ) : (
                <div className="mt-3 grid gap-2">
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <select
                            value={selectedEntityId}
                            onChange={(event) => setSelectedEntityId(event.target.value)}
                            disabled={loading || saving}
                            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground transition-colors outline-none focus:border-ring"
                            aria-label="Home Assistant live location entity"
                        >
                            <option value="">Select person/device_tracker entity</option>
                            {candidates.map((candidate) => (
                                <option key={candidate.entityId} value={candidate.entityId}>
                                    {candidate.label} - {candidate.entityId}
                                    {candidate.position ? "" : ` - ${candidate.state}`}
                                </option>
                            ))}
                        </select>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => void save()}
                                disabled={!selectedEntityId || loading || saving}
                            >
                                {saving ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                    <LocateFixed className="size-3.5" />
                                )}
                                Save
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void clear()}
                                disabled={!source || loading || saving}
                            >
                                Clear
                            </Button>
                        </div>
                    </div>

                    {selectedCandidate && (
                        <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-background/70 px-2.5 py-2 text-[11.5px]">
                            <span className="text-foreground/45">Entity</span>
                            <span className="truncate text-foreground/75">{selectedCandidate.entityId}</span>
                            <span className="text-foreground/45">State</span>
                            <span className="truncate text-foreground/75">{selectedCandidate.state}</span>
                            <span className="text-foreground/45">Coordinates</span>
                            <span className="truncate text-foreground/75">
                                {selectedCandidate.position
                                    ? `${selectedCandidate.position[1].toFixed(5)}, ${selectedCandidate.position[0].toFixed(5)}`
                                    : "Resolved from Home Assistant zone when possible"}
                            </span>
                        </div>
                    )}
                </div>
            )}

            {feedback && <InlineNotice tone={feedback.tone} text={feedback.text} />}
        </div>
    )
}
