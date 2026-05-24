import * as React from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SmartMapsView } from "@/components/maps/smart-maps-view"
import { SidebarInset } from "@/components/ui/sidebar"
import { getUserMapLocation } from "@/lib/maps/user-location"

export default async function SmartMapDetailPage({
    params,
}: {
    params: Promise<{ id: string }>
}) {
    const { id } = await params
    const homeLocation = getUserMapLocation()

    return (
        <>
            <AppSidebar />
            <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
                <React.Suspense fallback={null}>
                    <SmartMapsView homeLocation={homeLocation} initialMapId={id} />
                </React.Suspense>
            </SidebarInset>
        </>
    )
}
