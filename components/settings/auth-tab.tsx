"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CloudSun,
  FolderOpen,
  House,
  KeyRound,
  LogIn,
  Loader2,
  Mail,
  MapPinned,
  MessageCircle,
  Plus,
  QrCode,
  RefreshCcw,
  Save,
  ShieldCheck,
  Smartphone,
  Unplug,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Badge,
  ConfigInput,
  CopyableCode,
  GuideLink,
  InlineNotice,
} from "@/components/settings/auth-shared"
import {
  GmailConfigForm,
  GmailSetupGuide,
  GoogleCalendarSetupGuide,
  GoogleWorkspaceConfigForm,
  GoogleWorkspaceSetupGuide,
  localhostRedirectNotice,
  shouldWarnAboutLocalhostRedirect,
} from "@/components/settings/auth-google-oauth"
import { HomeAssistantCard } from "@/components/settings/auth-home-assistant"
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { CliAccountsSection } from "@/components/settings/cli-accounts"
import {
  useIntegrationsStatus,
  type GmailIntegrationStatusEntry,
  type GoogleCalendarIntegrationStatusEntry,
  type GoogleDriveIntegrationStatusEntry,
  type HomeAssistantIntegrationStatusEntry,
  type IntegrationsStatus,
  type MapsIntegrationStatusEntry,
  type RuntimeAccessInfo,
  type WeatherIntegrationStatusEntry,
  type WhatsAppIntegrationStatusEntry,
} from "@/components/settings/use-integrations-status"

type OAuthMessage = {
  type?: string
  provider?: string
  ok?: boolean
  message?: string
}

const GOOGLE_MAPS_PLATFORM_URL =
  "https://console.cloud.google.com/google/maps-apis"
const ENABLE_MAPS_JS_API_URL =
  "https://console.cloud.google.com/apis/library/maps-backend.googleapis.com"
const ENABLE_GEOCODING_API_URL =
  "https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com"
const ENABLE_PLACES_API_URL =
  "https://console.cloud.google.com/apis/library/places-backend.googleapis.com"
const ENABLE_ROUTES_API_URL =
  "https://console.cloud.google.com/apis/library/routes.googleapis.com"
const ENABLE_WEATHER_API_URL =
  "https://console.cloud.google.com/apis/library/weather.googleapis.com"
const ENABLE_AIR_QUALITY_API_URL =
  "https://console.cloud.google.com/apis/library/airquality.googleapis.com"
const ENABLE_POLLEN_API_URL =
  "https://console.cloud.google.com/apis/library/pollen.googleapis.com"
const GOOGLE_MAPS_MAP_IDS_URL =
  "https://console.cloud.google.com/google/maps-apis/studio/maps"
const GOOGLE_MAPS_VECTOR_DOCS_URL =
  "https://developers.google.com/maps/documentation/javascript/map-rendering-type"
const GOOGLE_MAPS_3D_DOCS_URL =
  "https://developers.google.com/maps/documentation/javascript/3d/overview"
const GOOGLE_MAPS_3D_COVERAGE_URL =
  "https://developers.google.com/maps/documentation/javascript/3d/coverage"

const AUTH_SERVICE_IDS = [
  "gmail",
  "whatsapp",
  "googleCalendar",
  "googleDrive",
  "homeAssistant",
  "mapsWeather",
] as const

type AuthServiceId = (typeof AUTH_SERVICE_IDS)[number]
type AuthStatusTone = "success" | "warn" | "muted"

interface AuthServiceDescriptor {
  id: AuthServiceId
  name: string
  summary: string
  status: string
  tone: AuthStatusTone
  icon: React.ComponentType<{ className?: string }>
  iconClassName: string
  iconWrapClassName: string
}

const DEFAULT_AUTH_SERVICE_ID: AuthServiceId = "gmail"

