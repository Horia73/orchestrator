"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2, RefreshCcw } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  AUTH_SERVICE_IDS,
  DEFAULT_AUTH_SERVICE_ID,
  authStatusDotClass,
  buildAuthServiceDescriptors,
  isAuthServiceId,
  type AuthServiceDescriptor,
  type AuthServiceId,
  type AuthStatusTone,
} from "@/components/settings/auth-tab-helpers"
import { InlineNotice } from "@/components/settings/auth-shared"
import {
  localhostRedirectNotice,
  shouldWarnAboutLocalhostRedirect,
} from "@/components/settings/auth-google-oauth"
import { HomeAssistantCard } from "@/components/settings/auth-home-assistant"
import {
  GmailCard,
  GoogleCalendarCard,
  GoogleWorkspaceCard,
  LocationIntelligenceCard,
  MapsWeatherCard,
  WhatsAppCard,
} from "@/components/settings/auth-service-cards"
import type {
  BusyAction,
  GmailConfigInput,
  GoogleCalendarConfigInput,
  GoogleDriveConfigInput,
  GoogleMapsConfigInput,
  HomeAssistantConfigInput,
  NoticeTone,
} from "@/components/settings/auth-types"
import { Button } from "@/components/ui/button"
import { CliAccountsSection } from "@/components/settings/cli-accounts"
import {
  useIntegrationsStatus,
  type HomeAssistantIntegrationStatusEntry,
  type MapsIntegrationStatusEntry,
  type WeatherIntegrationStatusEntry,
  type WhatsAppIntegrationStatusEntry,
} from "@/components/settings/use-integrations-status"

type OAuthMessage = {
  type?: string
  provider?: string
  ok?: boolean
  message?: string
}

export function AuthTab() {
  return (
    <div className="flex flex-col gap-6">
      <ConnectedServicesSection />
      <div className="border-t border-border/60 pt-6">
        <CliAccountsSection />
      </div>
    </div>
  )
}

