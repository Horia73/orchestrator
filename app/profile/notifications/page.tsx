import * as React from "react"
import { redirect } from "next/navigation"
import { BellRing } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { RouteFade } from "@/components/route-fade"
import { NotificationsTab } from "@/components/settings/notifications-tab"
import { SidebarInset } from "@/components/ui/sidebar"
import { getCurrentProfileFromCookies } from "@/lib/profiles/server"

export default async function ProfileNotificationsPage() {
  const current = await getCurrentProfileFromCookies()
  if (!current) redirect("/profiles?next=/profile/notifications")

  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        <RouteFade>
          <div className="border-b border-border/60 bg-background">
            <div className="mx-auto w-full max-w-4xl min-w-0 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 sm:px-6 sm:pt-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground text-background">
                  <BellRing className="size-4" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-[20px] font-semibold tracking-tight text-foreground">
                    Notifications
                  </h1>
                  <p className="mt-0.5 text-[11.5px] text-foreground/55">
                    Push devices for {current.profile.name}.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl min-w-0 overflow-x-hidden px-3 pt-4 pb-10 sm:px-6 sm:pt-5 sm:pb-12">
              <React.Suspense fallback={null}>
                <NotificationsTab />
              </React.Suspense>
            </div>
          </div>
        </RouteFade>
      </SidebarInset>
    </>
  )
}
