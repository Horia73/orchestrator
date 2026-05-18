"use client"

import * as React from "react"
import { Plus } from "lucide-react"

export function HomeSkeleton() {
    return (
        <div className="flex flex-1 flex-col items-center justify-center px-4 pb-52">
            <div className="flex w-full max-w-[672px] flex-col items-center gap-7">
                {/* Hero greeting skeleton */}
                <div className="h-10 w-64 animate-pulse rounded-lg bg-muted-foreground/15 relative -top-[15px]" />

                {/* Chat input skeleton */}
                <div className="w-full rounded-[20px] bg-white shadow-[0_0_0_0.5px_rgba(93,72,57,0.3),0_10px_22px_rgba(44,30,18,0.06)] dark:bg-card dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.2),0_10px_22px_rgba(0,0,0,0.24)]">
                    <div className="h-[66px] w-full px-5 pt-[19px]">
                        <div className="h-5 w-48 animate-pulse rounded bg-muted-foreground/15" />
                    </div>

                    <div className="flex items-center justify-between px-3 pb-3">
                        <div className="flex size-9 items-center justify-center rounded-lg">
                            <Plus className="size-5.5 stroke-[1] text-muted-foreground/30" />
                        </div>
                        <div className="flex size-9 shrink-0 items-center justify-center">
                            <div className="flex size-[32px] items-center justify-center rounded-md bg-muted-foreground/15" />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