function ConnectedServicesSection() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { data, loading, error, refresh } = useIntegrationsStatus()
  const [busy, setBusy] = React.useState<BusyAction>(null)
  const [feedback, setFeedback] = React.useState<{
    tone: NoticeTone
    text: string
  } | null>(null)
  const selectedServiceFromUrl = searchParams.get("auth")
  const [selectedServiceId, setSelectedServiceId] =
    React.useState<AuthServiceId>(
      isAuthServiceId(selectedServiceFromUrl)
        ? selectedServiceFromUrl
        : DEFAULT_AUTH_SERVICE_ID
    )
  const popupRef = React.useRef<Window | null>(null)

  React.useEffect(() => {
    if (isAuthServiceId(selectedServiceFromUrl)) {
      setSelectedServiceId((current) =>
        current === selectedServiceFromUrl ? current : selectedServiceFromUrl
      )
    }
  }, [selectedServiceFromUrl])

  React.useEffect(() => {
    const handler = (event: MessageEvent<OAuthMessage>) => {
      if (event.origin !== window.location.origin) return
      if (event.data?.type !== "orchestrator:integration-auth") return
      if (
        event.data.provider !== "gmail" &&
        event.data.provider !== "googleCalendar" &&
        event.data.provider !== "googleDrive"
      )
        return
      setBusy(null)
      const label =
        event.data.provider === "googleCalendar"
          ? "Google Calendar"
          : event.data.provider === "googleDrive"
            ? "Google Workspace"
            : "Gmail"
      setFeedback({
        tone: event.data.ok === true ? "success" : "error",
        text:
          event.data.message ||
          (event.data.ok
            ? `${label} connected.`
            : `${label} authorization failed.`),
      })
      void refresh()
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [refresh])

  React.useEffect(() => {
    if (
      busy !== "connect" &&
      busy !== "google-calendar-connect" &&
      busy !== "google-drive-connect"
    )
      return
    const timer = window.setInterval(() => {
      if (popupRef.current?.closed) {
        popupRef.current = null
        setBusy(null)
        void refresh()
      }
    }, 1200)
    return () => window.clearInterval(timer)
  }, [busy, refresh])

  React.useEffect(() => {
    const phase = data?.whatsapp.phase
    if (phase !== "starting" && phase !== "qr" && phase !== "authenticated")
      return
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [data?.whatsapp.phase, refresh])

  const connectGmail = async () => {
    setBusy("connect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/gmail/oauth/start", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as {
        authUrl?: string
        redirectUri?: string
        error?: string
      }
      if (!res.ok || !json.authUrl)
        throw new Error(json.error || `OAuth start failed (${res.status})`)
      if (
        json.redirectUri &&
        shouldWarnAboutLocalhostRedirect(json.redirectUri)
      ) {
        setFeedback(localhostRedirectNotice(json.redirectUri, data?.runtime))
      }

      const popup = window.open(
        json.authUrl,
        "orchestrator-gmail-oauth",
        "popup=yes,width=560,height=760,menubar=no,toolbar=no,location=yes,status=no"
      )
      if (!popup) {
        window.location.assign(json.authUrl)
        return
      }
      popupRef.current = popup
      popup.focus()
    } catch (err) {
      setBusy(null)
      setFeedback({
        tone: "error",
        text:
          err instanceof Error ? err.message : "Could not start Gmail OAuth.",
      })
    }
  }

  const disconnectGmail = async () => {
    const confirmed = window.confirm(
      "Disconnect Gmail from Orchestrator? Stored Gmail OAuth tokens will be removed locally."
    )
    if (!confirmed) return
    setBusy("disconnect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/gmail/disconnect", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok)
        throw new Error(json.error || `Disconnect failed (${res.status})`)
      setFeedback({ tone: "success", text: "Gmail disconnected." })
      await refresh()
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error ? err.message : "Could not disconnect Gmail.",
      })
    } finally {
      setBusy(null)
    }
  }

  const saveGmailConfig = async (input: GmailConfigInput): Promise<boolean> => {
    setBusy("save")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/gmail/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
      setFeedback({ tone: "success", text: "Gmail OAuth config saved." })
      await refresh()
      return true
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not save Gmail OAuth config.",
      })
      return false
    } finally {
      setBusy(null)
    }
  }

  const connectGoogleCalendar = async () => {
    setBusy("google-calendar-connect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/google-calendar/oauth/start", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as {
        authUrl?: string
        redirectUri?: string
        error?: string
      }
      if (!res.ok || !json.authUrl)
        throw new Error(json.error || `OAuth start failed (${res.status})`)
      if (
        json.redirectUri &&
        shouldWarnAboutLocalhostRedirect(json.redirectUri)
      ) {
        setFeedback(localhostRedirectNotice(json.redirectUri, data?.runtime))
      }

      const popup = window.open(
        json.authUrl,
        "orchestrator-google-calendar-oauth",
        "popup=yes,width=560,height=760,menubar=no,toolbar=no,location=yes,status=no"
      )
      if (!popup) {
        window.location.assign(json.authUrl)
        return
      }
      popupRef.current = popup
      popup.focus()
    } catch (err) {
      setBusy(null)
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not start Google Calendar OAuth.",
      })
    }
  }

  const disconnectGoogleCalendar = async () => {
    const confirmed = window.confirm(
      "Disconnect Google Calendar from Orchestrator? Stored Google Calendar OAuth tokens will be removed locally."
    )
    if (!confirmed) return
    setBusy("google-calendar-disconnect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/google-calendar/disconnect", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok)
        throw new Error(json.error || `Disconnect failed (${res.status})`)
      setFeedback({ tone: "success", text: "Google Calendar disconnected." })
      await refresh()
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not disconnect Google Calendar.",
      })
    } finally {
      setBusy(null)
    }
  }

  const saveGoogleCalendarConfig = async (
    input: GoogleCalendarConfigInput
  ): Promise<boolean> => {
    setBusy("google-calendar-save")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/google-calendar/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
      setFeedback({
        tone: "success",
        text: "Google Workspace OAuth config saved.",
      })
      await refresh()
      return true
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not save Google Calendar OAuth config.",
      })
      return false
    } finally {
      setBusy(null)
    }
  }

  const connectGoogleDrive = async () => {
    setBusy("google-drive-connect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/google-drive/oauth/start", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as {
        authUrl?: string
        redirectUri?: string
        error?: string
      }
      if (!res.ok || !json.authUrl)
        throw new Error(json.error || `OAuth start failed (${res.status})`)
      if (
        json.redirectUri &&
        shouldWarnAboutLocalhostRedirect(json.redirectUri)
      ) {
        setFeedback(localhostRedirectNotice(json.redirectUri, data?.runtime))
      }

      const popup = window.open(
        json.authUrl,
        "orchestrator-google-drive-oauth",
        "popup=yes,width=560,height=760,menubar=no,toolbar=no,location=yes,status=no"
      )
      if (!popup) {
        window.location.assign(json.authUrl)
        return
      }
      popupRef.current = popup
      popup.focus()
    } catch (err) {
      setBusy(null)
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not start Google Workspace OAuth.",
      })
    }
  }

  const disconnectGoogleDrive = async () => {
    const confirmed = window.confirm(
      "Disconnect Google Workspace from Orchestrator? Stored Google Workspace OAuth tokens will be removed locally."
    )
    if (!confirmed) return
    setBusy("google-drive-disconnect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/google-drive/disconnect", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok)
        throw new Error(json.error || `Disconnect failed (${res.status})`)
      setFeedback({ tone: "success", text: "Google Workspace disconnected." })
      await refresh()
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not disconnect Google Workspace.",
      })
    } finally {
      setBusy(null)
    }
  }

  const saveGoogleDriveConfig = async (
    input: GoogleDriveConfigInput
  ): Promise<boolean> => {
    setBusy("google-drive-save")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/google-drive/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
      setFeedback({
        tone: "success",
        text: "Google Workspace OAuth config saved.",
      })
      await refresh()
      return true
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not save Google Workspace OAuth config.",
      })
      return false
    } finally {
      setBusy(null)
    }
  }

  const connectWhatsApp = async () => {
    setBusy("whatsapp-connect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/whatsapp/start", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as {
        status?: WhatsAppIntegrationStatusEntry
        error?: string
      }
      if (!res.ok || !json.status)
        throw new Error(json.error || `WhatsApp start failed (${res.status})`)

      setFeedback({
        tone: "success",
        text: json.status.connected
          ? "WhatsApp connected."
          : json.status.qrAvailable
            ? "Scan the WhatsApp QR code with your phone."
            : json.status.phase === "authenticated" ||
                json.status.phase === "starting"
              ? "WhatsApp is linking. It will switch to Connected as soon as WhatsApp Web is ready."
              : "WhatsApp is starting. The QR code will appear here when ready.",
      })
      await refresh()
    } catch (err) {
      setFeedback({
        tone: "error",
        text: err instanceof Error ? err.message : "Could not start WhatsApp.",
      })
    } finally {
      setBusy(null)
    }
  }

  const disconnectWhatsApp = async () => {
    const confirmed = window.confirm(
      "Disconnect WhatsApp from Orchestrator? Stored local WhatsApp Web session files will be removed."
    )
    if (!confirmed) return
    setBusy("whatsapp-disconnect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/whatsapp/disconnect", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok)
        throw new Error(json.error || `Disconnect failed (${res.status})`)
      setFeedback({ tone: "success", text: "WhatsApp disconnected." })
      await refresh()
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error ? err.message : "Could not disconnect WhatsApp.",
      })
    } finally {
      setBusy(null)
    }
  }

  const saveHomeAssistantConfig = async (
    input: HomeAssistantConfigInput
  ): Promise<boolean> => {
    setBusy("homeassistant-save")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/home-assistant/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        homeAssistant?: HomeAssistantIntegrationStatusEntry
      }
      if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
      setFeedback({
        tone: json.homeAssistant?.connected === true ? "success" : "warning",
        text: json.homeAssistant?.connected
          ? "Home Assistant config saved and verified."
          : "Home Assistant config saved, but the API could not be verified yet.",
      })
      await refresh()
      return true
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not save Home Assistant config.",
      })
      return false
    } finally {
      setBusy(null)
    }
  }

  const disconnectHomeAssistant = async () => {
    const confirmed = window.confirm(
      "Remove Home Assistant URL and token from local Orchestrator config?"
    )
    if (!confirmed) return
    setBusy("homeassistant-disconnect")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/home-assistant/disconnect", {
        method: "POST",
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok)
        throw new Error(json.error || `Disconnect failed (${res.status})`)
      setFeedback({ tone: "success", text: "Home Assistant config removed." })
      await refresh()
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not remove Home Assistant config.",
      })
    } finally {
      setBusy(null)
    }
  }

  const updateHomeAssistantActionMode = async (
    enabled: boolean
  ): Promise<boolean> => {
    setBusy("homeassistant-action-mode")
    setFeedback(null)
    try {
      const res = await fetch(
        "/api/integrations/home-assistant/action-policy",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            directDomains: ["light", "cover", "climate", "notify"],
            confirmOtherDomains: true,
          }),
        }
      )
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok)
        throw new Error(
          json.error || `Action mode update failed (${res.status})`
        )
      setFeedback({
        tone: "success",
        text: enabled
          ? "Home Assistant action mode enabled."
          : "Home Assistant action mode disabled.",
      })
      await refresh()
      return true
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not update Home Assistant action mode.",
      })
      return false
    } finally {
      setBusy(null)
    }
  }

  const saveGoogleMapsConfig = async (
    input: GoogleMapsConfigInput
  ): Promise<boolean> => {
    setBusy("google-maps-save")
    setFeedback(null)
    try {
      const res = await fetch("/api/integrations/maps/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        maps?: MapsIntegrationStatusEntry
        weather?: WeatherIntegrationStatusEntry
      }
      if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`)
      const mapsReady = json.maps?.connected === true
      const weatherProvider =
        json.weather?.providerInUse === "google"
          ? "Google Weather"
          : json.weather?.providerInUse === "open-meteo"
            ? "Open-Meteo"
            : "unavailable"
      setFeedback({
        tone: mapsReady ? "success" : "warning",
        text: mapsReady
          ? `Google Maps key saved and Geocoding verified. ${json.maps?.mapIdConfigured ? "Custom vector Map ID is set." : "Add a custom vector Map ID for production tilt/rotation."} Weather provider: ${weatherProvider}.`
          : "Google Maps key saved, but the Geocoding probe is not verified yet. Check API enablement, billing, and key restrictions below.",
      })
      await refresh()
      window.dispatchEvent(new Event("orch:maps-config-changed"))
      return true
    } catch (err) {
      setFeedback({
        tone: "error",
        text:
          err instanceof Error
            ? err.message
            : "Could not save Google Maps setup.",
      })
      return false
    } finally {
      setBusy(null)
    }
  }

  const serviceDescriptors = React.useMemo(
    () => (data ? buildAuthServiceDescriptors(data) : []),
    [data]
  )
  const selectedService =
    serviceDescriptors.find((service) => service.id === selectedServiceId) ??
    serviceDescriptors[0] ??
    null

  const selectService = React.useCallback(
    (serviceId: AuthServiceId) => {
      setSelectedServiceId(serviceId)
      const params = new URLSearchParams(searchParams.toString())
      if (serviceId === DEFAULT_AUTH_SERVICE_ID) params.delete("auth")
      else params.set("auth", serviceId)
      const query = params.toString()
      router.replace(query ? `/settings?${query}` : "/settings", {
        scroll: false,
      })
    },
    [router, searchParams]
  )

  const renderServiceCard = (serviceId: AuthServiceId) => {
    if (!data) return null
    switch (serviceId) {
      case "gmail":
        return (
          <GmailCard
            entry={data.gmail}
            runtime={data.runtime}
            busy={busy}
            onConnect={connectGmail}
            onDisconnect={disconnectGmail}
            onSaveConfig={saveGmailConfig}
          />
        )
      case "whatsapp":
        return (
          <WhatsAppCard
            entry={data.whatsapp}
            busy={busy}
            onConnect={connectWhatsApp}
            onDisconnect={disconnectWhatsApp}
          />
        )
      case "googleCalendar":
        return (
          <GoogleCalendarCard
            entry={data.googleCalendar}
            runtime={data.runtime}
            busy={busy}
            onConnect={connectGoogleCalendar}
            onDisconnect={disconnectGoogleCalendar}
            onSaveConfig={saveGoogleCalendarConfig}
          />
        )
      case "googleDrive":
        return (
          <GoogleWorkspaceCard
            entry={data.googleDrive}
            runtime={data.runtime}
            busy={busy}
            onConnect={connectGoogleDrive}
            onDisconnect={disconnectGoogleDrive}
            onSaveConfig={saveGoogleDriveConfig}
          />
        )
      case "homeAssistant":
        return (
          <HomeAssistantCard
            entry={data.homeAssistant}
            busy={busy}
            onSaveConfig={saveHomeAssistantConfig}
            onUpdateActionMode={updateHomeAssistantActionMode}
            onDisconnect={disconnectHomeAssistant}
          />
        )
      case "mapsWeather":
        return (
          <MapsWeatherCard
            maps={data.maps}
            weather={data.weather}
            busy={busy}
            onSaveConfig={saveGoogleMapsConfig}
          />
        )
      case "locationIntelligence":
        return <LocationIntelligenceCard entry={data.locationIntelligence} />
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground/85">
            Connected services
          </h2>
          <p className="mt-0.5 text-[12.5px] text-foreground/50">
            OAuth accounts and external services available to Orchestrator and
            Concierge.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="size-3.5" />
          )}
          Recheck
        </Button>
      </div>

      {error && <InlineNotice tone="error" text={error} />}
      {feedback && <InlineNotice tone={feedback.tone} text={feedback.text} />}

      {loading && !data ? (
        <AuthServicesSkeleton />
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
            {AUTH_SERVICE_IDS.map((serviceId) => (
              <React.Fragment key={serviceId}>
                {renderServiceCard(serviceId)}
              </React.Fragment>
            ))}
          </div>

          <div className="hidden lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start lg:gap-4">
            <aside
              data-auth-services-sidebar
              className="relative flex h-[640px] min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card"
            >
              <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-2.5">
                <div className="min-w-0">
                  <h3 className="text-[13.5px] font-semibold text-foreground/85">
                    Services
                  </h3>
                  <p className="mt-0.5 text-[11.5px] text-foreground/45">
                    {
                      serviceDescriptors.filter(
                        (service) => service.tone === "success"
                      ).length
                    }{" "}
                    ready
                    {" · "}
                    {serviceDescriptors.length} integrations
                  </p>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5 [scrollbar-gutter:stable]">
                <div className="flex flex-col gap-1">
                  {serviceDescriptors.map((service) => (
                    <AuthServiceSidebarRow
                      key={service.id}
                      service={service}
                      active={service.id === selectedService?.id}
                      onSelect={() => selectService(service.id)}
                    />
                  ))}
                </div>
              </div>
            </aside>

            <section data-auth-service-detail className="min-w-0">
              {selectedService ? (
                renderServiceCard(selectedService.id)
              ) : (
                <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/30 px-5 py-12 text-center text-[13px] text-foreground/45">
                  No service selected.
                </div>
              )}
            </section>
          </div>
        </>
      ) : null}
    </section>
  )
}

function AuthServicesSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
        {[1, 2, 3, 4].map((item) => (
          <div
            key={item}
            className="h-[230px] animate-pulse rounded-2xl border border-border/60 bg-muted/40"
          />
        ))}
      </div>
      <div className="hidden lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start lg:gap-4">
        <div className="h-[640px] animate-pulse rounded-xl border border-border/60 bg-muted/40" />
        <div className="h-[320px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
      </div>
    </>
  )
}

function AuthServiceSidebarRow({
  service,
  active,
  onSelect,
}: {
  service: AuthServiceDescriptor
  active: boolean
  onSelect: () => void
}) {
  const Icon = service.icon
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-label={`Select ${service.name}`}
      onClick={onSelect}
      className={cn(
        "group flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-[background-color,border-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "border-foreground/12 bg-foreground/[0.04]"
          : "border-transparent hover:border-border/70 hover:bg-muted/45"
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          service.iconWrapClassName
        )}
      >
        <Icon className={cn("size-4", service.iconClassName)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              authStatusDotClass(service.tone)
            )}
          />
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground/85">
            {service.name}
          </span>
          <AuthMiniBadge tone={service.tone}>{service.status}</AuthMiniBadge>
        </span>
        <span
          className="mt-0.5 block truncate text-[11.5px] text-foreground/45"
          title={service.summary}
        >
          {service.summary}
        </span>
      </span>
    </button>
  )
}

function AuthMiniBadge({
  tone,
  children,
}: {
  tone: AuthStatusTone
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex h-4 max-w-[88px] shrink-0 items-center rounded px-1.5 text-[10px] font-medium whitespace-nowrap",
        tone === "success"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : tone === "warn"
            ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
            : "bg-muted text-foreground/50"
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  )
}
