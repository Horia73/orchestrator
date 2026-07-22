"use client"

import * as React from "react"
import { ArrowUp, AudioLines, Mic, Plus, ShieldCheck, Sparkles, Square } from "lucide-react"
import { useChatStore } from "@/hooks/use-chat-store"
import type { SendMessageOptions } from "@/hooks/use-chat-store"
import { FilePreviewModal } from "@/components/file-preview-modal"
import { useVoiceRecording } from "@/components/voice-recording-overlay"
import { VoiceOverlay } from "@/components/voice/voice-overlay"
import { ChatStatusPopover } from "@/components/chat-status-popover"
import { AttachmentPreview } from "@/components/attachment-preview"
import {
    useFileAttachments,
    uploadErrorMessage,
    uploadedAttachmentFromResponse,
    type AttachedFile,
} from "@/hooks/use-file-attachments"
import { useMessageDraft } from "@/hooks/use-message-draft"
import {
    focusWithoutViewportScroll,
    isMobileKeyboardViewport,
} from "@/hooks/use-keyboard-inset"
import {
    computeMarkdownListContinuation,
    computeMarkdownListTabSpacing,
} from "@/lib/markdown-list-continuation"
import { cn } from "@/lib/utils"
import type { Attachment } from "@/lib/types"
import { detectSecretCandidates } from "@/lib/secrets/detection"

const CHAT_INPUT_FOCUS_EVENT = "chat-input-focus"

type ChatFallbackStatus = {
    index: number
    provider: {
        id: string
        name: string
    }
    model: {
        id: string
        name: string
    }
    available: boolean
}

type ChatStatusResponse = {
    chat?: {
        fallbacks?: ChatFallbackStatus[]
    }
}

function voiceRecordingExtension(mimeType: string): string {
    const baseMime = mimeType.split(";")[0].trim().toLowerCase()
    if (baseMime === "audio/wav" || baseMime === "audio/wave") return "wav"
    if (baseMime === "audio/ogg") return "ogg"
    if (baseMime === "audio/mp4" || baseMime === "audio/m4a") return "m4a"
    if (baseMime === "audio/aac") return "aac"
    if (baseMime === "audio/mpeg" || baseMime === "audio/mp3") return "mp3"
    return "webm"
}

interface ChatInputProps {
    variant?: "home" | "chat"
    density?: "default" | "compact"
    draftNamespace?: string
    placeholder?: string
    buildSendOptions?: (content: string) => SendMessageOptions | undefined
    onSend?: (
        content: string,
        files?: File[],
        uploadedAttachments?: Attachment[],
        options?: SendMessageOptions
    ) => void
}

