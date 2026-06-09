"use client"

import * as React from "react"
import { Dumbbell, X } from "lucide-react"

import { ChatInput } from "@/components/chat-input"
import { MessageBubble, StreamingBubble } from "@/components/message-bubble"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import { useChatStore } from "@/hooks/use-chat-store"
import type { SendMessageOptions } from "@/hooks/use-chat-store"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"
import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { cn } from "@/lib/utils"

const SUPPRESS: string[] = ["application/vnd.ant.workout"]

const QUICK_PROMPTS = [
  "Schimbă un exercițiu",
  "Fă-l mai greu",
  "Adaugă un finisher",
  "Verifică-mi forma (atașează o poză)",
]

interface WorkoutChatPanelProps {
  open: boolean
  mobile: boolean
  docked?: boolean
  activeWorkoutTitle: string
  preferredConversationId?: string | null
  buildPromptContext: () => string
  onCollapse: () => void
  onWorkoutArtifact?: (artifact: ArtifactRow) => void
}

/**
 * In-surface workout chat — the lateral assistant on the workout surface.
 * Reuses the main chat engine (`useChatStore`, `ChatInput`, `MessageBubble`)
 * exactly like the maps chat panel does, bound to the workout artifact's
 * conversation, with the workout capability activated and a live prompt
 * context. The workout artifact is suppressed in the bubbles since the live
 * card is the main surface.
 */
export function WorkoutChatPanel({
  open,
  mobile,
  docked = false,
  activeWorkoutTitle,
  preferredConversationId,
  buildPromptContext,
  onCollapse,
  onWorkoutArtifact,
}: WorkoutChatPanelProps) {
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
  const conversationId = activeConversation?.id ?? state.activeConversationId ?? ""
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

  const buildSendOptions = React.useCallback(
    (): SendMessageOptions => ({
      promptContext: buildPromptContext(),
      activateIntegrations: ["workout"],
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
      if (artifact.type === "application/vnd.ant.workout") onWorkoutArtifact?.(artifact)
    },
    [onWorkoutArtifact]
  )

  if (!open) return null

  return (
    <ConversationArtifactsProvider conversationId={conversationId}>
      <section
        aria-label="Workout chat"
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
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Dumbbell className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-foreground">
                {activeConversation?.title ?? "Workout coach"}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {activeWorkoutTitle}
              </div>
            </div>
            <button
              type="button"
              onClick={onCollapse}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Close workout coach"
              title="Close workout coach"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="transient-scrollbar min-h-0 flex-1 overflow-y-auto"
          style={{ WebkitOverflowScrolling: "touch", overscrollBehaviorY: "contain" }}
        >
          <div
            className="mx-auto flex min-h-full w-full max-w-[700px] flex-col px-4 pt-6"
            style={{ paddingBottom: keyboardInset > 0 ? 150 : 134 }}
          >
            {activeConversation ? (
              <div className="space-y-6">
                {activeConversation.messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    compact
                    suppressArtifactTypes={SUPPRESS}
                    isLatestAssistantMessage={message.id === latestAssistantMessageId}
                    onArtifactExpand={handleArtifactExpand}
                  />
                ))}
                {isStreamingThisConversation && (
                  <StreamingBubble
                    compact
                    suppressArtifactTypes={SUPPRESS}
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
                <div className="w-full max-w-[300px] text-center">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
                    <Dumbbell className="size-4 text-muted-foreground" />
                  </div>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {QUICK_PROMPTS.map((prompt) => (
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
              keyboardInset > 0 ? `translate3d(0, -${keyboardInset}px, 0)` : undefined,
          }}
        >
          <div className="pointer-events-auto">
            <ChatInput
              variant="chat"
              density="compact"
              draftNamespace="workout-coach"
              placeholder="Cere o modificare, o alternativă, sau atașează o poză…"
              buildSendOptions={buildSendOptions}
            />
          </div>
        </div>
      </section>
    </ConversationArtifactsProvider>
  )
}
