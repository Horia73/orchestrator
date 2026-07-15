"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { AppLoadingSplash } from "@/components/app-loading-splash"
import { ChatView } from "@/components/chat-view"
import { HomeView } from "@/components/home-view"
import { useChatStore } from "@/hooks/use-chat-store"
import { SidebarInset } from "@/components/ui/sidebar"
import { useDocumentViewportLock } from "@/hooks/use-document-viewport-lock"
import { useViewLeaveFade } from "@/hooks/use-view-leave-fade"
import { appApiPath } from "@/lib/app-path"
import { publishChatScrollTarget } from "@/lib/chat-scroll-target"
import {
  getChatViewSettledConversationId,
  getServerChatViewSettledConversationId,
  subscribeChatViewSettled,
} from "@/lib/chat-view-settled"
import { cn } from "@/lib/utils"
import { LOADED_WHILE_HIDDEN } from "@/lib/loaded-while-hidden"
import { VIEW_FADE_MS } from "@/lib/view-fade"
import type { Conversation } from "@/lib/types"

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

// Hiding is immediate (the fade-out starts the instant a switch begins), but
// returning to visible is held for at least `minHiddenMs`. On a fast
// conversation switch the raw visibility would flip back to true before the
// opacity transition reached 0, reversing the fade mid-flight and swapping the
// new chat in at a partial opacity — which reads as a jitter/flicker. The floor
// lets the fade-out complete (and the new chat swap in invisibly) before the
// fade-in, turning the blip into a deliberate fade-out → fade-in. It never
// shortens anything: a slow chat load already exceeds the floor, so the hold is
// absorbed and the fade-in fires as soon as the chat is ready.
function useFadeGate(target: boolean, minHiddenMs: number) {
  const [canShow, setCanShow] = React.useState(true)
  const hiddenAtRef = React.useRef<number | null>(null)

  // This gate controls whether the next paint may expose the chat shell, so
  // update it in the layout phase. A passive effect leaves one painted frame
  // where a fast false -> true readiness cycle can reuse the previous
  // `canShow=true` value and briefly reveal content before hiding it again.
  React.useLayoutEffect(() => {
    if (!target) {
      if (hiddenAtRef.current == null) hiddenAtRef.current = performance.now()
      setCanShow(false)
      return
    }

    if (hiddenAtRef.current == null) {
      setCanShow(true)
      return
    }

    const remaining = minHiddenMs - (performance.now() - hiddenAtRef.current)
    if (remaining <= 0) {
      hiddenAtRef.current = null
      setCanShow(true)
      return
    }

    const timer = window.setTimeout(() => {
      hiddenAtRef.current = null
      setCanShow(true)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [target, minHiddenMs])

  return target && canShow
}

export default function Page() {
  const { state, selectConversation, isSwitchingConversation, pendingViewSwitch } =
    useChatStore()
  const searchParams = useSearchParams()
  const router = useRouter()
  const lastAppliedChatParamRef = React.useRef<string | null>(null)
  const lastAppliedMsgParamRef = React.useRef<string | null>(null)
  const desiredChatIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    const chatId = searchParams.get("chat")
    desiredChatIdRef.current = chatId
    if (!chatId) {
      lastAppliedChatParamRef.current = null
      return
    }

    // A `&msg=<id>` deep-link (Library → "View in chat") asks the chat view to
    // scroll to a specific message. Publish the request (sessionStorage +
    // event, so it survives the /library → / navigation and a fresh ChatView
    // mount) BEFORE selecting, then strip `msg` from the URL so refresh/back
    // doesn't re-jump. Runs above the "already active" early-return so an
    // already-open chat still jumps. Guarded to fire once per chat:msg.
    const msgId = searchParams.get("msg")
    if (msgId && lastAppliedMsgParamRef.current !== `${chatId}:${msgId}`) {
      lastAppliedMsgParamRef.current = `${chatId}:${msgId}`
      publishChatScrollTarget({
        conversationId: chatId,
        messageId: msgId,
        requestedAt: Date.now(),
      })
      const next = new URLSearchParams(searchParams)
      next.delete("msg")
      const qs = next.toString()
      router.replace(qs ? `/?${qs}` : "/", { scroll: false })
    }

    if (state.isLoading) return
    if (state.activeConversationId === chatId) {
      lastAppliedChatParamRef.current = chatId
      return
    }
    if (lastAppliedChatParamRef.current === chatId) return

    if (
      state.conversations.some((conversation) => conversation.id === chatId)
    ) {
      lastAppliedChatParamRef.current = chatId
      selectConversation(chatId)
      return
    }

    // The id isn't in the sidebar list — most commonly an archived
    // conversation, which the list query filters out. Fetch it directly
    // (getConversation has no archived filter) and inject it so a deep-link
    // (e.g. Library → "View in chat") resolves to the right chat instead of
    // silently falling back to the last-active one. The refs keep this from
    // looping or applying a stale result after the user navigates elsewhere.
    lastAppliedChatParamRef.current = chatId
    void (async () => {
      try {
        const res = await fetch(
          appApiPath(`/api/conversations/${encodeURIComponent(chatId)}`)
        )
        if (!res.ok) return
        const conversation = (await res.json()) as Conversation
        if (desiredChatIdRef.current !== chatId) return
        selectConversation(chatId, conversation)
      } catch {
        // Network/parse failure — leave the current view untouched.
      }
    })()
  }, [
    router,
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
  // The conversation ChatView has fully settled for (messages rendered +
  // scroll restored). Gating the fade-in on it means the view eases in over a
  // finished layout — nothing shifts mid-fade. Error views bypass it (ChatView
  // isn't rendered, so it can never settle).
  const settledChatConversationId = React.useSyncExternalStore(
    subscribeChatViewSettled,
    getChatViewSettledConversationId,
    getServerChatViewSettledConversationId
  )
  const chatViewSettled =
    state.activeConversationId == null ||
    activeConversationStatus === "error" ||
    settledChatConversationId === state.activeConversationId
  const rawViewVisible =
    viewReady &&
    viewEntered &&
    !isSwitchingConversation &&
    !pendingViewSwitch &&
    !activeConversationPending &&
    chatViewSettled
  // Hold the shell hidden for at least one fade length so a fast switch reads
  // as a clean fade-out → fade-in instead of a mid-flight reversal/jitter.
  const viewVisible = useFadeGate(rawViewVisible, VIEW_FADE_MS)

  // Fade this view out ahead of a route change (e.g. the sidebar Inbox link)
  // so it eases out instead of hard-cutting to the next route's blank loading
  // boundary. The sidebar fires VIEW_LEAVE_EVENT, waits one fade, then
  // navigates. Self-clears as a safety net if a navigation never lands.
  const leaving = useViewLeaveFade()

  const shellVisible = viewVisible && !leaving

  // Hold the first-load splash until the view is genuinely ready (initial
  // conversation messages loaded + scroll-restored + faded in) rather than just
  // until the conversation *list* loaded. Otherwise the splash lifts while the
  // active chat is still populating/settling, and the user watches the text
  // shift into place. Sticky once revealed, so later conversation switches never
  // re-show the splash.
  //
  // The splash shows on a genuine cold start only (both platforms). Warm
  // route→chat navigations (inbox → conversation, etc.) skip it on mobile and
  // desktop alike: the departing view fades out, the blank shell bridges the
  // gap, and the chat fades in. The lazy initializer runs once on mount, so
  // `state.isLoading` here means "the chat store was still hydrating when this
  // page instance mounted" — true only on a cold start, false on a warm
  // route→chat nav (the store already hydrated in the layout provider).
  const [appRevealed, setAppRevealed] = React.useState(() => !state.isLoading)

  // Background-reload instant reveal. When the page loaded while the tab was
  // hidden (the OS reloaded a discarded background tab), the scroll-restore —
  // and therefore the whole reveal — was blocked on rAF until the user came
  // back. Without this it then replays the cold-start animation in front of
  // them: splash fades out, the shell crossfades, the conversation eases in.
  // Instead, suppress the splash and the crossfade so the already-settled chat
  // is simply there, unmoved, exactly where they left it. Scoped to the first
  // reveal via a layout effect (keeps SSR/first render identical to the server,
  // so no hydration mismatch) — later route/conversation changes fade normally.
  const [instantReveal, setInstantReveal] = React.useState(false)
  React.useLayoutEffect(() => {
    if (LOADED_WHILE_HIDDEN) {
      setInstantReveal(true)
      setAppRevealed(true)
    }
  }, [])
  React.useEffect(() => {
    if (viewVisible) {
      setAppRevealed(true)
      setInstantReveal(false)
    }
  }, [viewVisible])

  useDocumentViewportLock()

  return (
    <>
      <AppLoadingSplash loading={!appRevealed} />
      <AppSidebar />
      <SidebarInset className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
        {viewReady && (
          <div
            className={cn(
              "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background motion-reduce:transition-none",
              !instantReveal && "transition-opacity duration-150 ease-out",
              shellVisible ? "opacity-100" : "pointer-events-none opacity-0"
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
