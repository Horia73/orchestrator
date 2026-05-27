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
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WorkoutsHistory } from "@/components/workouts/workouts-history"
import { cn } from "@/lib/utils"
import { AttachmentsTab } from "@/components/library/attachments-tab"
import { MediaGrid } from "@/components/library/media-grid"
import { AudioList } from "@/components/library/audio-list"
import { FilesList } from "@/components/library/files-list"
import { RecipesTab } from "@/components/library/recipes-tab"
import { MapsTab } from "@/components/library/maps-tab"
import { PlacesTab } from "@/components/library/places-tab"
import { prefetchAttachments } from "@/components/library/use-attachments"

/**
 * /library — single hub for all "things you've generated" across the app.
 *
 * Tabs along the top let you switch between Workouts (live, fully wired),
 * Recipes and Maps (placeholders until those domains ship history backends).
 * Adding a new tab later is a one-line addition.
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
  | "places"
  | "media"
  | "audio"
  | "files"

const TAB_DEFS: Array<{
  key: TabKey
  label: string
  icon: typeof Dumbbell
}> = [
  { key: "workouts", label: "Workouts", icon: Dumbbell },
  { key: "recipes", label: "Recipes", icon: ChefHat },
  { key: "maps", label: "Maps", icon: MapPinned },
  { key: "places", label: "Places", icon: LocateFixed },
  { key: "media", label: "Media", icon: ImageIcon },
  { key: "audio", label: "Audio", icon: Music },
  { key: "files", label: "Files", icon: FileIcon },
]

const ALL_TAB_KEYS = TAB_DEFS.map((t) => t.key)
const TAB_FADE_MS = 140

function tabTriggerId(key: TabKey) {
  return `library-tab-${key}`
}

function tabPanelId(key: TabKey) {
  return `library-panel-${key}`
}

function isTabKey(s: string | null): s is TabKey {
  return s !== null && (ALL_TAB_KEYS as string[]).includes(s)
}

export default function LibraryPage() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        <React.Suspense fallback={null}>
          <LibraryView />
        </React.Suspense>
      </SidebarInset>
    </>
  )
}

function LibraryView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialTab = searchParams ? searchParams.get("tab") : null
  const [active, setActive] = React.useState<TabKey>(
    isTabKey(initialTab) ? initialTab : "workouts"
  )
  const [displayed, setDisplayed] = React.useState<TabKey>(
    isTabKey(initialTab) ? initialTab : "workouts"
  )
  const [contentVisible, setContentVisible] = React.useState(true)
  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<TabKey>>(
    () => new Set([isTabKey(initialTab) ? initialTab : "workouts"])
  )

  const handleChange = React.useCallback(
    (next: string) => {
      if (!isTabKey(next)) return
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
    [router]
  )

  React.useEffect(() => {
    const fromUrl = searchParams ? searchParams.get("tab") : null
    if (isTabKey(fromUrl) && fromUrl !== active) {
      setActive(fromUrl)
      setVisitedTabs((current) => {
        if (current.has(fromUrl)) return current
        const nextSet = new Set(current)
        nextSet.add(fromUrl)
        return nextSet
      })
    }
  }, [searchParams, active])

  React.useEffect(() => {
    if (active === displayed) {
      setContentVisible(true)
      return
    }

    setContentVisible(false)
    const timer = window.setTimeout(() => {
      setDisplayed(active)
    }, TAB_FADE_MS)

    return () => window.clearTimeout(timer)
  }, [active, displayed])

  React.useEffect(() => {
    const timer = window.setTimeout(
      () => prefetchAttachments(["media", "audio", "files"]),
      250
    )
    return () => window.clearTimeout(timer)
  }, [])

  const mountedTabs = React.useMemo(() => {
    const next = new Set(visitedTabs)
    next.add(active)
    return next
  }, [active, visitedTabs])

  return (
    <div className="library-scroll flex min-h-0 w-full max-w-none flex-1 flex-col gap-2 overflow-y-auto px-3 py-3 sm:p-4 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
            <LibraryIcon className="size-5 text-primary" strokeWidth={1.85} />
            Library
          </h1>
          <p className="text-[11.5px] leading-tight text-muted-foreground">
            Tot ce ai generat — workouts, rețete, hărți — într-un singur loc.
          </p>
        </div>
      </header>

      <Tabs value={active} onValueChange={handleChange} className="min-w-0">
        <TabsList className="scrollbar-hide -mb-2 w-full max-w-full justify-start overflow-x-auto">
          {TAB_DEFS.map(({ key, label, icon: Icon }) => (
            <TabsTrigger
              key={key}
              value={key}
              id={tabTriggerId(key)}
              aria-controls={tabPanelId(key)}
            >
              <Icon className="size-4" strokeWidth={1.85} />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div
          className={cn(
            "mt-1 min-w-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
            contentVisible ? "opacity-100" : "opacity-0"
          )}
        >
          <LibraryTabPanel
            value="workouts"
            active={displayed}
            mounted={mountedTabs.has("workouts")}
          >
            <WorkoutsHistory />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="recipes"
            active={displayed}
            mounted={mountedTabs.has("recipes")}
          >
            <RecipesTab />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="maps"
            active={displayed}
            mounted={mountedTabs.has("maps")}
          >
            <MapsTab />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="places"
            active={displayed}
            mounted={mountedTabs.has("places")}
          >
            <PlacesTab />
          </LibraryTabPanel>

          <LibraryTabPanel
            value="media"
            active={displayed}
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
            active={displayed}
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
            active={displayed}
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
