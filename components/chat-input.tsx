"use client"

import * as React from "react"
import { ArrowUp, Mic, Plus, Square } from "lucide-react"
import { useChatStore } from "@/hooks/use-chat-store"
import type { SendMessageOptions } from "@/hooks/use-chat-store"
import { FilePreviewModal } from "@/components/file-preview-modal"
import { useVoiceRecording } from "@/components/voice-recording-overlay"
import { ChatStatusPopover } from "@/components/chat-status-popover"
import { AttachmentPreview } from "@/components/attachment-preview"
import {
    useFileAttachments,
    uploadErrorMessage,
    uploadedAttachmentFromResponse,
    type AttachedFile,
} from "@/hooks/use-file-attachments"
import { useMessageDraft } from "@/hooks/use-message-draft"
import { isMobileKeyboardViewport } from "@/hooks/use-keyboard-inset"
import { cn } from "@/lib/utils"
import type { Attachment } from "@/lib/types"

const CHAT_INPUT_FOCUS_EVENT = "chat-input-focus"

function voiceRecordingExtension(mimeType: string): string {
    const baseMime = mimeType.split(";")[0].trim().toLowerCase()
    if (baseMime === "audio/wav" || baseMime === "audio/wave") return "wav"
    if (baseMime === "audio/ogg") return "ogg"
    if (baseMime === "audio/mp4" || baseMime === "audio/m4a") return "m4a"
    if (baseMime === "audio/aac") return "aac"
    if (baseMime === "audio/mpeg" || baseMime === "audio/mp3") return "mp3"
    return "webm"
}

function focusWithoutViewportScroll(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return

    const scrollX = window.scrollX
    const scrollY = window.scrollY

    try {
        textarea.focus({ preventScroll: true })
    } catch {
        textarea.focus()
    }

    window.requestAnimationFrame(() => {
        if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
            window.scrollTo(scrollX, scrollY)
        }
    })
}

// Matches a markdown list item: optional indent, then a bullet (-, *, +), an
// ordered marker (1. / 1)), or a single-letter marker (A. / a)), at least one
// space, then the rest of the line. Letters are limited to one character so a
// sentence like "Note. ..." isn't mistaken for a list.
const LIST_ITEM_RE = /^(\s*)(?:([-*+])|(\d+)([.)])|([A-Za-z])([.)]))(\s+)(.*)$/

interface ListContinuation {
    nextValue: string
    nextCaret: number
}

// Next letter in the same case, capped at z/Z so it never overflows past the
// alphabet (a 27th item just repeats the last letter).
function nextLetter(letter: string): string {
    if (letter === "z" || letter === "Z") return letter
    return String.fromCharCode(letter.charCodeAt(0) + 1)
}

// Given the textarea value and caret position, returns how to continue a
// markdown list on the next line, or null when the caret's line isn't a list
// item. Non-empty item → inserts "\n" + the next marker (numbers and letters
// auto-increment). Empty item → drops the marker so the list ends, like Word.
function computeListContinuation(value: string, caret: number): ListContinuation | null {
    const lineStart = value.lastIndexOf("\n", caret - 1) + 1
    let lineEnd = value.indexOf("\n", caret)
    if (lineEnd === -1) lineEnd = value.length

    const match = LIST_ITEM_RE.exec(value.slice(lineStart, lineEnd))
    if (!match) return null

    const [, indent, bullet, num, numSep, letter, letterSep, spaces, content] = match
    const marker = bullet ?? (num ? `${num}${numSep}` : `${letter}${letterSep}`)

    if (content.trim().length === 0) {
        // Empty list item → exit the list by removing the marker entirely.
        const markerLength = indent.length + marker.length + spaces.length
        return {
            nextValue: value.slice(0, lineStart) + value.slice(lineStart + markerLength),
            nextCaret: lineStart,
        }
    }

    const nextMarker = bullet
        ? bullet
        : num
            ? `${Number(num) + 1}${numSep}`
            : `${nextLetter(letter)}${letterSep}`
    const insertion = `\n${indent}${nextMarker}${spaces}`
    return {
        nextValue: value.slice(0, caret) + insertion + value.slice(caret),
        nextCaret: caret + insertion.length,
    }
}

interface ChatInputProps {
    variant?: "home" | "chat"
    placeholder?: string
    buildSendOptions?: (content: string) => SendMessageOptions | undefined
    onSend?: (
        content: string,
        files?: File[],
        uploadedAttachments?: Attachment[],
        options?: SendMessageOptions
    ) => void
}

