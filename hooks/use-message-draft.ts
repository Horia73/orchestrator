import * as React from "react"
import { isMobileKeyboardViewport } from "@/hooks/use-keyboard-inset"
import {
    revokeAttachmentPreviewUrls,
    type AttachedFile,
} from "@/hooks/use-file-attachments"
import { appPath } from "@/lib/app-path"
import type { Attachment } from "@/lib/types"

interface MessageDraftOptions {
    /** localStorage key namespace, e.g. "chat" or "inbox" */
    namespace: string
    /** Per-thread id (conversation id, inbox item id, etc.). null → "new" bucket */
    threadId: string | null
}

const MISSING_RESTORED_UPLOAD_ERROR = "Attachment file is no longer available. Re-attach it."

function uploadUrl(id: string): string {
    return appPath(`/api/uploads/${encodeURIComponent(id)}`)
}

function restoredAttachmentFromUpload(att: Attachment): AttachedFile {
    return {
        id: att.id,
        type: att.type === "image" ? "image" : att.type === "pdf" ? "pdf" : "file",
        previewUrl: att.type === "image" ? uploadUrl(att.id) : undefined,
        uploaded: att,
        rendering: att.type === "pdf",
    }
}

async function missingRestoredUploadIds(attachments: Attachment[]): Promise<Set<string>> {
    const missing = new Set<string>()
    await Promise.all(attachments.map(async (att) => {
        try {
            const res = await fetch(uploadUrl(att.id), { method: "HEAD", cache: "no-store" })
            if (res.status === 404) missing.add(att.id)
        } catch {
            // Network/session failures are ambiguous; keep the draft rather than
            // deleting a still-valid file from local state.
        }
    }))
    return missing
}

export function useMessageDraft({ namespace, threadId }: MessageDraftOptions) {
    const draftKey = `${namespace}:draft:${threadId || 'new'}`
    const filesKey = `${namespace}:files:${threadId || 'new'}`

    const [value, setValue] = React.useState(() => {
        if (typeof window === 'undefined') return ""
        return localStorage.getItem(draftKey) || ""
    })

    const [attachments, setAttachmentsState] = React.useState<AttachedFile[]>([])
    const attachmentsRef = React.useRef<AttachedFile[]>([])
    // Track the filesKey we last restored into. Guards the persistence effect
    // against a thread switch racing ahead of restore: when filesKey changes,
    // this effect fires *before* the restore-trigger effect (declaration order),
    // so without the key match it would write the previous thread's
    // attachments into the new thread's localStorage entry.
    const restoredForKeyRef = React.useRef<string | null>(null)

    const setAttachments = React.useCallback<React.Dispatch<React.SetStateAction<AttachedFile[]>>>((next) => {
        setAttachmentsState(prev => {
            const resolved = typeof next === "function"
                ? (next as (prevState: AttachedFile[]) => AttachedFile[])(prev)
                : next
            attachmentsRef.current = resolved
            return resolved
        })
    }, [])

    React.useEffect(() => {
        if (restoredForKeyRef.current !== filesKey) return
        const persisted = attachments.filter(a => a.uploaded).map(a => a.uploaded!)
        if (persisted.length > 0) {
            localStorage.setItem(filesKey, JSON.stringify(persisted))
        } else {
            localStorage.removeItem(filesKey)
        }
    }, [attachments, filesKey])

    const restore = React.useCallback((textareaRef: React.RefObject<HTMLTextAreaElement | null>) => {
        restoredForKeyRef.current = null
        let validationCancelled = false

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
                const restoredAttachments: AttachedFile[] = parsed.map(restoredAttachmentFromUpload)
                setAttachments(prev => {
                    revokeAttachmentPreviewUrls(prev)
                    return restoredAttachments
                })
                missingRestoredUploadIds(parsed).then(missing => {
                    if (validationCancelled || missing.size === 0) return
                    const available = parsed.filter(att => !missing.has(att.id))
                    if (available.length > 0) {
                        localStorage.setItem(filesKey, JSON.stringify(available))
                    } else {
                        localStorage.removeItem(filesKey)
                    }
                    setAttachments(prev => prev.map(att => {
                        const uploadedId = att.uploaded?.id
                        if (!uploadedId || !missing.has(uploadedId)) return att
                        return {
                            ...att,
                            uploaded: undefined,
                            uploading: false,
                            rendering: false,
                            error: MISSING_RESTORED_UPLOAD_ERROR,
                        }
                    }))
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

        const restoredFrame = window.requestAnimationFrame(() => { restoredForKeyRef.current = filesKey })
        return () => {
            validationCancelled = true
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
