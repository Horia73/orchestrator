"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { LAYOUT_TRANSITION } from "@/components/chat/chat-view-helpers"
import { cn } from "@/lib/utils"

export function ChatSkeleton() {
    const [hasArtifact] = React.useState(() => {
        if (typeof window === 'undefined') return false
        const activeId = localStorage.getItem("chat:active-id")
        if (activeId) {
            const saved = localStorage.getItem(`chat:artifact:${activeId}`)
            if (saved) {
                try {
                    return JSON.parse(saved).artifactOpen === true
                } catch { }
            }
        }
        return false
    })

    return (
        <div
            className={cn(
                "grid min-h-0 flex-1 overflow-hidden transition-[grid-template-columns]",
                LAYOUT_TRANSITION
            )}
            style={{ gridTemplateColumns: hasArtifact ? "minmax(0, 1.15fr) minmax(0, 0.85fr)" : "minmax(0, 1fr) 0fr" }}
        >
            <div className="relative flex min-h-0 min-w-0 flex-col border-r border-transparent">
                <div className="relative z-10 shrink-0 bg-background px-4 py-3">
                    <div className="flex items-center gap-1 py-1">
                        <div className="h-4 w-32 animate-pulse rounded bg-muted-foreground/20" />
                        <ChevronDown className="size-3.5 text-muted-foreground/30" />
                    </div>
                    <div className="pointer-events-none absolute inset-x-0 bottom-[-20px] h-5 bg-gradient-to-b from-background via-background/70 to-transparent" />
                </div>

                <div
                    className="min-h-0 flex-1 overflow-y-scroll pointer-events-none"
                    style={{ scrollbarGutter: "stable both-edges" }}
                >
                    <div className="mx-auto flex min-h-full w-full max-w-[780px] flex-col px-4">
                        <div className="flex-1 pt-4 pb-10">
                            <div className="mx-auto max-w-[700px] space-y-8 px-2 mt-4">
                                <div className="flex flex-col items-end gap-2 opacity-60">
                                    <div className="h-[44px] w-64 animate-pulse rounded-[10px] bg-[#f0ede6] dark:bg-muted" />
                                </div>
                                <div className="flex w-full flex-col gap-2 opacity-60">
                                    <div className="flex items-center gap-1 mb-1">
                                        <div className="h-4 w-28 animate-pulse rounded bg-muted-foreground/20" />
                                        <ChevronDown className="size-4 text-muted-foreground/30" />
                                    </div>
                                    <div className="h-4 w-[90%] animate-pulse rounded bg-muted-foreground/20" />
                                    <div className="h-4 w-[85%] animate-pulse rounded bg-muted-foreground/20" />
                                    <div className="h-4 w-[60%] animate-pulse rounded bg-muted-foreground/20" />
                                </div>
                                <div className="flex flex-col items-end gap-2 opacity-60">
                                    <div className="h-[44px] w-48 animate-pulse rounded-[10px] bg-[#f0ede6] dark:bg-muted" />
                                </div>
                                <div className="flex w-full flex-col gap-2 opacity-60">
                                    <div className="h-4 w-[80%] animate-pulse rounded bg-muted-foreground/20" />
                                    <div className="h-4 w-[40%] animate-pulse rounded bg-muted-foreground/20" />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="relative shrink-0 bg-background px-4 pb-3 opacity-50 pointer-events-none">
                    <div className="mx-auto w-full max-w-[780px]">
                        <div className="w-full rounded-[24px] bg-[#f4f4f0] shadow-sm dark:bg-[#1a1a1a] p-3 pl-4 flex flex-col justify-end min-h-[96px]">
                            <div className="flex items-center justify-between w-full h-[36px]">
                                <div className="flex items-center gap-3">
                                    <div className="size-[32px] rounded-full bg-[#e6e1db] dark:bg-[#2a2a2a] animate-pulse" />
                                    <div className="size-[32px] rounded-[10px] bg-[#e6e1db] dark:bg-[#2a2a2a] animate-pulse" />
                                </div>
                                <div className="size-[32px] rounded-full bg-black/60 dark:bg-white/60 animate-pulse flex items-center justify-center">
                                    <div className="size-3.5 bg-white/40 dark:bg-black/40 rounded-sm" />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="min-w-0 overflow-hidden bg-background">
                {hasArtifact && (
                    <div className="h-full w-full overflow-hidden p-6 pl-0 pt-0">
                        <div className="h-full w-full rounded-2xl bg-muted/30 border border-border/50 p-6 flex flex-col gap-4 animate-[pulse_2s_cubic-bezier(0.4,0,0.6,1)_infinite]">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="size-5 rounded bg-muted-foreground/20" />
                                <div className="h-5 w-40 rounded bg-muted-foreground/20" />
                            </div>
                            <div className="h-4 w-[80%] rounded bg-muted-foreground/15" />
                            <div className="h-4 w-[90%] rounded bg-muted-foreground/15" />
                            <div className="h-4 w-[60%] rounded bg-muted-foreground/15" />
                            <div className="h-4 w-[75%] rounded bg-muted-foreground/15 mt-4" />
                            <div className="h-4 w-[85%] rounded bg-muted-foreground/15" />
                            <div className="flex-1" />
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