export function ChatInput({ variant = "home", placeholder, buildSendOptions, onSend }: ChatInputProps) {
    const {
        sendMessage,
        stopStreaming,
        state: { activeConversationId, conversations, isStreaming, streamingConversationId },
    } = useChatStore()

    const textareaRef = React.useRef<HTMLTextAreaElement>(null)
    // Caret position to restore after a programmatic value change (list
    // continuation). Applied in a layout effect once the new value is rendered.
    const pendingSelectionRef = React.useRef<number | null>(null)
    const [previewAttachment, setPreviewAttachment] = React.useState<Attachment | null>(null)
    const [isRecording, setIsRecording] = React.useState(false)

    const draft = useMessageDraft({ namespace: "chat", threadId: activeConversationId })
    const {
        fileInputRef,
        isDragging,
        removeAttachment,
        markRendered,
        handleDragEnter,
        handleDragLeave,
        handleDrop,
        handlePaste,
        handlePlusClick,
        handleFileChange,
    } = useFileAttachments(draft.setAttachments)

    const voice = useVoiceRecording({
        isChat: variant === "chat",
        onSend: React.useCallback(async (blob: Blob, mimeType: string) => {
            const extension = voiceRecordingExtension(mimeType)
            const file = new File([blob], `voice-message.${extension}`, { type: mimeType })
            const formData = new FormData()
            formData.append("files", file)
            try {
                const res = await fetch("/api/upload", { method: "POST", body: formData })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(uploadErrorMessage(data, `Upload failed (${res.status})`))
                const uploaded = uploadedAttachmentFromResponse(data)
                if (uploaded) {
                    const options = buildSendOptions?.("")
                    if (onSend) onSend("", undefined, [uploaded], options)
                    else sendMessage("", undefined, [uploaded], options)
                }
            } catch { /* upload failed silently */ }
        }, [buildSendOptions, onSend, sendMessage]),
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
    const hasPendingAttachments = draft.attachments.some(a => a.uploading || a.rendering)
    const hasFailedAttachments = draft.attachments.some(a => a.error && !a.uploaded)
    const isStreamingActiveConversation = Boolean(
        isStreaming && activeConversationId && streamingConversationId === activeConversationId
    )
    const canSend = hasContent && !hasPendingAttachments && !hasFailedAttachments && !isStreamingActiveConversation
    const maxHeight = isChat ? 160 : 200

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
        textarea.style.height = "0px"
        textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    }, [maxHeight])

    React.useEffect(() => { resizeTextarea() }, [draft.value, resizeTextarea])

    // After a list-continuation edit re-renders the textarea, move the caret to
    // the position computed alongside the new value.
    React.useLayoutEffect(() => {
        const caret = pendingSelectionRef.current
        if (caret == null) return
        pendingSelectionRef.current = null
        textareaRef.current?.setSelectionRange(caret, caret)
    }, [draft.value])

    const handleSubmit = React.useCallback(() => {
        const trimmed = draft.value.trim()
        if ((!trimmed && draft.attachments.length === 0) || hasPendingAttachments || hasFailedAttachments || isStreamingActiveConversation) return
        const uploadedAttachments = draft.attachments.filter(a => a.uploaded).map(a => a.uploaded!)
        const options = buildSendOptions?.(trimmed)
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
        if (isMobileKeyboardViewport()) {
            textareaRef.current?.blur()
        } else {
            focusWithoutViewportScroll(textareaRef.current)
        }
    }, [buildSendOptions, draft, hasFailedAttachments, hasPendingAttachments, isStreamingActiveConversation, onSend, sendMessage])

    const handleKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== "Enter") return
            if (event.shiftKey) {
                // Shift+Enter inserts a newline. When the caret sits on a
                // markdown list item, continue the list automatically; otherwise
                // fall through to the browser's default newline.
                const textarea = event.currentTarget
                if (textarea.selectionStart !== textarea.selectionEnd) return
                const continuation = computeListContinuation(textarea.value, textarea.selectionStart)
                if (!continuation) return
                event.preventDefault()
                pendingSelectionRef.current = continuation.nextCaret
                draft.setValue(continuation.nextValue)
                return
            }
            if (isMobileKeyboardViewport()) return
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
        if (att.uploaded) setPreviewAttachment(att.uploaded)
    }, [])

    return (
        <>
            <div
                className={cn(
                    "relative w-full border border-transparent bg-white dark:bg-card",
                    "transition-all duration-200 ease-out",
                    isChat
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
                        onChange={(e) => draft.setValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        enterKeyHint="enter"
                        placeholder={placeholder ?? (isChat ? "Reply..." : "How can I help you today?")}
                        rows={isChat ? 1 : 2}
                        style={{
                            gridArea: "1 / 1",
                            opacity: isRecording ? 0 : 1,
                            pointerEvents: isRecording ? "none" : "auto",
                        }}
                        className={cn(
                            "w-full resize-none bg-transparent px-5 outline-none",
                            "[font-family:var(--font-display)] tracking-[-0.02em]",
                            "text-[16px]",
                            "placeholder:font-medium placeholder:text-foreground/65",
                            isChat
                                ? "max-h-[160px] min-h-[46px] pt-3.5 pb-2"
                                : "max-h-[200px] min-h-[66px] pt-[19px]"
                        )}
                    />
                    {isRecording && voice.overlay}
                </div>

                <div className="flex items-center justify-between px-3 pb-3">
                    {isRecording ? voice.leftButton : (
                        <button
                            type="button"
                            onClick={handlePlusClick}
                            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
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
                                    side={isChat ? "top" : "bottom"}
                                />
                                <div className="flex size-9 shrink-0 items-center justify-center">
                                    {isStreamingActiveConversation ? (
                                        <button
                                            type="button"
                                            onClick={() => stopStreaming()}
                                            className="flex size-8 items-center justify-center rounded-[11px] bg-[#b76440] text-white transition-colors hover:bg-[#a55837]"
                                            aria-label="Stop"
                                        >
                                            <Square className="size-[14px] fill-current" />
                                        </button>
                                    ) : hasContent ? (
                                        <button
                                            type="button"
                                            onClick={handleSubmit}
                                            disabled={!canSend}
                                            className={cn(
                                                "flex size-8 items-center justify-center rounded-[11px] bg-[#b76440] text-white transition-colors hover:bg-[#a55837]",
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
                                            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
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
                onClose={() => setPreviewAttachment(null)}
            />
        </>
    )
}
