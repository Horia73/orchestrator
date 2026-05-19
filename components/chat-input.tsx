"use client"

import * as React from "react"
import { ArrowUp, Mic, Plus, Square, X, FileText } from "lucide-react"
import { useChatStore } from "@/hooks/use-chat-store"
import { FilePreviewModal } from "@/components/file-preview-modal"
import { PdfThumbnail } from "@/components/pdf-thumbnail"
import { useVoiceRecording } from "@/components/voice-recording-overlay"
import { ChatStatusPopover } from "@/components/chat-status-popover"
import { isMobileKeyboardViewport } from "@/hooks/use-keyboard-inset"
import { cn } from "@/lib/utils"
import type { Attachment } from "@/lib/types"

const CHAT_INPUT_FOCUS_EVENT = "chat-input-focus"

export interface AttachedFile {
    id: string
    file?: File
    previewUrl?: string
    type: "image" | "pdf" | "file"
    uploaded?: Attachment
    uploading?: boolean
    rendering?: boolean
    error?: string
}

function fileType(file: File): AttachedFile["type"] {
    if (file.type.startsWith("image/")) return "image"
    if (file.type === "application/pdf") return "pdf"
    return "file"
}

function isBlobPreviewUrl(url: string | undefined): url is string {
    return typeof url === "string" && url.startsWith("blob:")
}

function revokeAttachmentPreviewUrl(attachment: AttachedFile) {
    if (isBlobPreviewUrl(attachment.previewUrl)) URL.revokeObjectURL(attachment.previewUrl)
}

function revokeAttachmentPreviewUrls(attachments: AttachedFile[]) {
    for (const attachment of attachments) revokeAttachmentPreviewUrl(attachment)
}

function isAttachment(value: unknown): value is Attachment {
    if (!value || typeof value !== "object") return false
    const candidate = value as Record<string, unknown>
    return (
        typeof candidate.id === "string" &&
        typeof candidate.filename === "string" &&
        typeof candidate.mimeType === "string" &&
        typeof candidate.size === "number" &&
        (
            candidate.type === "image" ||
            candidate.type === "pdf" ||
            candidate.type === "document" ||
            candidate.type === "audio" ||
            candidate.type === "video" ||
            candidate.type === "other"
        )
    )
}

function uploadedAttachmentFromResponse(data: unknown): Attachment | null {
    if (!data || typeof data !== "object") return null
    const attachments = (data as { attachments?: unknown }).attachments
    if (!Array.isArray(attachments)) return null
    return isAttachment(attachments[0]) ? attachments[0] : null
}

function uploadErrorMessage(data: unknown, fallback: string) {
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
        return (data as { error: string }).error
    }
    return fallback
}

// ---------------------------------------------------------------------------
// Skeleton card (while uploading or rendering)
// ---------------------------------------------------------------------------

function SkeletonCard({ type }: { type: "image" | "pdf" | "file" }) {
    if (type === "image") {
        return <div className="size-[128px] rounded-lg bg-muted/40 animate-pulse" />
    }
    return (
        <div className="size-[128px] rounded-lg bg-muted/20 animate-pulse flex flex-col p-2.5 gap-1.5">
            <div className="flex-1 rounded bg-muted/40" />
            <div className="h-4 w-10 rounded bg-muted/40" />
        </div>
    )
}

// ---------------------------------------------------------------------------
// File preview card
// ---------------------------------------------------------------------------

