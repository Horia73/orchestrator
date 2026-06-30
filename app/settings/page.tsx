import * as React from "react"
import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { RouteFade } from "@/components/route-fade"
import { SidebarInset } from "@/components/ui/sidebar"
import { SettingsView } from "@/components/settings/settings-view"
import { getCurrentProfileFromCookies } from "@/lib/profiles/server"

export default async function SettingsPage() {
    const current = await getCurrentProfileFromCookies()
    if (!current) redirect("/profiles?next=/settings")
    if (!current.isAdmin && !current.profile.permissions.surfaces.settings) {
        redirect("/")
    }

    return (
        <>
            <AppSidebar />
            <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
                <RouteFade>
                    <React.Suspense fallback={null}>
                        <SettingsView />
                    </React.Suspense>
                </RouteFade>
            </SidebarInset>
        </>
    )
}
