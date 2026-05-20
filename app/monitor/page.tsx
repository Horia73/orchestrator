import * as React from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { MonitorView } from "@/components/monitor/monitor-view"

export default function MonitorPage() {
    return (
        <>
            <AppSidebar />
            <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
                <React.Suspense fallback={null}>
                    <MonitorView />
                </React.Suspense>
            </SidebarInset>
        </>
    )
}
