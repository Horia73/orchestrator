import * as React from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { InboxView } from "@/components/inbox/inbox-view"

export default function InboxPage() {
    return (
        <>
            <AppSidebar />
            <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
                <React.Suspense fallback={null}>
                    <InboxView />
                </React.Suspense>
            </SidebarInset>
        </>
    )
}
