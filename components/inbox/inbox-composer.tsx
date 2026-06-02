"use client"

import * as React from "react"
import { ArrowUp, Loader2, Plus, Reply } from "lucide-react"
import { AttachmentPreview } from "@/components/attachment-preview"
import { FilePreviewModal } from "@/components/file-preview-modal"
import {
    useFileAttachments,
    type AttachedFile,
} from "@/hooks/use-file-attachments"
import { useMessageDraft } from "@/hooks/use-message-draft"
import {
    isMobileKeyboardViewport,
    useMobileKeyboardInset,
} from "@/hooks/use-keyboard-inset"
import { cn } from "@/lib/utils"
import type { Attachment } from "@/lib/types"

interface InboxComposerProps {
    itemId: string
    responding: boolean
    onSend: (content: string, attachments?: Attachment[]) => void | Promise<void>
}

export function InboxComposer({ itemId, responding, onSend }: InboxComposerProps) {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null)
    const [previewAttachment, setPreviewAttachment] = React.useState<Attachment | null>(null)
    const keyboardInset = useMobileKeyboardInset()

    const draft = useMessageDraft({ namespace: "inbox", threadId: itemId })
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

    const hasContent = draft.value.trim().length > 0 || draft.attachments.length > 0
    const hasPendingAttachments = draft.attachments.some(a => a.uploading || a.rendering)
    const hasFailedAttachments = draft.attachments.some(a => a.error && !a.uploaded)
    const canSend = hasContent && !hasPendingAttachments && !hasFailedAttachments && !responding

    React.useEffect(() => {
        return draft.restore(textareaRef)
    }, [itemId]) // eslint-disable-line react-hooks/exhaustive-deps

    const resizeTextarea = React.useCallback(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.style.height = "0px"
        textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
    }, [])

    React.useEffect(() => { resizeTextarea() }, [draft.value, resizeTextarea])

    const handleSubmit = React.useCallback(() => {
        const trimmed = draft.value.trim()
        if ((!trimmed && draft.attachments.length === 0) || hasPendingAttachments || hasFailedAttachments || responding) return
        const uploadedAttachments = draft.attachments
            .filter(a => a.uploaded)
            .map(a => a.uploaded!)
        void onSend(trimmed, uploadedAttachments.length > 0 ? uploadedAttachments : undefined)
        draft.clear()
        if (isMobileKeyboardViewport()) {
            textareaRef.current?.blur()
        } else {
            textareaRef.current?.focus()
        }
    }, [draft, hasFailedAttachments, hasPendingAttachments, onSend, responding])

    const handleKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== "Enter" || event.shiftKey) return
            if (isMobileKeyboardViewport()) return
            event.preventDefault()
            handleSubmit()
        },
        [handleSubmit]
    )

    const handlePreviewClick = React.useCallback((att: AttachedFile) => {
        if (att.uploaded) setPreviewAttachment(att.uploaded)
    }, [])

    return (
        <form
            className={cn(
                "relative z-10 shrink-0 border-t border-border/60 bg-background px-3 pt-3 transition-[padding-bottom,transform] duration-150 ease-out md:px-6",
                keyboardInset > 0
                    ? "pb-2"
                    : "pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-3",
                "dark:border-white/10",
            )}
            style={
                keyboardInset > 0
                    ? { transform: `translate3d(0, -${keyboardInset}px, 0)` }
                    : undefined
            }
            onSubmit={(event) => {
                event.preventDefault()
                handleSubmit()
            }}
        >
            <div className="mx-auto w-full max-w-[920px]">
                <div
                    className={cn(
                        "relative w-full rounded-2xl border border-transparent bg-white shadow-[0_0_0_0.5px_rgba(93,72,57,0.42)] transition-shadow duration-200 ease-out focus-within:shadow-[0_0_0_0.5px_rgba(93,72,57,0.52)] dark:bg-card dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.22)] dark:focus-within:shadow-[0_0_0_0.5px_rgba(255,255,255,0.3)]",
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

                    <textarea
                        ref={textareaRef}
                        value={draft.value}
                        onChange={(event) => draft.setValue(event.target.value)}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        disabled={responding}
                        enterKeyHint="enter"
                        placeholder="Write a reply..."
                        rows={1}
                        className="max-h-40 min-h-[46px] w-full resize-none bg-transparent px-5 pt-3.5 pb-2 text-[16px] leading-6 text-foreground outline-none [font-family:var(--font-display)] tracking-[-0.02em] placeholder:font-medium placeholder:text-foreground/55 disabled:opacity-60"
                    />

                    <div className="flex items-center justify-between px-3 pb-3">
                        <button
                            type="button"
                            onClick={handlePlusClick}
                            disabled={responding}
                            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label="Attach file"
                        >
                            <Plus className="size-5.5 stroke-[1]" />
                        </button>

                        <div className="flex items-center gap-2">
                            <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-foreground/55">
                                <Reply className="size-3.5 shrink-0" />
                                <span className="truncate">Reply</span>
                            </div>
                            <button
                                type="submit"
                                disabled={!canSend}
                                className={cn(
                                    "flex size-8 shrink-0 items-center justify-center rounded-[11px] bg-[#b76440] text-white transition-colors hover:bg-[#a55837]",
                                    !canSend && "cursor-not-allowed opacity-50 hover:bg-[#b76440]"
                                )}
                                aria-label={
                                    hasPendingAttachments
                                        ? "Waiting for attachments"
                                        : hasFailedAttachments
                                            ? "Remove failed attachments"
                                            : "Send reply"
                                }
                            >
                                {responding ? (
                                    <Loader2 className="size-[15px] animate-spin" />
                                ) : (
                                    <ArrowUp className="size-[17px] stroke-[2.5]" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <FilePreviewModal
                attachment={previewAttachment}
                onClose={() => setPreviewAttachment(null)}
            />
        </form>
    )
}
