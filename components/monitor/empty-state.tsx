"use client"

import { Radar } from "lucide-react"

export function EmptyState() {
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <Radar className="mx-auto mb-3 size-8 text-foreground/30" />
      <h2 className="text-[15px] font-semibold text-foreground">
        No watches yet
      </h2>
      <p className="mt-2 text-[13px] text-foreground/60">
        Smart Monitor checks things periodically in one cheap loop and only pings
        you when something matters — Gmail VIPs, Home Assistant sensors, ticket
        availability, anything you ask the orchestrator to watch.
      </p>
      <p className="mt-3 text-[13px] text-foreground/60">
        Nothing is monitored by default. Ask in chat — for example,{" "}
        <span className="italic">
          &quot;watch my Gmail for messages from Mom&quot;
        </span>{" "}
        — and the orchestrator will set it up.
      </p>
    </div>
  )
}
