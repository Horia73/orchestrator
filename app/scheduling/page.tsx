import * as React from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { SchedulingView } from "@/components/scheduling/scheduling-view"

export default function SchedulingPage() {
    return (
        <>
            <AppSidebar />
            <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
                <React.Suspense fallback={null}>
                    <SchedulingView />
                </React.Suspense>
            </SidebarInset>
        </>
    )
}
