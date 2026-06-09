import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"

// Blank loading boundary: navigating to the inbox shows the chrome + an empty
// background immediately, then InboxView fades its content in once the list is
// ready (see components/inbox/inbox-view.tsx). No skeleton — the previous view
// fades out, this blank bridges the gap, and the inbox fades in.
export default function Loading() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        <div className="min-h-0 flex-1 bg-background" />
      </SidebarInset>
    </>
  )
}
