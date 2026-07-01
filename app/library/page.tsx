"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ChefHat,
  Dumbbell,
  File as FileIcon,
  Image as ImageIcon,
  Library as LibraryIcon,
  LocateFixed,
  MapPinned,
  Music,
  Shapes,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { RouteFade } from "@/components/route-fade"
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WorkoutsHistory } from "@/components/workouts/workouts-history"
import { cn } from "@/lib/utils"
import { AttachmentsTab } from "@/components/library/attachments-tab"
import { MediaGrid } from "@/components/library/media-grid"
import { AudioList } from "@/components/library/audio-list"
import { FilesList } from "@/components/library/files-list"
import { RecipesTab } from "@/components/library/recipes-tab"
import { MapsTab } from "@/components/library/maps-tab"
import { ArtifactsTab } from "@/components/library/artifacts-tab"
import { PlacesTab } from "@/components/library/places-tab"
import { prefetchAttachments } from "@/components/library/use-attachments"
import { useCurrentProfile } from "@/components/profiles/use-profiles"

/**
 * /library — single hub for all "things you've generated" across the app.
 *
 * Tabs along the top start with Artifacts, then domain-specific generated
 * outputs and attachment libraries. Adding a new tab later is a one-line addition.
 *
 * The active tab is mirrored to the URL via `?tab=workouts`, so deep
 * links work (sidebar can link to specific tabs; bookmarks survive).
 *
 * The page mounts AppSidebar + SidebarInset like every other top-level
 * page (inbox, maps, watchlist). Each tab content is a self-contained
 * component that fetches its own data; switching tabs is cheap.
 */

type TabKey =
  | "workouts"
  | "recipes"
  | "maps"
  | "artifacts"
  | "places"
  | "media"
  | "audio"
  | "files"

type TabDefinition = {
  key: TabKey
  label: string
  icon: typeof Dumbbell
}

const TAB_DEFS: TabDefinition[] = [
  { key: "artifacts", label: "Artifacts", icon: Shapes },
  { key: "workouts", label: "Workouts", icon: Dumbbell },
  { key: "recipes", label: "Recipes", icon: ChefHat },
  { key: "maps", label: "Maps", icon: MapPinned },
  { key: "places", label: "Places", icon: LocateFixed },
  { key: "media", label: "Media", icon: ImageIcon },
  { key: "audio", label: "Audio", icon: Music },
  { key: "files", label: "Files", icon: FileIcon },
]

const ALL_TAB_KEYS = TAB_DEFS.map((t) => t.key)
// Must match the `duration-150` on the tab content wrapper below, so the
// outgoing tab finishes fading before the content swaps.
const TAB_FADE_MS = 150

function tabTriggerId(key: TabKey) {
  return `library-tab-${key}`
}

function tabPanelId(key: TabKey) {
  return `library-panel-${key}`
}

function isTabKey(s: string | null): s is TabKey {
  return s !== null && (ALL_TAB_KEYS as string[]).includes(s)
}

function firstVisibleTab(tabs: ReadonlyArray<TabDefinition>): TabKey {
  return tabs[0]?.key ?? "artifacts"
}

export default function LibraryPage() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        <RouteFade>
          <React.Suspense fallback={null}>
            <LibraryView />
          </React.Suspense>
        </RouteFade>
      </SidebarInset>
    </>
  )
}

