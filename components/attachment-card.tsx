"use client"

import * as React from "react"
import { FileText, FileSpreadsheet, Presentation, Image as ImageIcon, Video, Play, Pause } from "lucide-react"
import { formatDuration } from "@/lib/utils"
import { appPath } from "@/lib/app-path"
import { PdfThumbnail } from "@/components/pdf-thumbnail"
import type { Attachment } from "@/lib/types"

interface AttachmentCardProps {
    attachment: Attachment
    onClick?: () => void
}

export function AudioPlayer({ url }: { url: string }) {
    const audioRef = React.useRef<HTMLAudioElement>(null)
    const progressRef = React.useRef<HTMLDivElement>(null)
    const seekingRef = React.useRef(false)
    const [isPlaying, setIsPlaying] = React.useState(false)
    const [currentTime, setCurrentTime] = React.useState(0)
    const [duration, setDuration] = React.useState(0)

    React.useEffect(() => {
        const audio = audioRef.current
        if (!audio) return
        const onMeta = () => { if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration) }
        const onTime = () => { if (!seekingRef.current) setCurrentTime(audio.currentTime || 0) }
        const onEnded = () => { setIsPlaying(false); setCurrentTime(0) }
        const onPlay = () => setIsPlaying(true)
        const onPause = () => setIsPlaying(false)
        audio.addEventListener("loadedmetadata", onMeta)
        audio.addEventListener("durationchange", onMeta)
        audio.addEventListener("timeupdate", onTime)
        audio.addEventListener("ended", onEnded)
        audio.addEventListener("play", onPlay)
        audio.addEventListener("pause", onPause)
        return () => {
            audio.removeEventListener("loadedmetadata", onMeta)
            audio.removeEventListener("durationchange", onMeta)
            audio.removeEventListener("timeupdate", onTime)
            audio.removeEventListener("ended", onEnded)
            audio.removeEventListener("play", onPlay)
            audio.removeEventListener("pause", onPause)
        }
    }, [])

    const togglePlay = React.useCallback(() => {
        const audio = audioRef.current
        if (!audio) return
        if (isPlaying) audio.pause()
        else void audio.play().catch(() => {})
    }, [isPlaying])

    const seekTo = React.useCallback((clientX: number) => {
        const audio = audioRef.current
        const bar = progressRef.current
        if (!audio || !bar || !duration) return
        const rect = bar.getBoundingClientRect()
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        audio.currentTime = ratio * duration
        setCurrentTime(ratio * duration)
    }, [duration])

    const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        seekingRef.current = true
        seekTo(e.clientX)
        const onMove = (mv: MouseEvent) => seekTo(mv.clientX)
        const onUp = () => {
            seekingRef.current = false
            document.removeEventListener("mousemove", onMove)
            document.removeEventListener("mouseup", onUp)
        }
        document.addEventListener("mousemove", onMove)
        document.addEventListener("mouseup", onUp)
    }, [seekTo])

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0

    return (
        <div className="flex items-center gap-2.5 px-3 py-2.5 min-w-[220px] rounded-lg border border-border/60 bg-white dark:bg-muted/20">
            <audio ref={audioRef} src={url} preload="metadata" />
            <button
                type="button"
                onClick={togglePlay}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#b76440] text-white transition-colors hover:bg-[#a55837] active:scale-95"
                aria-label={isPlaying ? "Pause" : "Play"}
            >
                {isPlaying
                    ? <Pause className="size-3.5 fill-current" />
                    : <Play className="size-3.5 fill-current ml-0.5" />}
            </button>
            <div
                ref={progressRef}
                className="flex-1 flex items-center h-6 cursor-pointer touch-none group"
                onMouseDown={handleMouseDown}
            >
                <div className="relative w-full h-[4px] rounded-full bg-border">
                    <div
                        className="absolute top-0 left-0 h-full rounded-full bg-[#b76440]"
                        style={{ width: `${progress}%` }}
                    />
                    <div
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-3 rounded-full bg-[#b76440] shadow-sm opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity"
                        style={{ left: `${progress}%` }}
                    />
                </div>
            </div>
            <span className="text-[12px] tabular-nums text-muted-foreground whitespace-nowrap shrink-0">
                {formatDuration(currentTime)}{duration > 0 ? ` / ${formatDuration(duration)}` : ""}
            </span>
        </div>
    )
}

const iconMap = {
    image: ImageIcon,
    video: Video,
    pdf: FileText,
    document: FileText,
    spreadsheet: FileSpreadsheet,
    presentation: Presentation,
    other: FileText,
}

export function AttachmentCard({ attachment, onClick }: AttachmentCardProps) {
    const url = appPath(`/api/uploads/${encodeURIComponent(attachment.id)}`)

    if (attachment.type === "audio") {
        return <AudioPlayer url={url} />
    }

    if (attachment.type === "image") {
        return (
            <button
                type="button"
                onClick={onClick}
                className="rounded-lg border border-border/60 overflow-hidden bg-muted/30 hover:border-border transition-colors size-[128px] shrink-0"
            >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={url}
                    alt={attachment.filename}
                    className="size-full object-contain"
                />
            </button>
        )
    }

    if (attachment.type === "video") {
        return (
            <div className="w-[260px] max-w-full overflow-hidden rounded-lg border border-border/60 bg-black">
                <video
                    src={url}
                    controls
                    preload="metadata"
                    className="block aspect-video w-full bg-black object-contain"
                />
                <button
                    type="button"
                    onClick={onClick}
                    className="flex w-full items-center justify-between gap-2 bg-background px-3 py-2 text-left text-[12px] hover:bg-muted"
                >
                    <span className="min-w-0 truncate font-medium">{attachment.filename}</span>
                    <span className="shrink-0 text-muted-foreground">{(attachment.size / 1024).toFixed(1)} KB</span>
                </button>
            </div>
        )
    }

    if (attachment.type === "pdf") {
        return (
            <button
                type="button"
                onClick={onClick}
                className="relative rounded-lg border border-border/60 overflow-hidden bg-white dark:bg-muted/20 hover:border-border transition-colors size-[128px] shrink-0"
            >
                <div className="w-full h-full overflow-hidden flex items-center justify-center">
                    <PdfThumbnail url={url} />
                </div>
                <div className="absolute bottom-1.5 left-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1.5 py-0.5 rounded border border-border/50 bg-white/90 dark:bg-background/90 backdrop-blur-xs">
                        PDF
                    </span>
                </div>
            </button>
        )
    }

    const Icon = iconMap[attachment.type as keyof typeof iconMap] || FileText

    return (
        <button
            type="button"
            onClick={onClick}
            className="rounded-lg border border-border/60 bg-white dark:bg-muted/20 hover:border-border transition-colors px-3 py-2.5 flex flex-col items-start gap-1.5 min-w-[100px] max-w-[160px] shrink-0"
        >
            <Icon className="size-5 text-muted-foreground" />
            <span className="text-[12px] font-medium truncate max-w-full leading-tight text-left">
                {attachment.filename}
            </span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide px-1.5 py-0.5 rounded border border-border/50 bg-muted/30">
                {attachment.filename.split(".").pop()?.toUpperCase() || attachment.type.toUpperCase()}
            </span>
        </button>
    )
}