function isAuthServiceId(value: string | null): value is AuthServiceId {
  return (
    value !== null && (AUTH_SERVICE_IDS as readonly string[]).includes(value)
  )
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

function authStatusDotClass(tone: AuthStatusTone): string {
  if (tone === "success") return "bg-emerald-500"
  if (tone === "warn") return "bg-amber-500"
  return "bg-foreground/25"
}

function buildAuthServiceDescriptors(
  data: IntegrationsStatus
): AuthServiceDescriptor[] {
  const gmailStatus = oauthStatus(
    data.gmail.configured,
    data.gmail.connected,
    data.gmail.needsReconnect
  )
  const calendarStatus = oauthStatus(
    data.googleCalendar.configured,
    data.googleCalendar.connected,
    data.googleCalendar.needsReconnect
  )
  const driveStatus = oauthStatus(
    data.googleDrive.configured,
    data.googleDrive.connected,
    data.googleDrive.needsReconnect
  )
  const whatsappStatus = whatsAppStatus(data.whatsapp)
  const homeAssistantStatus = data.homeAssistant.configured
    ? data.homeAssistant.connected && !data.homeAssistant.needsReconnect
      ? ({ tone: "success", status: "Connected" } satisfies Pick<
          AuthServiceDescriptor,
          "tone" | "status"
        >)
      : ({ tone: "warn", status: "Unreachable" } satisfies Pick<
          AuthServiceDescriptor,
          "tone" | "status"
        >)
    : ({ tone: "warn", status: "Config needed" } satisfies Pick<
        AuthServiceDescriptor,
        "tone" | "status"
      >)
  const mapsStatus = mapsWeatherStatus(data.maps, data.weather)

  return [
    {
      id: "gmail",
      name: data.gmail.name,
      summary:
        data.gmail.accountEmail ??
        oauthSummary(
          data.gmail.configured,
          data.gmail.connected,
          data.gmail.needsReconnect
        ),
      icon: Mail,
      iconWrapClassName: "bg-red-500/10",
      iconClassName: "text-red-600 dark:text-red-400",
      ...gmailStatus,
    },
    {
      id: "whatsapp",
      name: data.whatsapp.name,
      summary: whatsAppSummary(data.whatsapp),
      icon: MessageCircle,
      iconWrapClassName: "bg-emerald-500/10",
      iconClassName: "text-emerald-700 dark:text-emerald-400",
      ...whatsappStatus,
    },
    {
      id: "googleCalendar",
      name: data.googleCalendar.name,
      summary:
        data.googleCalendar.primaryCalendarSummary ??
        data.googleCalendar.accountEmail ??
        oauthSummary(
          data.googleCalendar.configured,
          data.googleCalendar.connected,
          data.googleCalendar.needsReconnect
        ),
      icon: CalendarDays,
      iconWrapClassName: "bg-blue-500/10",
      iconClassName: "text-blue-700 dark:text-blue-400",
      ...calendarStatus,
    },
    {
      id: "googleDrive",
      name: data.googleDrive.name,
      summary:
        data.googleDrive.accountEmail ??
        data.googleDrive.accountName ??
        oauthSummary(
          data.googleDrive.configured,
          data.googleDrive.connected,
          data.googleDrive.needsReconnect
        ),
      icon: FolderOpen,
      iconWrapClassName: "bg-emerald-500/10",
      iconClassName: "text-emerald-700 dark:text-emerald-400",
      ...driveStatus,
    },
    {
      id: "homeAssistant",
      name: data.homeAssistant.name,
      summary:
        data.homeAssistant.locationName ??
        data.homeAssistant.baseUrl ??
        (data.homeAssistant.configured
          ? "API verification pending"
          : "Add URL and token"),
      icon: House,
      iconWrapClassName: "bg-sky-500/10",
      iconClassName: "text-sky-700 dark:text-sky-400",
      ...homeAssistantStatus,
    },
    {
      id: "mapsWeather",
      name: "Maps & Weather",
      summary: mapsWeatherSummary(data.maps, data.weather),
      icon: MapPinned,
      iconWrapClassName: "bg-cyan-500/10",
      iconClassName: "text-cyan-700 dark:text-cyan-400",
      ...mapsStatus,
    },
  ]
}

function oauthStatus(
  configured: boolean,
  connected: boolean,
  needsReconnect: boolean
): Pick<AuthServiceDescriptor, "tone" | "status"> {
  if (!configured) return { tone: "warn", status: "Config needed" }
  if (connected && !needsReconnect)
    return { tone: "success", status: "Connected" }
  if (connected || needsReconnect) return { tone: "warn", status: "Reconnect" }
  return { tone: "muted", status: "Not connected" }
}

function oauthSummary(
  configured: boolean,
  connected: boolean,
  needsReconnect: boolean
): string {
  if (!configured) return "OAuth client missing"
  if (connected && needsReconnect) return "Reconnect required"
  if (connected) return "OAuth tokens stored locally"
  return "Ready to connect"
}

function whatsAppStatus(
  entry: WhatsAppIntegrationStatusEntry
): Pick<AuthServiceDescriptor, "tone" | "status"> {
  if (!entry.configured) return { tone: "warn", status: "Browser needed" }
  if (entry.connected && !entry.needsReconnect)
    return { tone: "success", status: "Connected" }
  if (entry.phase === "qr") return { tone: "warn", status: "Scan QR" }
  if (entry.phase === "starting" || entry.phase === "authenticated")
    return { tone: "warn", status: "Linking" }
  if (entry.sessionStored) return { tone: "warn", status: "Saved" }
  if (
    entry.phase === "error" ||
    entry.phase === "auth_failure" ||
    entry.needsReconnect
  ) {
    return { tone: "warn", status: "Reconnect" }
  }
  return { tone: "muted", status: "Not connected" }
}

function whatsAppSummary(entry: WhatsAppIntegrationStatusEntry): string {
  if (entry.connected)
    return entry.accountName || entry.phoneNumber || "Local session running"
  if (entry.phase === "qr") return "Waiting for QR scan"
  if (entry.phase === "starting" || entry.phase === "authenticated")
    return "WhatsApp Web is linking"
  if (entry.sessionStored) return "Session saved locally"
  if (!entry.configured) return "Local browser not found"
  return "No active session"
}

function mapsWeatherStatus(
  maps: MapsIntegrationStatusEntry,
  weather: WeatherIntegrationStatusEntry
): Pick<AuthServiceDescriptor, "tone" | "status"> {
  if (maps.connected && weather.anyProviderReady)
    return { tone: "success", status: "Ready" }
  if (maps.connected) return { tone: "success", status: "Maps ready" }
  if (!maps.configured) return { tone: "warn", status: "Key needed" }
  return { tone: "warn", status: "API issue" }
}

function mapsWeatherSummary(
  maps: MapsIntegrationStatusEntry,
  weather: WeatherIntegrationStatusEntry
): string {
  const weatherLabel =
    weather.providerInUse === "google"
      ? "Google Weather"
      : weather.providerInUse === "open-meteo"
        ? "Open-Meteo fallback"
        : "Weather offline"
  if (!maps.configured) return `Add Maps key · ${weatherLabel}`
  if (!maps.connected) return `Maps not verified · ${weatherLabel}`
  return `${maps.mapIdConfigured ? "Vector Map ID set" : "Demo Map ID"} · ${weatherLabel}`
}

function GmailCard({
  entry,
  runtime,
  busy,
  onConnect,
  onDisconnect,
  onSaveConfig,
}: {
  entry: GmailIntegrationStatusEntry
  runtime?: RuntimeAccessInfo
  busy: BusyAction
  onConnect: () => void
  onDisconnect: () => void
  onSaveConfig: (input: GmailConfigInput) => Promise<boolean>
}) {
  const connected = entry.connected && !entry.needsReconnect
  const badge = !entry.configured ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Config needed
    </Badge>
  ) : connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      Connected
    </Badge>
  ) : entry.connected ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Not connected
    </Badge>
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
              <Mail className="size-4 text-red-600 dark:text-red-400" />
            </span>
            <CardTitle className="truncate">{entry.name}</CardTitle>
          </div>
          {badge}
        </div>
        <CardDescription>{entry.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          <span className="text-foreground/55">Account</span>
          <span className="truncate text-foreground/85">
            {entry.accountEmail ?? "Not connected"}
          </span>
          <span className="text-foreground/55">Redirect URI</span>
          <CopyableCode value={entry.redirectUri} openable />
          <span className="text-foreground/55">Access</span>
          <div className="flex flex-wrap gap-1.5">
            {entry.requestedScopes.map((scope) => (
              <span
                key={scope}
                title={scope}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                  entry.scopes.includes(scope)
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-muted text-foreground/50"
                )}
              >
                <ShieldCheck className="size-3" />
                {scopeLabel(scope)}
              </span>
            ))}
          </div>
          {entry.expiresAt && (
            <>
              <span className="text-foreground/55">Token</span>
              <span className="text-foreground/75">
                {formatExpiry(entry.expiresAt)}
              </span>
            </>
          )}
        </div>

        {!entry.configured && (
          <GmailConfigForm entry={entry} busy={busy} onSave={onSaveConfig} />
        )}
        <GmailSetupGuide redirectUri={entry.redirectUri} runtime={runtime} />
        {entry.error && <InlineNotice tone="error" text={entry.error} />}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!entry.configured || busy !== null}
          >
            {busy === "connect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogIn className="size-3.5" />
            )}
            {entry.connected ? "Reconnect" : "Connect"}
          </Button>
          {entry.connected && (
            <Button
              size="sm"
              variant="outline"
              onClick={onDisconnect}
              disabled={busy !== null}
              className="text-destructive hover:text-destructive"
            >
              {busy === "disconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function GoogleCalendarCard({
  entry,
  runtime,
  busy,
  onConnect,
  onDisconnect,
  onSaveConfig,
}: {
  entry: GoogleCalendarIntegrationStatusEntry
  runtime?: RuntimeAccessInfo
  busy: BusyAction
  onConnect: () => void
  onDisconnect: () => void
  onSaveConfig: (input: GoogleCalendarConfigInput) => Promise<boolean>
}) {
  const connected = entry.connected && !entry.needsReconnect
  const badge = !entry.configured ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Config needed
    </Badge>
  ) : connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      Connected
    </Badge>
  ) : entry.connected ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Not connected
    </Badge>
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
              <CalendarDays className="size-4 text-blue-700 dark:text-blue-400" />
            </span>
            <CardTitle className="truncate">{entry.name}</CardTitle>
          </div>
          {badge}
        </div>
        <CardDescription>{entry.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          <span className="text-foreground/55">Account</span>
          <span className="truncate text-foreground/85">
            {entry.accountEmail ?? "Not connected"}
          </span>
          <span className="text-foreground/55">Primary</span>
          <span
            className="truncate text-foreground/75"
            title={entry.primaryCalendarId ?? undefined}
          >
            {entry.primaryCalendarSummary ||
              entry.primaryCalendarId ||
              "Not verified"}
          </span>
          <span className="text-foreground/55">Calendars</span>
          <span className="text-foreground/75">
            {entry.calendarCount === null
              ? "Not read yet"
              : `${entry.calendarCount} visible`}
            {entry.writableCalendarCount !== null
              ? ` | ${entry.writableCalendarCount} writable`
              : ""}
          </span>
          <span className="text-foreground/55">Timezone</span>
          <span className="truncate text-foreground/75">
            {entry.timeZone ?? "Not verified"}
          </span>
          <span className="text-foreground/55">Redirect URI</span>
          <CopyableCode value={entry.redirectUri} openable />
          <span className="text-foreground/55">Access</span>
          <div className="flex flex-wrap gap-1.5">
            {entry.requestedScopes.map((scope) => (
              <span
                key={scope}
                title={scope}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                  calendarScopeGranted(entry.scopes, scope)
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-muted text-foreground/50"
                )}
              >
                <ShieldCheck className="size-3" />
                {calendarScopeLabel(scope)}
              </span>
            ))}
          </div>
          {entry.expiresAt && (
            <>
              <span className="text-foreground/55">Token</span>
              <span className="text-foreground/75">
                {formatExpiry(entry.expiresAt)}
              </span>
            </>
          )}
        </div>

        {!entry.configured && (
          <GoogleWorkspaceConfigForm
            entry={entry}
            busy={busy}
            onSave={onSaveConfig}
          />
        )}
        <GoogleCalendarSetupGuide
          redirectUri={entry.redirectUri}
          runtime={runtime}
        />
        {entry.error && <InlineNotice tone="error" text={entry.error} />}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!entry.configured || busy !== null}
          >
            {busy === "google-calendar-connect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogIn className="size-3.5" />
            )}
            {entry.connected ? "Reconnect" : "Connect"}
          </Button>
          {entry.connected && (
            <Button
              size="sm"
              variant="outline"
              onClick={onDisconnect}
              disabled={busy !== null}
              className="text-destructive hover:text-destructive"
            >
              {busy === "google-calendar-disconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function GoogleWorkspaceCard({
  entry,
  runtime,
  busy,
  onConnect,
  onDisconnect,
  onSaveConfig,
}: {
  entry: GoogleDriveIntegrationStatusEntry
  runtime?: RuntimeAccessInfo
  busy: BusyAction
  onConnect: () => void
  onDisconnect: () => void
  onSaveConfig: (input: GoogleDriveConfigInput) => Promise<boolean>
}) {
  const connected = entry.connected && !entry.needsReconnect
  const badge = !entry.configured ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Config needed
    </Badge>
  ) : connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      Connected
    </Badge>
  ) : entry.connected ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Not connected
    </Badge>
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
              <FolderOpen className="size-4 text-emerald-700 dark:text-emerald-400" />
            </span>
            <CardTitle className="truncate">{entry.name}</CardTitle>
          </div>
          {badge}
        </div>
        <CardDescription>{entry.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          <span className="text-foreground/55">Account</span>
          <span className="truncate text-foreground/85">
            {entry.accountEmail ?? entry.accountName ?? "Not connected"}
          </span>
          <span className="text-foreground/55">Storage</span>
          <span className="truncate text-foreground/75">
            {formatDriveStorage(entry.storageQuota)}
          </span>
          <span className="text-foreground/55">Max upload</span>
          <span className="truncate text-foreground/75">
            {entry.maxUploadSize
              ? formatByteString(entry.maxUploadSize)
              : "Not verified"}
          </span>
          <span className="text-foreground/55">Redirect URI</span>
          <CopyableCode value={entry.redirectUri} openable />
          <span className="text-foreground/55">Access</span>
          <div className="flex flex-wrap gap-1.5">
            {entry.requestedScopes.map((scope) => (
              <span
                key={scope}
                title={scope}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                  driveScopeGranted(entry.scopes, scope)
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-muted text-foreground/50"
                )}
              >
                <ShieldCheck className="size-3" />
                {driveScopeLabel(scope)}
              </span>
            ))}
          </div>
          {entry.expiresAt && (
            <>
              <span className="text-foreground/55">Token</span>
              <span className="text-foreground/75">
                {formatExpiry(entry.expiresAt)}
              </span>
            </>
          )}
        </div>

        {!entry.configured && (
          <GoogleWorkspaceConfigForm
            entry={entry}
            busy={busy}
            onSave={onSaveConfig}
          />
        )}
        <GoogleWorkspaceSetupGuide
          redirectUri={entry.redirectUri}
          runtime={runtime}
        />
        {entry.error && <InlineNotice tone="error" text={entry.error} />}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!entry.configured || busy !== null}
          >
            {busy === "google-drive-connect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogIn className="size-3.5" />
            )}
            {entry.connected ? "Reconnect" : "Connect"}
          </Button>
          {entry.connected && (
            <Button
              size="sm"
              variant="outline"
              onClick={onDisconnect}
              disabled={busy !== null}
              className="text-destructive hover:text-destructive"
            >
              {busy === "google-drive-disconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function WhatsAppCard({
  entry,
  busy,
  onConnect,
  onDisconnect,
}: {
  entry: WhatsAppIntegrationStatusEntry
  busy: BusyAction
  onConnect: () => void
  onDisconnect: () => void
}) {
  const connected = entry.connected && !entry.needsReconnect
  const savedSessionIdle =
    entry.sessionStored &&
    !connected &&
    entry.phase !== "qr" &&
    entry.phase !== "starting" &&
    entry.phase !== "authenticated"
  const badge = !entry.configured ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Browser needed
    </Badge>
  ) : connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      Connected
    </Badge>
  ) : entry.phase === "qr" ? (
    <Badge tone="warn" icon={<QrCode className="size-3" />}>
      Scan QR
    </Badge>
  ) : entry.phase === "starting" || entry.phase === "authenticated" ? (
    <Badge tone="warn" icon={<Loader2 className="size-3 animate-spin" />}>
      Linking
    </Badge>
  ) : savedSessionIdle ? (
    <Badge tone="warn" icon={<Smartphone className="size-3" />}>
      Session saved
    </Badge>
  ) : entry.phase === "error" || entry.phase === "auth_failure" ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Reconnect
    </Badge>
  ) : (
    <Badge tone="muted" icon={<AlertCircle className="size-3" />}>
      Not connected
    </Badge>
  )

  const qrSrc = entry.qrDataUrl ?? entry.qrImageUrl

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
              <MessageCircle className="size-4 text-emerald-700 dark:text-emerald-400" />
            </span>
            <CardTitle className="truncate">{entry.name}</CardTitle>
          </div>
          {badge}
        </div>
        <CardDescription>{entry.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          <span className="text-foreground/55">Account</span>
          <span className="truncate text-foreground/85">
            {entry.accountName ||
              entry.phoneNumber ||
              (entry.sessionStored ? "Reconnect to verify" : "Not connected")}
          </span>
          <span className="text-foreground/55">Session</span>
          <span className="text-foreground/75">
            {connected
              ? "Running from local session"
              : entry.sessionStored
                ? "Stored locally; reconnect to start"
                : "No local session"}
          </span>
          <span className="text-foreground/55">Browser</span>
          <span
            className="truncate text-foreground/75"
            title={entry.browserExecutablePath ?? undefined}
          >
            {entry.browserExecutablePath
              ? shortPath(entry.browserExecutablePath)
              : "Chrome/Chromium not found"}
          </span>
          <span className="text-foreground/55">Mode</span>
          <span className="text-foreground/75">
            Reads plus confirmed writes
          </span>
        </div>

        {qrSrc && (
          <div className="grid gap-2 rounded-xl border border-border/70 bg-background/70 p-3">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
              <QrCode className="size-3.5" />
              Scan with WhatsApp
            </div>
            <div className="flex justify-center rounded-lg bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrSrc}
                alt="WhatsApp QR code"
                className="aspect-square w-full max-w-[240px]"
              />
            </div>
            <p className="text-[12px] leading-relaxed text-foreground/55">
              Open WhatsApp on your phone, go to Linked devices, then scan this
              code.
            </p>
            {entry.qrExpiresAt && (
              <p className="text-[11.5px] text-foreground/45">
                QR refreshes automatically if it expires.
              </p>
            )}
          </div>
        )}

        {!entry.configured && (
          <InlineNotice
            tone="error"
            text={`Missing local browser: ${entry.missingConfig.join(", ")}.`}
          />
        )}
        {entry.lastError && (
          <InlineNotice tone="error" text={entry.lastError} />
        )}

        <WhatsAppSetupGuide />

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!entry.configured || busy !== null}
          >
            {busy === "whatsapp-connect" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Smartphone className="size-3.5" />
            )}
            {entry.connected || entry.sessionStored ? "Reconnect" : "Connect"}
          </Button>
          {(entry.connected || entry.sessionStored || entry.phase === "qr") && (
            <Button
              size="sm"
              variant="outline"
              onClick={onDisconnect}
              disabled={busy !== null}
              className="text-destructive hover:text-destructive"
            >
              {busy === "whatsapp-disconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Unplug className="size-3.5" />
              )}
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function MapsWeatherCard({
  maps,
  weather,
  busy,
  onSaveConfig,
}: {
  maps: MapsIntegrationStatusEntry
  weather: WeatherIntegrationStatusEntry
  busy: BusyAction
  onSaveConfig: (input: GoogleMapsConfigInput) => Promise<boolean>
}) {
  const mapsBadge = !maps.configured ? (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      Key needed
    </Badge>
  ) : maps.connected ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
      Maps ready
    </Badge>
  ) : (
    <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
      API issue
    </Badge>
  )

  const weatherBadge =
    weather.providerInUse === "google" ? (
      <Badge tone="success" icon={<CheckCircle2 className="size-3" />}>
        Google Weather
      </Badge>
    ) : weather.providerInUse === "open-meteo" ? (
      <Badge
        tone={weather.google.needsReconnect ? "warn" : "success"}
        icon={<CloudSun className="size-3" />}
      >
        Open-Meteo
      </Badge>
    ) : (
      <Badge tone="warn" icon={<AlertCircle className="size-3" />}>
        Offline
      </Badge>
    )

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10">
              <MapPinned className="size-4 text-cyan-700 dark:text-cyan-400" />
            </span>
            <CardTitle className="truncate">Maps & Weather</CardTitle>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {mapsBadge}
            {weatherBadge}
          </div>
        </div>
        <CardDescription>
          One Google Maps Platform key powers Smart Maps, geocoding, places,
          routes, and optional Google weather upgrades.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
              <MapPinned className="size-3.5 text-foreground/50" />
              Google Maps Platform
            </div>
            <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
              <span className="text-foreground/55">API key</span>
              <span className="truncate text-foreground/85">
                {maps.configured ? "Stored locally" : "Missing"}
              </span>
              <span className="text-foreground/55">Geocoding</span>
              <span className="truncate text-foreground/75">
                {maps.connected
                  ? "Verified"
                  : maps.configured
                    ? "Not verified"
                    : "Needs key"}
              </span>
              <span className="text-foreground/55">Map ID</span>
              <span
                className={cn(
                  "truncate",
                  maps.mapIdConfigured
                    ? "text-foreground/75"
                    : "text-amber-700 dark:text-amber-300"
                )}
              >
                {maps.mapIdConfigured
                  ? maps.mapIdLabel
                  : "Demo ID - add vector Map ID"}
              </span>
              <span className="text-foreground/55">Earth 3D</span>
              <span className="text-foreground/75">
                {maps.earth3d.readyToTry
                  ? "Ready to try (beta)"
                  : "Needs Maps key"}
              </span>
              <span className="text-foreground/55">Map APIs</span>
              <span className="text-foreground/75">
                Maps JavaScript, Geocoding, Places, Routes
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-background/60 px-3 py-3">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground/75">
              <CloudSun className="size-3.5 text-foreground/50" />
              Weather providers
            </div>
            <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
              <span className="text-foreground/55">Active</span>
              <span className="truncate text-foreground/85">
                {weather.providerInUse === "google"
                  ? "Google Weather"
                  : weather.providerInUse === "open-meteo"
                    ? "Open-Meteo fallback"
                    : "Unavailable"}
              </span>
              <span className="text-foreground/55">Google</span>
              <span className="truncate text-foreground/75">
                {weather.google.connected
                  ? "Weather API verified"
                  : weather.google.configured
                    ? "Key stored; Weather API not verified"
                    : "Optional upgrade"}
              </span>
              <span className="text-foreground/55">Open-Meteo</span>
              <span className="text-foreground/75">
                {weather.openMeteo.available
                  ? "Keyless fallback for weather, AQ, pollen"
                  : "Unavailable"}
              </span>
            </div>
          </div>
        </div>

        <SmartMapsOnboardingPanel maps={maps} />
        <GoogleMapsKeyForm maps={maps} busy={busy} onSave={onSaveConfig} />
        <MapsWeatherSetupGuide />
        {maps.error && (
          <InlineNotice tone="error" text={`Maps: ${maps.error}`} />
        )}
        {weather.google.error && (
          <InlineNotice
            tone="warning"
            text={`Google Weather/Pollen setup: ${weather.google.error}`}
          />
        )}
        {weather.openMeteo.error && (
          <InlineNotice
            tone="warning"
            text={`Open-Meteo: ${weather.openMeteo.error}`}
          />
        )}
      </CardContent>
    </Card>
  )
}