function LibraryView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { permissions, isAdmin } = useCurrentProfile()
  const initialTab = searchParams ? searchParams.get("tab") : null
  const visibleTabs = React.useMemo(
    () =>
      TAB_DEFS.filter(
        (tab) =>
          tab.key !== "workouts" ||
          isAdmin ||
          permissions?.surfaces.workouts !== false
      ),
    [isAdmin, permissions]
  )
  const visibleTabKeys = React.useMemo(
    () => new Set<TabKey>(visibleTabs.map((tab) => tab.key)),
    [visibleTabs]
  )
  const fallbackTab = firstVisibleTab(visibleTabs)
  const isVisibleTabKey = React.useCallback(
    (value: string | null): value is TabKey =>
      isTabKey(value) && visibleTabKeys.has(value),
    [visibleTabKeys]
  )
  const initialVisibleTab = isVisibleTabKey(initialTab)
    ? initialTab
    : fallbackTab
  const [active, setActive] = React.useState<TabKey>(initialVisibleTab)
  const [displayed, setDisplayed] = React.useState<TabKey>(initialVisibleTab)
  const [contentVisible, setContentVisible] = React.useState(true)
  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<TabKey>>(
    () => new Set([initialVisibleTab])
  )
  const activeForRender = isVisibleTabKey(active) ? active : fallbackTab
  const displayedForRender = isVisibleTabKey(displayed)
    ? displayed
    : activeForRender
  const workoutsVisible = visibleTabKeys.has("workouts")

  const handleChange = React.useCallback(
    (next: string) => {
      if (!isVisibleTabKey(next)) return
      setActive(next)
      setVisitedTabs((current) => {
        if (current.has(next)) return current
        const nextSet = new Set(current)
        nextSet.add(next)
        return nextSet
      })
      const params = new URLSearchParams(window.location.search)
      params.set("tab", next)
      router.replace(`/library?${params.toString()}`, { scroll: false })
    },
    [isVisibleTabKey, router]
  )

  React.useEffect(() => {
    const fromUrl = searchParams ? searchParams.get("tab") : null
    const next = isVisibleTabKey(fromUrl) ? fromUrl : fallbackTab

    if (fromUrl !== null && isTabKey(fromUrl) && fromUrl !== next) {
      const params = new URLSearchParams(window.location.search)
      params.set("tab", next)
      router.replace(`/library?${params.toString()}`, { scroll: false })
    }

    if (fromUrl !== null || !isVisibleTabKey(active)) {
      if (next !== active) setActive(next)
      setVisitedTabs((current) => {
        if (current.has(next)) return current
        const nextSet = new Set(current)
        nextSet.add(next)
        return nextSet
      })
    }
  }, [searchParams, active, fallbackTab, isVisibleTabKey, router])

  React.useEffect(() => {
    if (!isVisibleTabKey(displayed)) {
      setDisplayed(activeForRender)
      setContentVisible(true)
      return
    }

    if (activeForRender === displayed) {
      setContentVisible(true)
      return
    }

    setContentVisible(false)
    const timer = window.setTimeout(() => {
      setDisplayed(activeForRender)
    }, TAB_FADE_MS)

    return () => window.clearTimeout(timer)
  }, [activeForRender, displayed, isVisibleTabKey])

  React.useEffect(() => {
    const timer = window.setTimeout(
      () => prefetchAttachments(["media", "audio", "files"]),
      250
    )
    return () => window.clearTimeout(timer)
  }, [])

  const mountedTabs = React.useMemo(() => {
    const next = new Set<TabKey>()
    for (const tab of visitedTabs) {
      if (visibleTabKeys.has(tab)) next.add(tab)
    }
    next.add(activeForRender)
    return next
  }, [activeForRender, visitedTabs, visibleTabKeys])

  return (
    <div className="library-scroll flex min-h-0 w-full max-w-none flex-1 flex-col gap-2 overflow-y-auto px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:p-4 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <SidebarTrigger className="-ml-1 size-9 shrink-0 text-foreground/55 hover:text-foreground md:hidden" />
          <div className="min-w-0">
            <h1 className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
              <LibraryIcon className="size-5 text-primary" strokeWidth={1.85} />
              Library
            </h1>
            <p className="text-[11.5px] leading-tight text-muted-foreground">
              {workoutsVisible
                ? "Tot ce ai generat — workouts, rețete, hărți — într-un singur loc."
                : "Tot ce ai generat — rețete, hărți, media și fișiere — într-un singur loc."}
            </p>
          </div>
        </div>
      </header>

      <Tabs
        value={activeForRender}
        onValueChange={handleChange}
        className="min-w-0"
      >
        <TabsList
          aria-label="Library sections"
          className="mb-0 grid h-auto w-full max-w-full grid-cols-3 items-stretch gap-1 overflow-visible pb-1 min-[380px]:grid-cols-4 sm:-mb-2 sm:inline-flex sm:h-10 sm:snap-x sm:snap-mandatory sm:justify-start sm:overflow-x-auto sm:overscroll-x-contain sm:pb-0 sm:[scroll-padding-inline:0.25rem] sm:[touch-action:pan-x]"
        >
          {visibleTabs.map(({ key, label, icon: Icon }) => (
            <TabsTrigger
              key={key}
              value={key}
              id={tabTriggerId(key)}
              aria-controls={tabPanelId(key)}
              className="w-full justify-center px-1.5 text-[12.5px] sm:w-auto sm:justify-start sm:px-3 sm:text-[14px]"
            >
              <Icon className="size-4" strokeWidth={1.85} />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div
          className={cn(
            "mt-1 min-w-0 transition-opacity duration-150 ease-out will-change-[opacity] motion-reduce:transition-none",
            contentVisible ? "opacity-100" : "opacity-0"
          )}
        >
          <LibraryTabPanel
            value="artifacts"
            active={displayedForRender}
            mounted={mountedTabs.has("artifacts")}
          >
            <ArtifactsTab />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="workouts"
            active={displayedForRender}
            mounted={mountedTabs.has("workouts")}
          >
            <WorkoutsHistory />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="recipes"
            active={displayedForRender}
            mounted={mountedTabs.has("recipes")}
          >
            <RecipesTab />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="maps"
            active={displayedForRender}
            mounted={mountedTabs.has("maps")}
          >
            <MapsTab />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="places"
            active={displayedForRender}
            mounted={mountedTabs.has("places")}
          >
            <PlacesTab />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="media"
            active={displayedForRender}
            mounted={mountedTabs.has("media")}
          >
            <AttachmentsTab
              type="media"
              description="Toate imaginile și videourile din conversațiile tale, într-o galerie."
              emptyIcon={ImageIcon}
              emptyTitle="Niciun media salvat încă"
              emptyDescription="Imaginile și videourile din chat sau fișierele media extra din workspace apar aici automat."
              renderItems={(items, selection) => (
                <MediaGrid attachments={items} selection={selection} />
              )}
            />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="audio"
            active={displayedForRender}
            mounted={mountedTabs.has("audio")}
          >
            <AttachmentsTab
              type="audio"
              description="Fișiere audio din conversațiile tale, cu player inline."
              emptyIcon={Music}
              emptyTitle="Niciun fișier audio încă"
              emptyDescription="Voice notes, podcasts, muzică — orice audio din chat sau workspace extra apare aici cu buton de play."
              renderItems={(items, selection) => (
                <AudioList attachments={items} selection={selection} />
              )}
            />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="files"
            active={displayedForRender}
            mounted={mountedTabs.has("files")}
          >
            <AttachmentsTab
              type="files"
              description="Documente, PDF-uri, foi de calcul, cod și alte fișiere non-media."
              emptyIcon={FileIcon}
              emptyTitle="Niciun fișier încă"
              emptyDescription="PDF-uri, documente, foi, cod și alte fișiere din chat sau extra față de workspace-ul standard apar aici."
              renderItems={(items, selection) => (
                <FilesList attachments={items} selection={selection} />
              )}
            />
          </LibraryTabPanel>
        </div>
      </Tabs>
    </div>
  )
}

function LibraryTabPanel({
  value,
  active,
  mounted,
  children,
}: {
  value: TabKey
  active: TabKey
  mounted: boolean
  children: React.ReactNode
}) {
  if (!mounted) return null

  const isActive = active === value

  return (
    <section
      id={tabPanelId(value)}
      role="tabpanel"
      aria-labelledby={tabTriggerId(value)}
      hidden={!isActive}
      className="min-w-0"
    >
      {children}
    </section>
  )
}
