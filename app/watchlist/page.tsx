import * as React from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { WatchlistView } from "@/components/watchlist/watchlist-view"
import { SidebarInset } from "@/components/ui/sidebar"

export default function WatchlistPage() {
    return (
        <>
            <AppSidebar />
            <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
                <React.Suspense fallback={null}>
                    <WatchlistView />
                </React.Suspense>
            </SidebarInset>
        </>
    )
}