export function ChatInput({
    variant = "home",
    density = "default",
    draftNamespace = "chat",
    placeholder,
    buildSendOptions,
    onSend,
}: ChatInputProps) {
    const {
        sendMessage,
        stopStreaming,
        state: { activeConversationId, conversations, isStreaming, streamingConversationId },
    } = useChatStore()

    const textareaRef = React.useRef<HTMLTextAreaElement>(null)
    // Caret position to restore after a programmatic value change (list
    // continuation). Applied in a layout effect once the new value is rendered.
    const pendingSelectionRef = React.useRef<number | null>(null)
    const pendingInputScrollRef = React.useRef(false)
    const [previewAttachment, setPreviewAttachment] = React.useState<Attachment | null>(null)
    const [previewDraftAttachmentId, setPreviewDraftAttachmentId] = React.useState<string | null>(null)
    const [isRecording, setIsRecording] = React.useState(false)
    const [creativeMode, setCreativeMode] = React.useState(false)
    const [fallbackOne, setFallbackOne] = React.useState<ChatFallbackStatus | null>(null)

    const draft = useMessageDraft({ namespace: draftNamespace, threadId: activeConversationId })
    const {
        fileInputRef,
        isDragging,
        replaceAttachmentFile,
        removeAttachment,
        markRendered,
        handleDragEnter,
        handleDragLeave,
        handleDrop,
        handlePaste,
        handlePlusClick,
        handleFileChange,
    } = useFileAttachments(draft.setAttachments)

    const [voiceModeOpen, setVoiceModeOpen] = React.useState(false)
    const canUseCreative = Boolean(fallbackOne?.available)
    const buildResolvedSendOptions = React.useCallback((content: string): SendMessageOptions | undefined => {
        const base = buildSendOptions?.(content)
        if (!creativeMode || !canUseCreative) return base
        return {
            ...(base ?? {}),
            preferredFallbackIndex: 1,
        }
    }, [buildSendOptions, canUseCreative, creativeMode])

    const voice = useVoiceRecording({
        isChat: variant === "chat",
        onSend: React.useCallback(async (blob: Blob, mimeType: string) => {
            const extension = voiceRecordingExtension(mimeType)
            const file = new File([blob], `voice-message.${extension}`, { type: mimeType })
            const formData = new FormData()
            formData.append("files", file)
            formData.append("attachmentSource", "voice_recording")
            try {
                const res = await fetch("/api/upload", { method: "POST", body: formData })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(uploadErrorMessage(data, `Upload failed (${res.status})`))
                const uploaded = uploadedAttachmentFromResponse(data)
                if (uploaded) {
                    const text = draft.value.trim()
                    const options = buildResolvedSendOptions(text)
                    if (onSend) onSend(text, undefined, [uploaded], options)
                    else sendMessage(text, undefined, [uploaded], options)
                    if (text) draft.setValue("")
                }
            } catch { /* upload failed silently */ }
        }, [buildResolvedSendOptions, draft, onSend, sendMessage]),
        onDismiss: React.useCallback(() => {
            setIsRecording(false)
            textareaRef.current?.focus()
        }, []),
    })

    const isChat = variant === "chat"
    const activeConversation = React.useMemo(
        () => conversations.find(conversation => conversation.id === activeConversationId) ?? null,
        [activeConversationId, conversations]
    )
    const hasContent = draft.value.trim().length > 0 || draft.attachments.length > 0
    const detectedSecrets = React.useMemo(
        () => detectSecretCandidates(draft.value),
        [draft.value]
    )
    const hasPendingAttachments = draft.attachments.some(a => a.uploading || a.rendering)
    const hasFailedAttachments = draft.attachments.some(a => a.error && !a.uploaded)
    const isStreamingActiveConversation = Boolean(
        isStreaming && activeConversationId && streamingConversationId === activeConversationId
    )
    // Steering: sending while this conversation streams stays available. The
    // server injects it live when supported or queues it as the next turn.
    const canSend = hasContent && !hasPendingAttachments && !hasFailedAttachments
    const isCompact = isChat && density === "compact"
    const maxHeight = isCompact ? 92 : isChat ? 160 : 200

    // Creative is a transient composer toggle: it defaults off, never persists
    // across reloads, and resets whenever the user moves to a different
    // conversation — so an old "on" state can't silently linger for a whole
    // session until it's noticed and turned off by hand.
    const previousConversationIdRef = React.useRef(activeConversationId)
    React.useEffect(() => {
        if (previousConversationIdRef.current === activeConversationId) return
        previousConversationIdRef.current = activeConversationId
        setCreativeMode(false)
    }, [activeConversationId])

    React.useEffect(() => {
        if (!canUseCreative && creativeMode) setCreativeMode(false)
    }, [canUseCreative, creativeMode])

    React.useEffect(() => {
        let cancelled = false
        const loadFallback = async () => {
            try {
                const res = await fetch("/api/chat/status", { cache: "no-store" })
                if (!res.ok) throw new Error(`status ${res.status}`)
                const data = (await res.json()) as ChatStatusResponse
                if (cancelled) return
                setFallbackOne(data.chat?.fallbacks?.find((fallback) => fallback.index === 1) ?? null)
            } catch {
                if (!cancelled) setFallbackOne(null)
            }
        }
        void loadFallback()
        const handleRefresh = () => void loadFallback()
        const handleVisibility = () => {
            if (document.visibilityState === "visible") void loadFallback()
        }
        window.addEventListener("focus", handleRefresh)
        window.addEventListener("orchestrator:config-updated", handleRefresh)
        document.addEventListener("visibilitychange", handleVisibility)
        return () => {
            cancelled = true
            window.removeEventListener("focus", handleRefresh)
            window.removeEventListener("orchestrator:config-updated", handleRefresh)
            document.removeEventListener("visibilitychange", handleVisibility)
        }
    }, [])

    React.useEffect(() => {
        return draft.restore(textareaRef)
    }, [activeConversationId]) // eslint-disable-line react-hooks/exhaustive-deps

    React.useEffect(() => {
        const handleFocusRequest = () => focusWithoutViewportScroll(textareaRef.current)
        window.addEventListener(CHAT_INPUT_FOCUS_EVENT, handleFocusRequest)
        return () => window.removeEventListener(CHAT_INPUT_FOCUS_EVENT, handleFocusRequest)
    }, [])

    React.useEffect(() => {
        const textarea = textareaRef.current
        if (!textarea) return

        const handleTouchStart = (event: TouchEvent) => {
            if (document.activeElement === textarea) return
            if (!isMobileKeyboardViewport()) return

            if (event.cancelable) event.preventDefault()
            focusWithoutViewportScroll(textarea)
        }

        textarea.addEventListener("touchstart", handleTouchStart, {
            passive: false,
        })
        return () => textarea.removeEventListener("touchstart", handleTouchStart)
    }, [])

    const resizeTextarea = React.useCallback(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        const shouldStickToEnd =
            document.activeElement === textarea &&
            textarea.selectionStart === textarea.value.length &&
            textarea.selectionEnd === textarea.value.length
        textarea.style.height = "0px"
        textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
        if (shouldStickToEnd && textarea.scrollHeight > maxHeight) {
            textarea.scrollTop = textarea.scrollHeight
        }
    }, [maxHeight])

    // After a list-continuation edit re-renders the textarea, move the caret to
    // the position computed alongside the new value.
    React.useLayoutEffect(() => {
        resizeTextarea()
        const caret = pendingSelectionRef.current
        if (caret == null) return
        pendingSelectionRef.current = null
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.setSelectionRange(caret, caret)
        if (pendingInputScrollRef.current && caret >= textarea.value.length) {
            pendingInputScrollRef.current = false
            textarea.scrollTop = textarea.scrollHeight
            window.requestAnimationFrame(() => {
                if (textareaRef.current === textarea) {
                    textarea.scrollTop = textarea.scrollHeight
                }
            })
        } else {
            pendingInputScrollRef.current = false
        }
    }, [draft.value, resizeTextarea])

    const handleSubmit = React.useCallback(() => {
        const trimmed = draft.value.trim()
        if ((!trimmed && draft.attachments.length === 0) || hasPendingAttachments || hasFailedAttachments) return
        const isMobileComposer = isMobileKeyboardViewport()
        const keepMobileComposerFocused =
            isMobileComposer &&
            document.activeElement === textareaRef.current
        const uploadedAttachments = draft.attachments.filter(a => a.uploaded).map(a => a.uploaded!)
        const options = buildResolvedSendOptions(trimmed)
        if (onSend) {
            onSend(
                trimmed,
                undefined,
                uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
                options
            )
        } else {
            sendMessage(
                trimmed,
                undefined,
                uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
                options
            )
        }
        draft.clear()
        if (keepMobileComposerFocused) {
            // Keep the visual viewport stable while the newly-sent row glides
            // into its top anchor. Closing the iOS keyboard in the same frame
            // made native smooth scrolling restart against a changing viewport,
            // which painted as a flash followed by several small jumps.
            window.requestAnimationFrame(() =>
                focusWithoutViewportScroll(textareaRef.current)
            )
        } else if (!isMobileComposer) {
            focusWithoutViewportScroll(textareaRef.current)
        }
    }, [buildResolvedSendOptions, draft, hasFailedAttachments, hasPendingAttachments, onSend, sendMessage])

    const preserveMobileComposerFocus = React.useCallback(
        (event: React.PointerEvent<HTMLButtonElement>) => {
            if (!isMobileKeyboardViewport()) return
            if (document.activeElement !== textareaRef.current) return
            // A send-button tap should not transfer focus away from the
            // textarea before onClick runs; retaining focus keeps the iOS
            // keyboard and visual viewport steady through the send morph.
            event.preventDefault()
        },
        []
    )

    const handleTextChange = React.useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>) => {
            const textarea = event.currentTarget
            const spacing = computeMarkdownListTabSpacing(textarea.value, textarea.selectionStart)
            if (spacing) {
                pendingSelectionRef.current = spacing.nextCaret
                draft.setValue(spacing.nextValue)
                return
            }
            draft.setValue(textarea.value)
        },
        [draft]
    )

    const handleKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== "Enter") return

            const textarea = event.currentTarget
            const isMobileEnter = isMobileKeyboardViewport()
            if (textarea.selectionStart === textarea.selectionEnd) {
                const continuation = computeMarkdownListContinuation(textarea.value, textarea.selectionStart)
                if (continuation) {
                    event.preventDefault()
                    pendingSelectionRef.current = continuation.nextCaret
                    pendingInputScrollRef.current = true
                    draft.setValue(continuation.nextValue)
                    return
                }
            }

            if (event.shiftKey) {
                return
            }
            if (isMobileEnter) {
                return
            }

            event.preventDefault()
            handleSubmit()
        },
        [draft, handleSubmit]
    )

    const handleMicClick = React.useCallback(() => {
        if (isStreamingActiveConversation) return
        setIsRecording(true)
        voice.start()
    }, [isStreamingActiveConversation, voice])
    const handlePreviewClick = React.useCallback((att: AttachedFile) => {
        if (!att.uploaded) return
        setPreviewDraftAttachmentId(att.id)
        setPreviewAttachment(att.uploaded)
    }, [])
    const closePreview = React.useCallback(() => {
        setPreviewAttachment(null)
        setPreviewDraftAttachmentId(null)
    }, [])
    const handlePreviewSaveImage = React.useCallback(async (_attachment: Attachment, file: File) => {
        if (!previewDraftAttachmentId) throw new Error("Attachment is no longer available.")
        await replaceAttachmentFile(previewDraftAttachmentId, file)
        closePreview()
        window.requestAnimationFrame(() => focusWithoutViewportScroll(textareaRef.current))
    }, [closePreview, previewDraftAttachmentId, replaceAttachmentFile])

    return (
        <>
            <div
                className={cn(
                    "relative w-full border border-transparent bg-white dark:bg-card",
                    "transition-all duration-200 ease-out",
                    isCompact
                        ? "max-w-full rounded-xl shadow-[0_0_0_0.5px_rgba(93,72,57,0.36)] focus-within:shadow-[0_0_0_0.5px_rgba(93,72,57,0.48)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.2)] dark:focus-within:shadow-[0_0_0_0.5px_rgba(255,255,255,0.28)]"
                        : isChat
                        ? "max-w-full rounded-2xl shadow-[0_0_0_0.5px_rgba(93,72,57,0.42)] focus-within:shadow-[0_0_0_0.5px_rgba(93,72,57,0.52)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.22)] dark:focus-within:shadow-[0_0_0_0.5px_rgba(255,255,255,0.3)]"
                        : "max-w-[672px] rounded-[20px] shadow-[0_0_0_0.5px_rgba(93,72,57,0.3),0_10px_22px_rgba(44,30,18,0.06)] focus-within:shadow-[0_0_0_0.5px_rgba(93,72,57,0.38),0_12px_26px_rgba(44,30,18,0.08)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.2),0_10px_22px_rgba(0,0,0,0.24)] dark:focus-within:shadow-[0_0_0_0.5px_rgba(255,255,255,0.26),0_12px_26px_rgba(0,0,0,0.28)]",
                    isDragging && "ring-2 ring-primary/30"
                )}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileChange}
                />

                <div
                    className={cn(
                        "grid transition-all duration-200 ease-out",
                        draft.attachments.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    )}
                >
                    <div className="overflow-hidden min-h-0">
                        <div className="pt-3 px-4 pb-1 flex gap-2.5 flex-wrap">
                            {draft.attachments.map((attachment) => (
                                <AttachmentPreview
                                    key={attachment.id}
                                    attachment={attachment}
                                    onRemove={() => removeAttachment(attachment.id)}
                                    onClick={() => handlePreviewClick(attachment)}
                                    onRendered={() => markRendered(attachment.id)}
                                />
                            ))}
                        </div>
                    </div>
                </div>

                <div className="grid">
                    <textarea
                        ref={textareaRef}
                        value={draft.value}
                        onChange={handleTextChange}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        enterKeyHint="enter"
                        placeholder={
                            placeholder ??
                            (isStreamingActiveConversation
                                ? "Write a follow-up..."
                                : isChat
                                    ? "Reply..."
                                    : "How can I help you today?")
                        }
                        rows={isChat ? 1 : 2}
                        style={{
                            gridArea: "1 / 1",
                            opacity: isRecording ? 0 : 1,
                            pointerEvents: isRecording ? "none" : "auto",
                        }}
                        className={cn(
                            "w-full resize-none bg-transparent px-5 outline-none",
                            // List-continuation inserts a real tab (\t) after the
                            // marker (see markdown-list-continuation). In a
                            // proportional font tab-size:2 lands the first stop
                            // right after "1." (≈3px gap — looks glued) and gives
                            // different gaps per marker width, so items don't
                            // align. tab-size:8 plus the two-space marker indent
                            // gives ordered lists a Word-like hanging paragraph gap.
                            "[tab-size:8]",
                            "[font-family:var(--font-display)] tracking-[-0.02em]",
                            "text-[16px]",
                            "placeholder:font-medium placeholder:text-foreground/65",
                            isCompact
                                ? "max-h-[92px] min-h-[38px] px-4 pt-2.5 pb-1.5"
                                : isChat
                                ? "max-h-[160px] min-h-[46px] pt-3.5 pb-2"
                                : "max-h-[200px] min-h-[66px] pt-[19px]"
                        )}
                    />
                    {isRecording && voice.overlay}
                </div>

                {detectedSecrets.length > 0 && !isRecording && (
                    <div
                        className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-emerald-700/15 bg-emerald-700/7 px-2.5 py-2 text-xs text-emerald-950 dark:border-emerald-300/15 dark:bg-emerald-300/8 dark:text-emerald-100"
                        role="status"
                    >
                        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0">
                            {detectedSecrets.length === 1 ? "Secret detected" : `${detectedSecrets.length} secrets detected`}
                            {": will be saved and masked in chat as "}
                            <span className="font-mono font-medium">
                                {detectedSecrets.slice(0, 3).map((item) => item.suggestedKey).join(", ")}
                                {detectedSecrets.length > 3 ? "…" : ""}
                            </span>
                        </span>
                    </div>
                )}

                <div
                    className={cn(
                        "flex items-center justify-between",
                        isCompact ? "px-2.5 pb-2" : "px-3 pb-3"
                    )}
                >
                    {isRecording ? voice.leftButton : (
                        <button
                            type="button"
                            onClick={handlePlusClick}
                            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground pointer-coarse:size-10"
                            aria-label="Attach file"
                        >
                            <Plus className="size-5.5 stroke-[1]" />
                        </button>
                    )}

                    <div className="flex items-center gap-2">
                        {isRecording ? voice.rightButtons : (
                            <>
                                <ChatStatusPopover
                                    messages={activeConversation?.messages ?? []}
                                    draftValue={draft.value}
                                    attachments={draft.attachments}
                                    contextUsage={activeConversation?.contextUsage}
                                    conversationId={activeConversationId}
                                    side={isChat ? "top" : "bottom"}
                                />
                                {fallbackOne && (
                                    <button
                                        type="button"
                                        onClick={() => setCreativeMode((value) => !value)}
                                        disabled={!canUseCreative || isStreamingActiveConversation}
                                        title={
                                            canUseCreative
                                                ? `Use fallback 1: ${fallbackOne.provider.name} ${fallbackOne.model.name}`
                                                : "Fallback 1 is not available"
                                        }
                                        className={cn(
                                            "flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ring-1 ring-inset transition-colors pointer-coarse:h-10",
                                            creativeMode && canUseCreative
                                                ? "bg-[#b76440]/12 text-[#8b4a32] ring-[#b76440]/30 hover:bg-[#b76440]/18 dark:bg-[#d78a66]/15 dark:text-[#d78a66] dark:ring-[#d78a66]/30 dark:hover:bg-[#d78a66]/22"
                                                : "text-muted-foreground ring-transparent hover:bg-muted/50 hover:text-foreground",
                                            (!canUseCreative || isStreamingActiveConversation) && "cursor-not-allowed opacity-50"
                                        )}
                                        aria-pressed={creativeMode && canUseCreative}
                                        aria-label="Creative"
                                    >
                                        <Sparkles className={cn("size-4 stroke-[1.6]", creativeMode && canUseCreative && "fill-current")} />
                                        <span>Creative</span>
                                    </button>
                                )}
                                {!isStreamingActiveConversation && !hasContent && (
                                    <button
                                        type="button"
                                        onClick={() => setVoiceModeOpen(true)}
                                        className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground pointer-coarse:size-10"
                                        aria-label="Live voice chat"
                                    >
                                        <AudioLines className="size-5.5 stroke-[1.2]" />
                                    </button>
                                )}
                                {isStreamingActiveConversation && hasContent && (
                                    <button
                                        type="button"
                                        onPointerDown={preserveMobileComposerFocus}
                                        onClick={handleSubmit}
                                        disabled={!canSend}
                                        className={cn(
                                            "flex size-8 items-center justify-center rounded-[11px] bg-[#b76440] text-white transition-colors hover:bg-[#a55837] pointer-coarse:size-10",
                                            !canSend && "cursor-not-allowed opacity-50 hover:bg-[#b76440]"
                                        )}
                                        aria-label="Send follow-up"
                                    >
                                        <ArrowUp className="size-[17px] stroke-[2.5]" />
                                    </button>
                                )}
                                <div className="flex size-9 shrink-0 items-center justify-center pointer-coarse:size-10">
                                    {isStreamingActiveConversation ? (
                                        <button
                                            type="button"
                                            onClick={() => stopStreaming()}
                                            className="flex size-8 items-center justify-center rounded-[11px] bg-[#b76440] text-white transition-colors hover:bg-[#a55837] pointer-coarse:size-10"
                                            aria-label="Stop"
                                        >
                                            <Square className="size-[14px] fill-current" />
                                        </button>
                                    ) : hasContent ? (
                                        <button
                                            type="button"
                                            onPointerDown={preserveMobileComposerFocus}
                                            onClick={handleSubmit}
                                            disabled={!canSend}
                                            className={cn(
                                                "flex size-8 items-center justify-center rounded-[11px] bg-[#b76440] text-white transition-colors hover:bg-[#a55837] pointer-coarse:size-10",
                                                !canSend && "cursor-not-allowed opacity-50 hover:bg-[#b76440]"
                                            )}
                                            aria-label={
                                                hasPendingAttachments
                                                    ? "Waiting for attachments"
                                                    : hasFailedAttachments
                                                        ? "Remove failed attachments"
                                                        : "Send"
                                            }
                                        >
                                            <ArrowUp className="size-[17px] stroke-[2.5]" />
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={handleMicClick}
                                            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground pointer-coarse:size-10"
                                            aria-label="Voice"
                                        >
                                            <Mic className="size-5.5 stroke-[1.2]" />
                                        </button>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            <FilePreviewModal
                attachment={previewAttachment}
                onSaveImage={previewDraftAttachmentId ? handlePreviewSaveImage : undefined}
                onClose={closePreview}
            />
            <VoiceOverlay open={voiceModeOpen} onClose={() => setVoiceModeOpen(false)} />
        </>
    )
}
