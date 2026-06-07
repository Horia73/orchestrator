"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import {
  Cpu,
  Activity,
  BarChart3,
  FileText,
  Download,
  Moon,
  Sun,
  KeyRound,
  ArrowLeft,
  UsersRound,
} from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SettingsProvider } from "@/components/settings/use-settings"
import { LogsTab } from "@/components/settings/logs-tab"
import { UsageTab } from "@/components/settings/usage-tab"
import { FilesTab } from "@/components/settings/files-tab"
import { UpdateTab } from "@/components/settings/update-tab"
import { AuthTab } from "@/components/settings/auth-tab"
import { ModelsTab } from "@/components/settings/models-tab"
import { ProfilesTab } from "@/components/settings/profiles-tab"

const TAB_IDS = ["models", "profiles", "auth", "files", "logs", "usage", "updates"] as const
type TabId = (typeof TAB_IDS)[number]

const TABS: Array<{
  id: TabId
  label: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  { id: "models", label: "Models", icon: Cpu },
  { id: "profiles", label: "Profiles", icon: UsersRound },
  { id: "auth", label: "Auth", icon: KeyRound },
  { id: "files", label: "Files", icon: FileText },
  { id: "logs", label: "Logs", icon: Activity },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "updates", label: "Updates", icon: Download },
]

const DEFAULT_TAB: TabId = "models"
const LAST_SETTINGS_TAB_STORAGE_KEY = "orchestrator:settings:last-tab"
function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value)
}

function readLastSettingsTab(): TabId | null {
  if (typeof window === "undefined") return null
  try {
    const value = window.localStorage.getItem(LAST_SETTINGS_TAB_STORAGE_KEY)
    return isTabId(value) ? value : null
  } catch {
    return null
  }
}

function rememberLastSettingsTab(tab: TabId) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LAST_SETTINGS_TAB_STORAGE_KEY, tab)
  } catch {
    // Persistence is best-effort; the URL remains the source of truth.
  }
}

export function SettingsView() {
  return (
    <SettingsProvider>
      <SettingsViewInner />
    </SettingsProvider>
  )
}

function SettingsViewInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tabsScrollRef = React.useRef<HTMLDivElement | null>(null)
  const tabButtonRefs = React.useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({})

  React.useEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.orchSettingsPage
    root.dataset.orchSettingsPage = "true"
    return () => {
      if (previous === undefined) delete root.dataset.orchSettingsPage
      else root.dataset.orchSettingsPage = previous
    }
  }, [])

  const tabFromUrl = searchParams.get("tab")
  const [activeTab, setActiveTab] = React.useState<TabId>(
    isTabId(tabFromUrl) ? tabFromUrl : DEFAULT_TAB
  )

  React.useEffect(() => {
    const t = searchParams.get("tab")
    if (isTabId(t)) {
      rememberLastSettingsTab(t)
      setActiveTab((current) => (current === t ? current : t))
      return
    }
    const remembered = readLastSettingsTab()
    if (remembered)
      setActiveTab((current) => (current === remembered ? current : remembered))
  }, [searchParams])

  const handleTabChange = React.useCallback(
    (next: string) => {
      if (!isTabId(next)) return
      setActiveTab(next)
      rememberLastSettingsTab(next)
      const params = new URLSearchParams(searchParams.toString())
      if (next === DEFAULT_TAB) params.delete("tab")
      else params.set("tab", next)
      const query = params.toString()
      router.replace(query ? `/settings?${query}` : "/settings", {
        scroll: false,
      })
    },
    [router, searchParams]
  )

  React.useEffect(() => {
    const scroller = tabsScrollRef.current
    const activeButton = tabButtonRefs.current[activeTab]
    if (!scroller || !activeButton) return
    const scrollerRect = scroller.getBoundingClientRect()
    const buttonRect = activeButton.getBoundingClientRect()
    if (buttonRect.left >= scrollerRect.left && buttonRect.right <= scrollerRect.right) return
    activeButton.scrollIntoView({ block: "nearest", inline: "center" })
  }, [activeTab])

  return (
    <div
      data-orch-settings-content="true"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <div className="border-b border-border/60 bg-background">
        <div className="mx-auto w-full max-w-6xl min-w-0 px-3 pt-3 pb-0 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <button
                type="button"
                onClick={() => router.replace("/")}
                aria-label="Back to chat"
                className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground md:hidden"
              >
                <ArrowLeft className="size-4" />
              </button>
              <div className="min-w-0">
                <h1 className="text-[20px] font-semibold tracking-tight text-foreground">
                  Settings
                </h1>
                <p className="mt-0 mb-2 text-[11.5px] text-foreground/55">
                  Configure models, authentication, workspace files, activity,
                  and usage.
                </p>
              </div>
            </div>
            <ThemeToggle />
          </div>
          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="gap-0"
          >
            <div
              ref={tabsScrollRef}
              className="-mx-3 overflow-x-auto scroll-px-3 px-3 [scrollbar-width:none] sm:mx-0 sm:px-0 md:overflow-visible [&::-webkit-scrollbar]:hidden"
            >
              <TabsList className="-mb-px h-auto w-max min-w-full gap-0 border-none md:w-auto md:min-w-0">
                {TABS.map((tab) => (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    ref={(node) => {
                      tabButtonRefs.current[tab.id] = node
                    }}
                    className="h-8 shrink-0 gap-1.5 px-2.5 text-[12.5px]"
                  >
                    <tab.icon className="size-[13px] opacity-80" />
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </Tabs>
        </div>
      </div>

      {activeTab === "files" ? (
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 overflow-hidden px-3 py-3 sm:px-6 sm:py-4">
          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="min-h-0 w-full flex-1 gap-0"
          >
            <TabsContent value="files" className="min-h-0 flex-1">
              <FilesTab />
            </TabsContent>
          </Tabs>
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl min-w-0 overflow-x-hidden px-3 pt-4 pb-10 sm:px-6 sm:pt-5 sm:pb-12">
            <Tabs value={activeTab} onValueChange={handleTabChange}>
              <TabsContent value="models">
                <ModelsTab />
              </TabsContent>
              <TabsContent value="profiles">
                <ProfilesTab />
              </TabsContent>
              <TabsContent value="auth">
                <AuthTab />
              </TabsContent>
              <TabsContent value="logs">
                <LogsTab />
              </TabsContent>
              <TabsContent value="usage">
                <UsageTab />
              </TabsContent>
              <TabsContent value="updates">
                <UpdateTab />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      )}
    </div>
  )
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === "dark"

  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
      {dark ? "Light" : "Dark"}
    </button>
  )
}
