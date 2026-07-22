"use client"

import * as React from "react"
import { Sparkles } from "lucide-react"

import { ChatInput } from "@/components/chat-input"
import { MessageBubble, StreamingBubble } from "@/components/message-bubble"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import { useChatStore } from "@/hooks/use-chat-store"

/**
 * Embedded live chat for the onboarding integrations step. Starts a fresh
 * conversation, auto-sends a friendly opener so the orchestrator runs its
 * BOOT.md welcome, and reports the conversation id up so completion can land
 * the user right back in it. Modeled on MapChatPanel.
 */
export function OnboardingChatPanel({
  opener,
  onConversationId,
}: {
  opener: string
  onConversationId: (id: string) => void
}) {
  const { newChat, sendMessage, loadToolCallDetails, state } = useChatStore()
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const startedRef = React.useRef(false)
  const openerSentRef = React.useRef(false)
  const reportedRef = React.useRef<string | null>(null)

  // Start from a clean conversation.
  React.useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    if (state.activeConversationId) newChat()
  }, [newChat, state.activeConversationId])

  // Once we're on a blank slate, send the opener (creates the boot conversation).
  React.useEffect(() => {
    if (openerSentRef.current || !startedRef.current) return
    if (state.activeConversationId) return
    openerSentRef.current = true
    sendMessage(opener, undefined, undefined, { promptContextSource: "Onboarding" })
  }, [state.activeConversationId, opener, sendMessage])

  // Report the boot conversation id once it exists.
  React.useEffect(() => {
    if (!openerSentRef.current || !state.activeConversationId) return
    if (reportedRef.current === state.activeConversationId) return
    reportedRef.current = state.activeConversationId
    onConversationId(state.activeConversationId)
  }, [state.activeConversationId, onConversationId])

  const activeConversation = React.useMemo(
    () => state.conversations.find((c) => c.id === state.activeConversationId) ?? null,
    [state.activeConversationId, state.conversations],
  )
  const conversationId = activeConversation?.id ?? state.activeConversationId ?? ""
  const handleLoadToolCallDetails = React.useCallback(
    (messageId: string, toolCallId: string) => {
      if (!conversationId) return Promise.reject(new Error("No onboarding conversation"))
      return loadToolCallDetails(conversationId, messageId, toolCallId)
    },
    [conversationId, loadToolCallDetails]
  )
  const isStreamingThis = Boolean(
    state.isStreaming && conversationId && state.streamingConversationId === conversationId,
  )
  const latestAssistantMessageId = React.useMemo(() => {
    const messages = activeConversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id
    }
    return null
  }, [activeConversation?.messages])

  // Keep the latest message in view as the agent streams.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [activeConversation?.messages.length, state.streamingContent, state.streamingReasoning.length])

  return (
    <ConversationArtifactsProvider conversationId={conversationId}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-foreground/5 text-foreground">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-semibold text-foreground">Your assistant</span>
        </div>

        <div ref={scrollRef} className="transient-scrollbar min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col gap-6 px-4 py-6">
            {activeConversation?.messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                conversationId={conversationId}
                compact
                isLatestAssistantMessage={message.id === latestAssistantMessageId}
                onLoadToolCallDetails={handleLoadToolCallDetails}
              />
            ))}
            {isStreamingThis ? (
              <StreamingBubble
                compact
                reasoning={state.streamingReasoning}
                content={state.streamingContent}
                contentSegments={state.streamingContentSegments}
                streamingMode={state.streamingMode}
                streamingStatus={state.streamingStatus}
                showCursor={
                  state.streamingReasoning.length === 0 && state.streamingContent.length === 0
                }
                messageId={state.streamingMessageId ?? undefined}
                thinkingSeconds={state.thinkingSeconds}
                thinkingDone={state.thinkingDone}
              />
            ) : null}
          </div>
        </div>

        <div className="shrink-0 border-t border-border/60 bg-background px-3 py-2">
          <ChatInput variant="chat" density="compact" draftNamespace="onboarding-chat" placeholder="Message your assistant…" />
        </div>
      </div>
    </ConversationArtifactsProvider>
  )
}
