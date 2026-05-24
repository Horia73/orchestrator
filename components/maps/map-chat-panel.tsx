"use client"

import * as React from "react"
import { MapPinned, PanelRightClose, Plus } from "lucide-react"

import { ChatInput } from "@/components/chat-input"
import { MessageBubble, StreamingBubble } from "@/components/message-bubble"
import { Button } from "@/components/ui/button"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import { useChatStore } from "@/hooks/use-chat-store"
import type { SendMessageOptions } from "@/hooks/use-chat-store"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"
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
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const preferredSelectionRef = React.useRef<string | null>(null)
  const manualConversationOverrideRef = React.useRef(false)
  const lastPreferredConversationIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (lastPreferredConversationIdRef.current !== preferredConversationId) {
      lastPreferredConversationIdRef.current = preferredConversationId ?? null
      preferredSelectionRef.current = null
      manualConversationOverrideRef.current = false
    }
  }, [preferredConversationId])

  React.useEffect(() => {
    if (!preferredConversationId) return
    if (!open || manualConversationOverrideRef.current) return
    if (preferredSelectionRef.current === preferredConversationId) return
    preferredSelectionRef.current = preferredConversationId
    if (state.activeConversationId === preferredConversationId) return
    selectConversation(preferredConversationId)
  }, [
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

  const handleNewChat = React.useCallback(() => {
    manualConversationOverrideRef.current = true
    preferredSelectionRef.current = null
    newChat()
  }, [newChat])

  if (!open) return null

  const panel = (
    <ConversationArtifactsProvider conversationId={conversationId}>
      <section
        aria-label="Maps chat"
        className={cn(
          "flex min-h-0 flex-col overflow-hidden border border-border/70 bg-background shadow-xl",
          docked
            ? "h-full w-[380px] max-w-[100vw] shrink-0 rounded-none border-y-0 border-r-0 shadow-none"
            : mobile
              ? "fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)_+_3.25rem)] z-[80] h-[min(74dvh,700px)] rounded-lg"
              : "absolute top-0 right-0 bottom-0 z-[70] w-[380px] rounded-none border-y-0 border-r-0 shadow-none"
        )}
      >
        <header className="relative z-10 shrink-0 border-b border-border/60 bg-background px-3 py-3">
          <div className="flex min-w-0 items-center gap-2 pr-[calc(2.5rem_+_0.5rem)]">
            <div
              className="grid h-8 min-w-0 flex-1 grid-cols-3 rounded-lg bg-muted p-0.5"
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
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={handleNewChat}
              aria-label="New maps chat"
              title="New maps chat"
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="absolute top-3 right-3 z-20 flex size-10 items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-colors hover:bg-muted"
          >
            <PanelRightClose className="size-4" />
          </button>
          <div className="mt-3 min-w-0 px-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              {activeConversation?.title ?? activeMapTitle}
            </div>
            {activeConversation && (
              <div className="truncate text-[11px] text-muted-foreground">
                {activeMapTitle}
              </div>
            )}
          </div>
        </header>

        <div
          ref={scrollRef}
          className="chat-scroll-container min-h-0 flex-1 overflow-y-auto"
          style={{
            WebkitOverflowScrolling: "touch",
            overscrollBehaviorY: "contain",
          }}
        >
          <div
            className="mx-auto flex min-h-full w-full max-w-[700px] flex-col px-4 pt-6"
            style={{
              paddingBottom: keyboardInset > 0 ? 150 : 134,
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
