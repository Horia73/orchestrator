"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { ChatView } from "@/components/chat-view"
import { HomeView } from "@/components/home-view"
import { ChatSkeleton } from "@/components/chat-skeleton"
import { useChatStore } from "@/hooks/use-chat-store"
import { SidebarInset } from "@/components/ui/sidebar"

import { HomeSkeleton } from "@/components/home-skeleton"

export default function Page() {
  const { state, selectConversation } = useChatStore()
  const searchParams = useSearchParams()
  const [mounted, setMounted] = React.useState(false)
  const [hasIdOnLoad, setHasIdOnLoad] = React.useState(false)

  React.useLayoutEffect(() => {
    setHasIdOnLoad(!!localStorage.getItem("chat:active-id"))
    setMounted(true)
  }, [])

  React.useEffect(() => {
    const chatId = searchParams.get("chat")
    if (!chatId || state.isLoading || state.activeConversationId === chatId)
      return
    if (
      state.conversations.some((conversation) => conversation.id === chatId)
    ) {
      selectConversation(chatId)
    }
  }, [
    searchParams,
    selectConversation,
    state.activeConversationId,
    state.conversations,
    state.isLoading,
  ])

  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        {state.isLoading ? (
          mounted ? (
            hasIdOnLoad ? (
              <ChatSkeleton />
            ) : (
              <HomeSkeleton />
            )
          ) : null
        ) : state.activeConversationId ? (
          <ChatView key={state.activeConversationId} />
        ) : (
          <HomeView />
        )}
      </SidebarInset>
    </>
  )
}