function SmartMapsOnboardingPanel({
  maps,
}: {
  maps: MapsIntegrationStatusEntry
}) {
  return (
    <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5 text-[12px]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold text-foreground/80">
              Smart Maps visual setup
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-foreground/45 transition-transform group-open:rotate-180" />
          </div>
          <p className="mt-0.5 line-clamp-2 max-w-3xl text-foreground/55">
            Maps stays the default. Add a custom Vector Map ID for reliable
            tilt/rotation; Earth 3D remains a beta mode where Google has
            photorealistic coverage.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <Badge
            tone={maps.mapIdConfigured ? "success" : "warn"}
            icon={
              maps.mapIdConfigured ? (
                <CheckCircle2 className="size-3" />
              ) : (
                <AlertCircle className="size-3" />
              )
            }
          >
            {maps.mapIdConfigured ? "Vector Map ID" : "Needs Map ID"}
          </Badge>
          <Badge
            tone={maps.earth3d.readyToTry ? "success" : "muted"}
            icon={<MapPinned className="size-3" />}
          >
            Earth 3D beta
          </Badge>
        </div>
      </summary>

      <div className="mt-2 border-t border-border/60 pt-2">
        <ol className="grid list-decimal gap-2 pl-4 text-foreground/65 md:grid-cols-3 md:gap-3">
          <li>
            <span className="font-medium text-foreground/75">API key</span>
            <span className="mt-0.5 block">
              Enable{" "}
              <GuideLink href={ENABLE_MAPS_JS_API_URL}>
                Maps JavaScript
              </GuideLink>
              , <GuideLink href={ENABLE_GEOCODING_API_URL}>Geocoding</GuideLink>
              , Places, and Routes, then save one Google Maps Platform key.
            </span>
          </li>
          <li>
            <span className="font-medium text-foreground/75">
              Vector Map ID
            </span>
            <span className="mt-0.5 block">
              In{" "}
              <GuideLink href={GOOGLE_MAPS_MAP_IDS_URL}>
                Map Management
              </GuideLink>
              , create a JavaScript map ID, choose Vector, enable Tilt and
              Rotation, then save it as{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                GOOGLE_MAPS_MAP_ID
              </code>
              .
            </span>
          </li>
          <li>
            <span className="font-medium text-foreground/75">Earth 3D</span>
            <span className="mt-0.5 block">
              Earth mode uses{" "}
              <GuideLink href={GOOGLE_MAPS_3D_DOCS_URL}>3D Maps beta</GuideLink>
              . Check{" "}
              <GuideLink href={GOOGLE_MAPS_3D_COVERAGE_URL}>coverage</GuideLink>
              ; when coverage is weak, Smart Maps should fall back to normal
              Maps.
            </span>
          </li>
        </ol>

        <div className="mt-3 grid gap-1.5 border-t border-border/60 pt-2 text-foreground/55">
          <div>{maps.vectorMap.message}</div>
          <div>{maps.earth3d.message}</div>
          <GuideLink href={GOOGLE_MAPS_VECTOR_DOCS_URL}>
            Why Vector Map ID matters for tilt and heading
          </GuideLink>
        </div>
      </div>
    </details>
  )
}

function GoogleMapsKeyForm({
  maps,
  busy,
  onSave,
}: {
  maps: MapsIntegrationStatusEntry
  busy: BusyAction
  onSave: (input: GoogleMapsConfigInput) => Promise<boolean>
}) {
  const [rawEnv, setRawEnv] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [mapId, setMapId] = React.useState("")
  const [open, setOpen] = React.useState(false)

  const save = async () => {
    const ok = await onSave({ rawEnv, apiKey, mapId })
    if (!ok) return
    setRawEnv("")
    setApiKey("")
    setMapId("")
    setOpen(false)
  }

  if (!open) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-[12px]",
          maps.configured
            ? "border-border/70 bg-background/60 text-foreground/65"
            : "border-cyan-500/25 bg-cyan-500/5 text-cyan-900 dark:text-cyan-200"
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="size-3.5 text-foreground/45" />
          <span className="font-medium text-foreground/75">
            Google Maps key & vector Map ID
          </span>
          {!maps.configured && (
            <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-cyan-700 dark:text-cyan-300">
              Not configured
            </span>
          )}
          {maps.configured && !maps.mapIdConfigured && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
              Map ID recommended
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant={maps.configured ? "outline" : "default"}
          onClick={() => setOpen(true)}
          disabled={busy !== null}
        >
          <Plus className="size-3.5" />
          {maps.configured ? "Edit setup" : "Add key"}
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-3 py-3 text-[12px] text-cyan-900 dark:text-cyan-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="size-3.5 text-foreground/50" />
          <span className="font-medium text-foreground/75">
            Google Maps key & vector Map ID
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={busy !== null}
          >
            Hide
          </Button>
          <Button size="sm" onClick={save} disabled={busy !== null}>
            {busy === "google-maps-save" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            Save & verify
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-2">
        <label className="grid gap-1">
          <span className="font-medium text-foreground/70">
            Paste .env lines
          </span>
          <textarea
            value={rawEnv}
            onChange={(event) => setRawEnv(event.target.value)}
            placeholder={"GOOGLE_MAPS_API_KEY=...\nGOOGLE_MAPS_MAP_ID=..."}
            className="min-h-20 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] text-foreground transition-colors outline-none placeholder:text-foreground/35 focus:border-ring"
          />
        </label>

        <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
          <p className="text-[12px] font-medium text-foreground/70">
            Or type values directly
          </p>
          <ConfigInput
            label="API key"
            value={apiKey}
            onChange={setApiKey}
            placeholder={
              maps.configured
                ? "Stored key unchanged if left blank"
                : "Google Maps Platform key"
            }
            type="password"
          />
          <ConfigInput
            label="Vector Map ID"
            value={mapId}
            onChange={setMapId}
            placeholder={
              maps.mapIdConfigured
                ? "Stored Map ID unchanged if left blank"
                : "JavaScript Vector Map ID"
            }
          />
        </div>
        <p className="text-[11.5px] leading-relaxed text-foreground/55">
          The same key is used for Maps JavaScript, Geocoding, Places, Routes,
          and optional Google Weather APIs. The Map ID is recommended for
          production tilt and rotation.
        </p>
      </div>
    </div>
  )
}

function MapsWeatherSetupGuide() {
  return (
    <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
        <span>Mini tutorial: Maps, Vector tilt, Earth 3D, Weather</span>
        <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
        <ol className="grid list-decimal gap-1.5 pl-4">
          <li>
            Open{" "}
            <GuideLink href={GOOGLE_MAPS_PLATFORM_URL}>
              Google Maps Platform
            </GuideLink>
            , choose or create the project, then create one API key.
          </li>
          <li>
            Enable map APIs separately:{" "}
            <GuideLink href={ENABLE_MAPS_JS_API_URL}>Maps JavaScript</GuideLink>
            , <GuideLink href={ENABLE_GEOCODING_API_URL}>Geocoding</GuideLink>,{" "}
            <GuideLink href={ENABLE_PLACES_API_URL}>Places</GuideLink>, and{" "}
            <GuideLink href={ENABLE_ROUTES_API_URL}>Routes</GuideLink>.
          </li>
          <li>
            For reliable tilt/rotation, create a{" "}
            <GuideLink href={GOOGLE_MAPS_MAP_IDS_URL}>Map ID</GuideLink>: type
            JavaScript, rendering Vector, Tilt and Rotation enabled. Save it as{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              GOOGLE_MAPS_MAP_ID
            </code>
            .
          </li>
          <li>
            Earth 3D uses{" "}
            <GuideLink href={GOOGLE_MAPS_3D_DOCS_URL}>3D Maps beta</GuideLink>,
            not the normal satellite tilt. Confirm important locations in the{" "}
            <GuideLink href={GOOGLE_MAPS_3D_COVERAGE_URL}>
              coverage map
            </GuideLink>
            .
          </li>
          <li>
            Enable environment APIs separately:{" "}
            <GuideLink href={ENABLE_WEATHER_API_URL}>Weather</GuideLink>,{" "}
            <GuideLink href={ENABLE_AIR_QUALITY_API_URL}>Air Quality</GuideLink>
            , and <GuideLink href={ENABLE_POLLEN_API_URL}>Pollen</GuideLink>.
          </li>
          <li>
            Paste it here as{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              GOOGLE_MAPS_API_KEY
            </code>
            . Orchestrator verifies Geocoding with the same key. Google Weather,
            Air Quality, and Pollen use it when those APIs are enabled.
          </li>
          <li>
            After the first successful test, restrict the key in Google Cloud
            Console to the APIs enabled above and to your deployment&apos;s
            allowed origins where applicable.
          </li>
        </ol>
        <p>
          Open-Meteo needs no key and stays as the fallback for forecasts, air
          quality, historical comparison, and seasonal pollen.
        </p>
      </div>
    </details>
  )
}

function WhatsAppSetupGuide() {
  return (
    <details className="group rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12.5px] font-medium text-foreground/75">
        <span>Mini tutorial: WhatsApp setup</span>
        <ChevronDown className="size-3.5 text-foreground/45 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-[12px] leading-relaxed text-foreground/60">
        <p>
          Use Connect to start a local WhatsApp Web session. A QR code appears
          in this card.
        </p>
        <p>
          On your phone, open WhatsApp, go to Settings or Menu, choose Linked
          devices, then Link a device.
        </p>
        <p>
          Scan the QR code. Orchestrator stores the browser session locally and
          exposes WhatsApp tools to the main agent.
        </p>
        <p>
          Messages, photos, files, and delete-for-everyone actions require
          explicit confirmation before they run.
        </p>
      </div>
    </details>
  )
}

function scopeLabel(scope: string): string {
  if (scope === "https://mail.google.com/") return "Full mailbox"
  if (scope.endsWith("/gmail.readonly")) return "Read"
  if (scope.endsWith("/gmail.compose")) return "Draft"
  if (scope.endsWith("/gmail.modify")) return "Modify"
  if (scope.endsWith("/gmail.send")) return "Send"
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
}

function calendarScopeGranted(
  grantedScopes: string[],
  requestedScope: string
): boolean {
  return (
    grantedScopes.includes(requestedScope) ||
    (requestedScope.includes("/auth/calendar.") &&
      grantedScopes.includes("https://www.googleapis.com/auth/calendar"))
  )
}

function calendarScopeLabel(scope: string): string {
  if (scope.endsWith("/calendar.calendarlist.readonly")) return "Calendars"
  if (scope.endsWith("/calendar.events")) return "Events"
  if (scope.endsWith("/calendar.freebusy")) return "Free/busy"
  if (scope.endsWith("/calendar.settings.readonly")) return "Settings"
  if (scope === "https://www.googleapis.com/auth/calendar")
    return "Full calendar"
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
}

function driveScopeGranted(
  grantedScopes: string[],
  requestedScope: string
): boolean {
  return grantedScopes.includes(requestedScope)
}

function driveScopeLabel(scope: string): string {
  if (scope.endsWith("/drive")) return "Full Drive"
  if (scope.endsWith("/documents")) return "Docs"
  if (scope.endsWith("/spreadsheets")) return "Sheets"
  if (scope.endsWith("/presentations")) return "Slides"
  if (scope.endsWith("/contacts")) return "Contacts"
  if (scope.endsWith("/contacts.other.readonly")) return "Other contacts"
  if (scope.endsWith("/drive.readonly")) return "Read"
  if (scope.endsWith("/drive.file")) return "App files"
  if (scope.endsWith("/drive.metadata.readonly")) return "Metadata"
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
}

function formatDriveStorage(
  storage: GoogleDriveIntegrationStatusEntry["storageQuota"]
): string {
  if (!storage?.usage) return "Not verified"
  const usage = formatByteString(storage.usage)
  const limit = storage.limit ? formatByteString(storage.limit) : "unlimited"
  return `${usage} of ${limit}`
}

function formatByteString(value: string): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return value
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let current = bytes
  let unit = 0
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024
    unit += 1
  }
  const formatted =
    current >= 10 || unit === 0 ? current.toFixed(0) : current.toFixed(1)
  return `${formatted} ${units[unit]}`
}

function formatExpiry(expiresAt: number): string {
  if (expiresAt <= Date.now()) return "Expired"
  return `Expires ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(expiresAt))}`
}

function shortPath(value: string): string {
  const parts = value.split("/")
  if (parts.length <= 3) return value
  return `${parts[0] || "/" + parts[1]}/.../${parts.slice(-2).join("/")}`
}
