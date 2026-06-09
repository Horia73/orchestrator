import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"
import { RouteSkeleton } from "@/components/route-skeleton"

export default function Loading() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        <RouteSkeleton variant="list" />
      </SidebarInset>
    </>
  )
}
