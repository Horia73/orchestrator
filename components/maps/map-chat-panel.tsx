"use client"

import * as React from "react"
import { MapPinned, X } from "lucide-react"

import { ChatInput } from "@/components/chat-input"
import { MessageBubble, StreamingBubble } from "@/components/message-bubble"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import { useChatStore } from "@/hooks/use-chat-store"
import type { SendMessageOptions } from "@/hooks/use-chat-store"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"
import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { cn } from "@/lib/utils"

interface MapChatPanelProps {
  open: boolean
  mobile: boolean
  docked?: boolean
  activeMapTitle: string
  preferredConversationId?: string | null
  buildPromptContext: () => string
  onShowPlaces: () => void
  onShowMap: () => void
  onCollapse: () => void
  onMapArtifact: (artifact: ArtifactRow) => void
}

export function MapChatPanel({
  open,
  mobile,
  docked = false,
  activeMapTitle,
  preferredConversationId,
  buildPromptContext,
  onShowPlaces,
  onShowMap,
  onCollapse,
  onMapArtifact,
}: MapChatPanelProps) {
  const { newChat, selectConversation, sendMessage, state } = useChatStore()
  const keyboardInset = useMobileKeyboardInset()
  const scrollbarVisible = useRevealOnScroll()
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const preferredSelectionRef = React.useRef<string | null>(null)
  const lastPreferredConversationIdRef = React.useRef<string | null>(null)
  const blankConversationPreparedRef = React.useRef(false)

  React.useEffect(() => {
    if (lastPreferredConversationIdRef.current !== preferredConversationId) {
      lastPreferredConversationIdRef.current = preferredConversationId ?? null
      preferredSelectionRef.current = null
      blankConversationPreparedRef.current = false
    }
  }, [preferredConversationId])

  React.useEffect(() => {
    if (!open) {
      blankConversationPreparedRef.current = false
      return
    }

    if (preferredConversationId) {
      if (preferredSelectionRef.current === preferredConversationId) return
      preferredSelectionRef.current = preferredConversationId
      if (state.activeConversationId === preferredConversationId) return
      selectConversation(preferredConversationId)
      return
    }

    if (blankConversationPreparedRef.current) return
    blankConversationPreparedRef.current = true
    if (state.activeConversationId) newChat()
  }, [
    newChat,
    open,
    preferredConversationId,
    selectConversation,
    state.activeConversationId,
  ])

  const activeConversation = React.useMemo(
    () =>
      state.conversations.find(
        (conversation) => conversation.id === state.activeConversationId
      ) ?? null,
    [state.activeConversationId, state.conversations]
  )
  const conversationId =
    activeConversation?.id ?? state.activeConversationId ?? ""
  const isStreamingThisConversation = Boolean(
    state.isStreaming &&
    conversationId &&
    state.streamingConversationId === conversationId
  )
  const latestAssistantMessageId = React.useMemo(() => {
    const messages = activeConversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id
    }
    return null
  }, [activeConversation?.messages])
  const showStreamingBubble = Boolean(isStreamingThisConversation)

  const buildSendOptions = React.useCallback(
    (): SendMessageOptions => ({
      promptContext: buildPromptContext(),
      activateIntegrations: ["maps"],
    }),
    [buildPromptContext]
  )

  React.useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [
    open,
    activeConversation?.messages.length,
    state.streamingContent,
    state.streamingReasoning.length,
  ])

  // Track how far the user sits from the bottom so the keyboard toggle can
  // keep the latest messages in view only when they were already there —
  // a reader scrolled up in history must not be yanked down.
  const distanceFromBottomRef = React.useRef(0)
  const trackScrollDistance = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    distanceFromBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight
  }, [])

  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (distanceFromBottomRef.current <= 80) {
      el.scrollTop = el.scrollHeight
    }
  }, [keyboardInset])

  const handleQuickPrompt = React.useCallback(
    (content: string) => {
      sendMessage(content, undefined, undefined, buildSendOptions())
    },
    [buildSendOptions, sendMessage]
  )

  const handleArtifactExpand = React.useCallback(
    (artifact: ArtifactRow) => {
      if (artifact.type === "application/vnd.ant.map") onMapArtifact(artifact)
    },
    [onMapArtifact]
  )

  if (!open) return null

  const panel = (
    <ConversationArtifactsProvider conversationId={conversationId}>
      <section
        aria-label="Maps chat"
        className={cn(
          "relative flex min-h-0 flex-col overflow-hidden border border-border/70 bg-background shadow-xl",
          docked
            ? "h-full w-[380px] max-w-[100vw] shrink-0 rounded-none border-y-0 border-r-0 shadow-none"
            : mobile
              ? "fixed inset-0 z-[80] h-dvh w-screen rounded-none border-0"
              : "absolute top-0 right-0 bottom-0 z-[70] w-[380px] rounded-none border-y-0 border-r-0 shadow-none"
        )}
        data-scrollbar-visible={scrollbarVisible.active ? "true" : "false"}
        onScrollCapture={scrollbarVisible.reveal}
      >
        <header className="relative z-10 shrink-0 border-b border-border/60 bg-background px-3 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1 px-1">
              <div className="truncate text-[13px] font-semibold text-foreground">
                {activeConversation?.title ?? activeMapTitle}
              </div>
              {activeConversation && (
                <div className="truncate text-[11px] text-muted-foreground">
                  {activeMapTitle}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onCollapse}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Close maps chat"
              title="Close maps chat"
            >
              <X className="size-4" />
            </button>
          </div>
          <div
            className="mt-3 grid h-8 min-w-0 grid-cols-3 rounded-lg bg-muted p-0.5"
            aria-label="Map sidebar mode"
          >
            <button
              type="button"
              aria-pressed
              className="rounded-md bg-background px-2 text-[12px] font-medium text-foreground shadow-sm"
            >
              Chat
            </button>
            <button
              type="button"
              onClick={onShowPlaces}
              className="rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Places
            </button>
            <button
              type="button"
              onClick={onShowMap}
              className="rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Map
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="transient-scrollbar min-h-0 flex-1 overflow-y-auto"
          style={{
            WebkitOverflowScrolling: "touch",
            overscrollBehaviorY: "contain",
          }}
          onScroll={trackScrollDistance}
        >
          <div
            className="mx-auto flex min-h-full w-full max-w-[700px] flex-col px-4 pt-6"
            style={{
              // Clearance for the bottom input overlay, plus the keyboard
              // height while it's up (the input lifts by exactly that much).
              paddingBottom: keyboardInset + 134,
            }}
          >
            {activeConversation ? (
              <div className="space-y-6">
                {activeConversation.messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    compact
                    suppressArtifactTypes={["application/vnd.ant.map"]}
                    isLatestAssistantMessage={
                      message.id === latestAssistantMessageId
                    }
                    onArtifactExpand={handleArtifactExpand}
                  />
                ))}
                {showStreamingBubble && (
                  <StreamingBubble
                    compact
                    suppressArtifactTypes={["application/vnd.ant.map"]}
                    reasoning={state.streamingReasoning}
                    content={state.streamingContent}
                    contentSegments={state.streamingContentSegments}
                    streamingMode={state.streamingMode}
                    streamingStatus={state.streamingStatus}
                    showCursor={
                      state.streamingReasoning.length === 0 &&
                      state.streamingContent.length === 0
                    }
                    messageId={state.streamingMessageId ?? undefined}
                    thinkingSeconds={state.thinkingSeconds}
                    thinkingDone={state.thinkingDone}
                    onArtifactExpand={handleArtifactExpand}
                  />
                )}
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center py-12">
                <div className="w-full max-w-[280px] text-center">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
                    <MapPinned className="size-4 text-muted-foreground" />
                  </div>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {[
                      "Find places near this map",
                      "Plan a route from here",
                      "Research this area",
                    ].map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => handleQuickPrompt(prompt)}
                        className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-[12px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div
          className="pointer-events-none absolute right-0 bottom-0 left-0 z-10 bg-background px-3 pt-2 transition-transform duration-150 ease-out"
          style={{
            paddingBottom:
              keyboardInset > 0
                ? "0.25rem"
                : "calc(0.75rem + env(safe-area-inset-bottom))",
            transform:
              keyboardInset > 0
                ? `translate3d(0, -${keyboardInset}px, 0)`
                : undefined,
          }}
        >
          <div className="pointer-events-auto">
            <ChatInput
              variant="chat"
              density="compact"
              draftNamespace="maps-chat"
              placeholder="Message..."
              buildSendOptions={buildSendOptions}
            />
          </div>
        </div>
      </section>
    </ConversationArtifactsProvider>
  )

  return panel
}