function FilePreview({
    attachment,
    onRemove,
    onClick,
    onRendered,
}: {
    attachment: AttachedFile
    onRemove: () => void
    onClick?: () => void
    onRendered?: () => void
}) {
    const [hovered, setHovered] = React.useState(false)
    const fileName = attachment.file?.name ?? attachment.uploaded?.filename ?? "File"
    const serverUrl = attachment.uploaded ? `/api/uploads/${attachment.uploaded.id}` : undefined
    const isLoading = attachment.uploading || attachment.rendering

    if (attachment.uploading) {
        return (
            <div className="relative shrink-0">
                <SkeletonCard type={attachment.type} />
            </div>
        )
    }

    return (
        <div
            className="relative shrink-0 cursor-pointer"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={onClick}
        >
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                className={cn(
                    "absolute -top-1.5 -left-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-background border border-border shadow-sm text-muted-foreground transition-all duration-200 ease-out hover:text-foreground hover:bg-muted",
                    hovered ? "opacity-100 scale-100" : "opacity-0 scale-75"
                )}
                aria-label="Remove file"
            >
                <X className="size-3" strokeWidth={2.5} />
            </button>

            {attachment.type === "image" && (attachment.previewUrl || serverUrl) ? (
                <div className="size-[128px] rounded-lg border border-border/60 overflow-hidden bg-muted/30">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={attachment.previewUrl || serverUrl}
                        alt={fileName}
                        className="size-full object-contain"
                    />
                </div>
            ) : attachment.type === "pdf" ? (
                <div className="relative size-[128px] rounded-lg border border-border/60 bg-white dark:bg-muted/20 overflow-hidden">
                    {isLoading && (
                        <div className="absolute inset-0 z-[5]">
                            <SkeletonCard type="pdf" />
                        </div>
                    )}
                    <div className="w-full h-full overflow-hidden">
                        <PdfThumbnail file={attachment.file} url={serverUrl} onRendered={onRendered} />
                    </div>
                    <div className="absolute bottom-1.5 left-1.5 z-10">
                        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1.5 py-0.5 rounded border border-border/50 bg-white/90 dark:bg-background/90 backdrop-blur-xs">
                            PDF
                        </span>
                    </div>
                </div>
            ) : (
                <div className="flex flex-col items-start justify-between size-[128px] rounded-lg border border-border/60 bg-white dark:bg-muted/20 p-2.5">
                    <FileText className="size-5 text-muted-foreground" />
                    <div className="flex flex-col gap-0.5 min-w-0 w-full">
                        <span className="text-[11px] font-medium truncate w-full leading-tight">
                            {fileName}
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            {fileName.split(".").pop()?.toUpperCase() || "FILE"}
                        </span>
                    </div>
                </div>
            )}
            {attachment.error && (
                <div className="absolute inset-x-1.5 bottom-1.5 rounded-md border border-destructive/30 bg-background/95 px-1.5 py-1 text-[10px] font-medium text-destructive shadow-sm">
                    Upload failed
                </div>
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// useDraftPersistence — saves/restores text + file drafts to localStorage
// ---------------------------------------------------------------------------

function useDraftPersistence(conversationId: string | null) {
    const draftKey = `chat:draft:${conversationId || 'new'}`
    const filesKey = `chat:files:${conversationId || 'new'}`

    const [value, setValue] = React.useState(() => {
        if (typeof window === 'undefined') return ""
        return localStorage.getItem(draftKey) || ""
    })

    const [attachments, setAttachmentsState] = React.useState<AttachedFile[]>([])
    const attachmentsRef = React.useRef<AttachedFile[]>([])
    const restoredRef = React.useRef(false)

    const setAttachments = React.useCallback<React.Dispatch<React.SetStateAction<AttachedFile[]>>>((next) => {
        setAttachmentsState(prev => {
            const resolved = typeof next === "function"
                ? (next as (prevState: AttachedFile[]) => AttachedFile[])(prev)
                : next
            attachmentsRef.current = resolved
            return resolved
        })
    }, [])

    // Persist attachments
    React.useEffect(() => {
        if (!restoredRef.current) return
        const persisted = attachments.filter(a => a.uploaded).map(a => a.uploaded!)
        if (persisted.length > 0) {
            localStorage.setItem(filesKey, JSON.stringify(persisted))
        } else {
            localStorage.removeItem(filesKey)
        }
    }, [attachments, filesKey])

    // Restore on conversation switch
    const restore = React.useCallback((textareaRef: React.RefObject<HTMLTextAreaElement | null>) => {
        restoredRef.current = false

        const frame = window.requestAnimationFrame(() => {
            const el = textareaRef.current
            if (el && !isMobileKeyboardViewport()) {
                el.focus({ preventScroll: true })
                const len = el.value.length
                el.setSelectionRange(len, len)
            }
        })

        const savedDraft = localStorage.getItem(draftKey)
        setValue(savedDraft || "")

        const savedFiles = localStorage.getItem(filesKey)
        if (savedFiles) {
            try {
                const parsed = JSON.parse(savedFiles) as Attachment[]
                const restoredAttachments: AttachedFile[] = parsed.map(att => ({
                    id: att.id,
                    type: att.type === "image" ? "image" : att.type === "pdf" ? "pdf" : "file",
                    previewUrl: att.type === "image" ? `/api/uploads/${att.id}` : undefined,
                    uploaded: att,
                    rendering: att.type === "pdf",
                }))
                setAttachments(prev => {
                    revokeAttachmentPreviewUrls(prev)
                    return restoredAttachments
                })
            } catch {
                setAttachments(prev => {
                    revokeAttachmentPreviewUrls(prev)
                    return []
                })
            }
        } else {
            setAttachments(prev => {
                revokeAttachmentPreviewUrls(prev)
                return []
            })
        }

        const restoredFrame = window.requestAnimationFrame(() => { restoredRef.current = true })
        return () => {
            window.cancelAnimationFrame(frame)
            window.cancelAnimationFrame(restoredFrame)
        }
    }, [draftKey, filesKey, setAttachments])

    const updateText = React.useCallback((val: string) => {
        setValue(val)
        localStorage.setItem(draftKey, val)
    }, [draftKey])

    const clear = React.useCallback(() => {
        setValue("")
        setAttachments(prev => {
            revokeAttachmentPreviewUrls(prev)
            return []
        })
        localStorage.removeItem(draftKey)
        localStorage.removeItem(filesKey)
    }, [draftKey, filesKey, setAttachments])

    React.useEffect(() => {
        return () => revokeAttachmentPreviewUrls(attachmentsRef.current)
    }, [])

    return { value, setValue: updateText, attachments, setAttachments, restore, clear }
}

// ---------------------------------------------------------------------------
// useFileAttachments — handles file upload, drag-drop, paste
// ---------------------------------------------------------------------------

function useFileAttachments(setAttachments: React.Dispatch<React.SetStateAction<AttachedFile[]>>) {
    const fileInputRef = React.useRef<HTMLInputElement>(null)
    const [isDragging, setIsDragging] = React.useState(false)
    const dragCounterRef = React.useRef(0)
    const mountedRef = React.useRef(true)
    const createdPreviewUrlsRef = React.useRef<Set<string>>(new Set())

    const addFiles = React.useCallback((files: FileList | File[]) => {
        const newAttachments: AttachedFile[] = Array.from(files).map((file) => ({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            file,
            previewUrl: (() => {
                if (fileType(file) !== "image") return undefined
                const previewUrl = URL.createObjectURL(file)
                createdPreviewUrlsRef.current.add(previewUrl)
                return previewUrl
            })(),
            type: fileType(file),
            uploading: true,
        }))
        setAttachments((prev) => [...prev, ...newAttachments])

        for (const att of newAttachments) {
            if (!att.file) continue
            const formData = new FormData()
            formData.append('files', att.file)
            fetch('/api/upload', { method: 'POST', body: formData })
                .then(async res => {
                    const data = await res.json().catch(() => ({}))
                    if (!res.ok) throw new Error(uploadErrorMessage(data, `Upload failed (${res.status})`))
                    const uploaded = uploadedAttachmentFromResponse(data)
                    if (!uploaded) throw new Error("Upload response did not include an attachment")
                    return uploaded
                })
                .then(uploaded => {
                    if (!mountedRef.current) return
                    setAttachments(prev => prev.map(a =>
                        a.id === att.id ? { ...a, uploaded, uploading: false } : a
                    ))
                })
                .catch((err) => {
                    if (!mountedRef.current) return
                    setAttachments(prev => prev.map(a =>
                        a.id === att.id
                            ? { ...a, uploading: false, error: err instanceof Error ? err.message : "Upload failed" }
                            : a
                    ))
                })
        }
    }, [setAttachments])

    const removeAttachment = React.useCallback((id: string) => {
        setAttachments((prev) => {
            const removed = prev.find((a) => a.id === id)
            if (isBlobPreviewUrl(removed?.previewUrl)) {
                URL.revokeObjectURL(removed.previewUrl)
                createdPreviewUrlsRef.current.delete(removed.previewUrl)
            }
            return prev.filter((a) => a.id !== id)
        })
    }, [setAttachments])

    const markRendered = React.useCallback((id: string) => {
        setAttachments(prev => prev.map(a =>
            a.id === id ? { ...a, rendering: false } : a
        ))
    }, [setAttachments])

    const handleDragEnter = React.useCallback((e: React.DragEvent) => {
        e.preventDefault()
        dragCounterRef.current++
        if (e.dataTransfer.types.includes("Files")) setIsDragging(true)
    }, [])

    const handleDragLeave = React.useCallback((e: React.DragEvent) => {
        e.preventDefault()
        dragCounterRef.current--
        if (dragCounterRef.current === 0) setIsDragging(false)
    }, [])

    const handleDrop = React.useCallback((e: React.DragEvent) => {
        e.preventDefault()
        dragCounterRef.current = 0
        setIsDragging(false)
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
    }, [addFiles])

    const handlePaste = React.useCallback((e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items
        if (!items) return
        const files: File[] = []
        for (const item of items) {
            if (item.kind === "file") {
                const file = item.getAsFile()
                if (file) files.push(file)
            }
        }
        if (files.length > 0) addFiles(files)
    }, [addFiles])

    const handlePlusClick = React.useCallback(() => { fileInputRef.current?.click() }, [])

    const handleFileChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) addFiles(e.target.files)
        e.target.value = ""
    }, [addFiles])

    // Cleanup blob URLs on unmount
    React.useEffect(() => {
        mountedRef.current = true
        const createdPreviewUrls = createdPreviewUrlsRef.current
        return () => {
            mountedRef.current = false
            for (const previewUrl of createdPreviewUrls) URL.revokeObjectURL(previewUrl)
            createdPreviewUrls.clear()
        }
    }, [])

    return {
        fileInputRef, isDragging, addFiles, removeAttachment, markRendered,
        handleDragEnter, handleDragLeave, handleDrop, handlePaste,
        handlePlusClick, handleFileChange,
    }
}

// ---------------------------------------------------------------------------
// ChatInput
// ---------------------------------------------------------------------------

interface ChatInputProps {
    variant?: "home" | "chat"
}

export function ChatInput({ variant = "home" }: ChatInputProps) {
    const {
        sendMessage,
        stopStreaming,
        state: { activeConversationId, conversations, isStreaming },
    } = useChatStore()

    const textareaRef = React.useRef<HTMLTextAreaElement>(null)
    const [previewAttachment, setPreviewAttachment] = React.useState<Attachment | null>(null)
    const [isRecording, setIsRecording] = React.useState(false)

    const draft = useDraftPersistence(activeConversationId)
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

    // Voice recording
    const voice = useVoiceRecording({
        isChat: variant === "chat",
        onSend: React.useCallback(async (blob: Blob, mimeType: string) => {
            const extension = mimeType.includes("mp4") ? "m4a" : "webm"
            const file = new File([blob], `voice-message.${extension}`, { type: mimeType })
            const formData = new FormData()
            formData.append("files", file)
            try {
                const res = await fetch("/api/upload", { method: "POST", body: formData })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(uploadErrorMessage(data, `Upload failed (${res.status})`))
                const uploaded = uploadedAttachmentFromResponse(data)
                if (uploaded) sendMessage("", undefined, [uploaded])
            } catch { /* upload failed silently */ }
        }, [sendMessage]),
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
    const canSend = hasContent && !hasPendingAttachments && !hasFailedAttachments && !isStreaming
    const maxHeight = isChat ? 160 : 200

    // Restore draft on conversation switch
    React.useEffect(() => {
        return draft.restore(textareaRef)
    }, [activeConversationId]) // eslint-disable-line react-hooks/exhaustive-deps

    // Focus listener
    React.useEffect(() => {
        const handleFocusRequest = () => textareaRef.current?.focus()
        window.addEventListener(CHAT_INPUT_FOCUS_EVENT, handleFocusRequest)
        return () => window.removeEventListener(CHAT_INPUT_FOCUS_EVENT, handleFocusRequest)
    }, [])

    // Auto-resize textarea
    const resizeTextarea = React.useCallback(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.style.height = "0px"
        textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    }, [maxHeight])

    React.useEffect(() => { resizeTextarea() }, [draft.value, resizeTextarea])

    const handleSubmit = React.useCallback(() => {
        const trimmed = draft.value.trim()
        if ((!trimmed && draft.attachments.length === 0) || hasPendingAttachments || hasFailedAttachments || isStreaming) return
        const uploadedAttachments = draft.attachments.filter(a => a.uploaded).map(a => a.uploaded!)
        sendMessage(trimmed, undefined, uploadedAttachments.length > 0 ? uploadedAttachments : undefined)
        draft.clear()
        if (isMobileKeyboardViewport()) {
            textareaRef.current?.blur()
        } else {
            textareaRef.current?.focus()
        }
    }, [draft, hasFailedAttachments, hasPendingAttachments, isStreaming, sendMessage])

    const handleKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== "Enter" || event.shiftKey) return
            event.preventDefault()
            handleSubmit()
        },
        [handleSubmit]
    )

    const handleMicClick = React.useCallback(() => {
        if (isStreaming) return
        setIsRecording(true)
        voice.start()
    }, [isStreaming, voice])

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
                    accept="image/*,.pdf,.txt,.csv,.json,.md,.doc,.docx,.xls,.xlsx,.mp3,.wav,.mp4,.webm"
                    className="hidden"
                    onChange={handleFileChange}
                />

                {/* Attachments area */}
                <div
                    className={cn(
                        "grid transition-all duration-200 ease-out",
                        draft.attachments.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    )}
                >
                    <div className="overflow-hidden min-h-0">
                        <div className="pt-3 px-4 pb-1 flex gap-2.5 flex-wrap">
                            {draft.attachments.map((attachment) => (
                                <FilePreview
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

                {/* Textarea + recording overlay */}
                <div className="grid">
                    <textarea
                        ref={textareaRef}
                        value={draft.value}
                        onChange={(e) => draft.setValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        placeholder={isChat ? "Reply..." : "How can I help you today?"}
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

                {/* Bottom bar */}
                <div className="flex items-center justify-between px-3 pb-3">
                    {/* Left button */}
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

                    {/* Right buttons */}
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
                                    {isStreaming ? (
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
