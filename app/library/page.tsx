"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
    ChefHat,
    Dumbbell,
    File as FileIcon,
    Image as ImageIcon,
    Library as LibraryIcon,
    MapPinned,
    Music,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WorkoutsHistory } from "@/components/workouts/workouts-history"
import { AttachmentsTab } from "@/components/library/attachments-tab"
import { MediaGrid } from "@/components/library/media-grid"
import { AudioList } from "@/components/library/audio-list"
import { FilesList } from "@/components/library/files-list"
import { RecipesTab } from "@/components/library/recipes-tab"
import { MapsTab } from "@/components/library/maps-tab"

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

type TabKey = 'workouts' | 'recipes' | 'maps' | 'media' | 'audio' | 'files'

const TAB_DEFS: Array<{
    key: TabKey
    label: string
    icon: typeof Dumbbell
}> = [
    { key: 'workouts', label: 'Workouts', icon: Dumbbell },
    { key: 'recipes', label: 'Recipes', icon: ChefHat },
    { key: 'maps', label: 'Maps', icon: MapPinned },
    { key: 'media', label: 'Media', icon: ImageIcon },
    { key: 'audio', label: 'Audio', icon: Music },
    { key: 'files', label: 'Files', icon: FileIcon },
]

const ALL_TAB_KEYS = TAB_DEFS.map((t) => t.key)

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
    const initialTab = searchParams ? searchParams.get('tab') : null
    const [active, setActive] = React.useState<TabKey>(isTabKey(initialTab) ? initialTab : 'workouts')

    const handleChange = React.useCallback((next: string) => {
        if (!isTabKey(next)) return
        setActive(next)
        const params = new URLSearchParams(window.location.search)
        params.set('tab', next)
        router.replace(`/library?${params.toString()}`, { scroll: false })
    }, [router])

    React.useEffect(() => {
        const fromUrl = searchParams ? searchParams.get('tab') : null
        if (isTabKey(fromUrl) && fromUrl !== active) {
            setActive(fromUrl)
        }
    }, [searchParams, active])

    return (
        <div className="library-scroll mx-auto flex w-full max-w-6xl flex-col gap-6 overflow-y-auto p-6">
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="inline-flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
                        <LibraryIcon className="size-6 text-primary" strokeWidth={1.85} />
                        Library
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Tot ce ai generat — workouts, rețete, hărți — într-un singur loc.
                    </p>
                </div>
            </header>

            <Tabs value={active} onValueChange={handleChange}>
                <TabsList className="scrollbar-hide -mb-2 overflow-x-auto">
                    {TAB_DEFS.map(({ key, label, icon: Icon }) => (
                        <TabsTrigger key={key} value={key}>
                            <Icon className="size-4" strokeWidth={1.85} />
                            {label}
                        </TabsTrigger>
                    ))}
                </TabsList>

                <TabsContent value="workouts" className="mt-6">
                    <WorkoutsHistory />
                </TabsContent>

                <TabsContent value="recipes" className="mt-6">
                    <RecipesTab />
                </TabsContent>

                <TabsContent value="maps" className="mt-6">
                    <MapsTab />
                </TabsContent>

                <TabsContent value="media" className="mt-6">
                    <AttachmentsTab
                        type="media"
                        description="Toate imaginile și videourile din conversațiile tale, într-o galerie."
                        emptyIcon={ImageIcon}
                        emptyTitle="Niciun media salvat încă"
                        emptyDescription="Imaginile și videourile pe care le trimiți în chat apar aici automat. Trage un fișier într-o conversație ca să-l adaugi."
                        renderItems={(items) => <MediaGrid attachments={items} />}
                    />
                </TabsContent>

                <TabsContent value="audio" className="mt-6">
                    <AttachmentsTab
                        type="audio"
                        description="Fișiere audio din conversațiile tale, cu player inline."
                        emptyIcon={Music}
                        emptyTitle="Niciun fișier audio încă"
                        emptyDescription="Voice notes, podcasts, muzică — orice atașament audio apare aici cu buton de play."
                        renderItems={(items) => <AudioList attachments={items} />}
                    />
                </TabsContent>

                <TabsContent value="files" className="mt-6">
                    <AttachmentsTab
                        type="files"
                        description="Documente, PDF-uri, foi de calcul, cod și alte fișiere non-media."
                        emptyIcon={FileIcon}
                        emptyTitle="Niciun fișier încă"
                        emptyDescription="PDF-urile, documentele Word, foile Excel, fișierele JSON / CSV / cod pe care le trimiți în chat apar aici."
                        renderItems={(items) => <FilesList attachments={items} />}
                    />
                </TabsContent>
            </Tabs>
        </div>
    )
}
