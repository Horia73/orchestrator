"use client"

import * as React from "react"

import { RemoteAccessPanel } from "@/components/remote-access/remote-access-panel"

export function RemoteAccessTab() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-foreground">Remote access</h2>
        <p className="mt-1 text-[13px] text-foreground/60">
          How you reach Orchestrator — on your network, over HTTPS, and which endpoints (if any) are
          exposed to the internet for inbound webhooks.
        </p>
      </div>
      <RemoteAccessPanel />
    </div>
  )
}
