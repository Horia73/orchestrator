"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { ChatView } from "@/components/chat-view"
import { HomeView } from "@/components/home-view"
import { useChatStore } from "@/hooks/use-chat-store"
import { SidebarInset } from "@/components/ui/sidebar"
import { useDocumentViewportLock } from "@/hooks/use-document-viewport-lock"
import { cn } from "@/lib/utils"

function useViewFadeIn(viewKey: string, enabled: boolean) {
  const [enteredViewKey, setEnteredViewKey] = React.useState<string | null>(
    null
  )

  React.useLayoutEffect(() => {
    if (!enabled) {
      setEnteredViewKey(null)
      return
    }

    setEnteredViewKey(null)
    const frame = window.requestAnimationFrame(() => {
      setEnteredViewKey(viewKey)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [enabled, viewKey])

  return enabled && enteredViewKey === viewKey
}

export default function Page() {
  const { state, selectConversation, isSwitchingConversation } = useChatStore()
  const searchParams = useSearchParams()

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

  const activeConversationStatus = state.activeConversationId
    ? state.conversationLoadState[state.activeConversationId]
    : null
  const activeConversationError = state.activeConversationId
    ? state.conversationLoadErrors[state.activeConversationId]
    : null
  const viewKey = state.isLoading
    ? "loading"
    : state.activeConversationId
      ? `chat:${state.activeConversationId}`
      : "home"
  const viewReady = !state.isLoading
  const viewEntered = useViewFadeIn(viewKey, viewReady)
  const activeConversationPending =
    state.activeConversationId != null &&
    (activeConversationStatus === "summary" ||
      activeConversationStatus === "loading")
  const viewVisible =
    viewReady &&
    viewEntered &&
    !isSwitchingConversation &&
    !activeConversationPending

  useDocumentViewportLock()

  return (
    <>
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        {viewReady && (
          <div
            className={cn(
              "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background transition-opacity duration-150 ease-out motion-reduce:transition-none",
              viewVisible ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          >
            {state.activeConversationId && activeConversationStatus === "error" ? (
              <div className="flex flex-1 items-center justify-center px-4 text-center">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Couldn&apos;t load this chat.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {activeConversationError ?? "Try selecting it again."}
                  </p>
                </div>
              </div>
            ) : state.activeConversationId ? (
              // Keep ChatView mounted across conversation switches; the shell
              // fades while React prepares the next chat at transition priority.
              <ChatView />
            ) : (
              <HomeView />
            )}
          </div>
        )}
      </SidebarInset>
    </>
  )
}
