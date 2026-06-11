import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset } from "@/components/ui/sidebar"

/**
 * Blank route bridge: the departing view fades out (VIEW_LEAVE_EVENT), this
 * boundary holds the app chrome over an empty inset, and the arriving view
 * fades in via RouteFade — a consistent fade-out -> fade-in with no skeleton
 * flash. Genuine in-page data loads keep their own skeletons/spinners.
 */
export default function Loading() {
  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background" />
    </>
  )
}
