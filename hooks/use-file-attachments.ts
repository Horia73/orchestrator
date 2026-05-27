import * as React from "react"
import type { Attachment } from "@/lib/types"

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

export function fileType(file: File): AttachedFile["type"] {
    if (file.type.startsWith("image/")) return "image"
    if (file.type === "application/pdf") return "pdf"
    return "file"
}

export function isBlobPreviewUrl(url: string | undefined): url is string {
    return typeof url === "string" && url.startsWith("blob:")
}

export function revokeAttachmentPreviewUrl(attachment: AttachedFile) {
    if (isBlobPreviewUrl(attachment.previewUrl)) URL.revokeObjectURL(attachment.previewUrl)
}

export function revokeAttachmentPreviewUrls(attachments: AttachedFile[]) {
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

export function uploadedAttachmentFromResponse(data: unknown): Attachment | null {
    if (!data || typeof data !== "object") return null
    const attachments = (data as { attachments?: unknown }).attachments
    if (!Array.isArray(attachments)) return null
    return isAttachment(attachments[0]) ? attachments[0] : null
}

export function uploadErrorMessage(data: unknown, fallback: string) {
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
        return (data as { error: string }).error
    }
    return fallback
}

export function useFileAttachments(setAttachments: React.Dispatch<React.SetStateAction<AttachedFile[]>>) {
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
