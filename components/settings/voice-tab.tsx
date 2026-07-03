"use client"

import * as React from "react"
import { AudioLines, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface VoiceConfigResponse {
  enabled: boolean
  configured: boolean
  model: string
  voiceName: string
  languageCode: string
  homeAssistant: { allowedDomains: string[]; blockedDomains: string[] }
  voiceOptions: string[]
  liveModels: string[]
}

export function VoiceTab() {
  const [config, setConfig] = React.useState<VoiceConfigResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [feedback, setFeedback] = React.useState<string | null>(null)
  const [allowedDomainsDraft, setAllowedDomainsDraft] = React.useState("")

  const load = React.useCallback(async () => {
    try {
      const response = await fetch("/api/voice/config", { cache: "no-store" })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as VoiceConfigResponse
      setConfig(data)
      setAllowedDomainsDraft(data.homeAssistant.allowedDomains.join(", "))
    } catch {
      setFeedback("Could not load voice settings.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const save = React.useCallback(
    async (patch: Record<string, unknown>) => {
      setSaving(true)
      setFeedback(null)
      try {
        const response = await fetch("/api/voice/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = (await response.json()) as { voice: VoiceConfigResponse }
        setConfig((current) =>
          current ? { ...current, ...data.voice } : current
        )
        setFeedback("Saved.")
      } catch {
        setFeedback("Could not save voice settings.")
      } finally {
        setSaving(false)
      }
    },
    []
  )

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading voice settings…
      </div>
    )
  }
  if (!config) {
    return (
      <div className="py-10 text-[14px] text-muted-foreground">
        {feedback ?? "Voice settings unavailable."}
      </div>
    )
  }

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-[15px] font-medium">
              <AudioLines className="size-4" strokeWidth={1.5} />
              Live voice mode
            </h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Real-time spoken conversations (Gemini Live). Open it from the
              waveform button in the chat composer.
            </p>
          </div>
          <Button
            variant={config.enabled ? "default" : "outline"}
            size="sm"
            disabled={saving}
            onClick={() => save({ enabled: !config.enabled })}
          >
            {config.enabled ? "Enabled" : "Disabled"}
          </Button>
        </div>
        {!config.configured && (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-[13px] text-amber-600">
            Voice mode needs the Google API key (Settings → Models → Google).
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-[14px] font-medium">Voice</h4>
        <p className="text-[13px] text-muted-foreground">
          The prebuilt voice used for spoken replies.
        </p>
        <select
          value={config.voiceName}
          disabled={saving}
          onChange={(event) => save({ voiceName: event.target.value })}
          className="h-9 w-56 rounded-md border border-border bg-background px-2 text-[14px]"
        >
          {config.voiceOptions.map((voice) => (
            <option key={voice} value={voice}>
              {voice}
            </option>
          ))}
        </select>
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-[14px] font-medium">Live model</h4>
        <p className="text-[13px] text-muted-foreground">
          “Automatic” always picks the newest live-capable Flash model from
          Google&apos;s catalog.
        </p>
        <select
          value={config.model}
          disabled={saving}
          onChange={(event) => save({ model: event.target.value })}
          className="h-9 w-full max-w-md rounded-md border border-border bg-background px-2 text-[14px]"
        >
          <option value="auto">Automatic (recommended)</option>
          {config.liveModels.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-[14px] font-medium">Home Assistant voice allowlist</h4>
        <p className="text-[13px] text-muted-foreground">
          Domains the voice assistant may control. Security domains (
          {config.homeAssistant.blockedDomains.join(", ")}) are always blocked
          from voice.
        </p>
        <textarea
          value={allowedDomainsDraft}
          disabled={saving}
          onChange={(event) => setAllowedDomainsDraft(event.target.value)}
          onBlur={() =>
            save({
              homeAssistant: {
                allowedDomains: allowedDomainsDraft
                  .split(",")
                  .map((domain) => domain.trim())
                  .filter(Boolean),
                blockedDomains: config.homeAssistant.blockedDomains,
              },
            })
          }
          rows={2}
          className="w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-[14px]"
        />
      </section>

      {feedback && (
        <p
          className={cn(
            "text-[13px]",
            feedback === "Saved." ? "text-muted-foreground" : "text-red-500"
          )}
        >
          {feedback}
        </p>
      )}
    </div>
  )
}
