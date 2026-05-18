import * as React from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { SettingsView } from "@/components/settings/settings-view"

export default function SettingsPage() {
    return (
        <>
            <AppSidebar />
            <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
                <React.Suspense fallback={null}>
                    <SettingsView />
                </React.Suspense>
            </SidebarInset>
        </>
    )
}
