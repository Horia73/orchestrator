"use client"

import * as React from "react"

import { BrowserAgentWorkspace } from "@/components/chat/browser-agent-workspace"
import type { AgentCallReasoningEntry } from "@/lib/types"

/**
 * Dev-only preview surface for the browser-agent side-panel workspace
 * (live view slot + Console / Network / Transcript tabs). The live view
 * shows the local availability chip (no VNC in dev) and the diagnostics
 * poll hits the real endpoint (usually no session locally) — the point is
 * the layout, tab chrome, and transcript rendering. Not linked from
 * anywhere; navigate to /dev/browser-workspace-preview directly.
 */
const SAMPLE_RUN: AgentCallReasoningEntry = {
    type: "agent_call",
    id: "dev-browser-run-entry",
    phase: 0,
    runId: "dev-browser-run",
    agentId: "browser_agent",
    agentName: "Browser agent",
    kind: "concierge",
    title: "Browser agent",
    prompt: "Open example.com, verify the heading, and capture a screenshot of the page.",
    status: "ok",
    startedAt: 0,
    content: [
        "Browser session: browser_session_dev-1234",
        "Terminal output:",
        "```text",
        "🌐 Navigating to: https://example.com",
        "🧾 readPage: 3 element(s) captured",
        "🖱️  Clicked e2 (\"Learn more\")",
        "📸 Saving current browser screenshot...",
        "Session status: completed",
        "```",
    ].join("\n"),
    reasoning: [],
}

export default function BrowserWorkspacePreviewPage() {
    const [mounted, setMounted] = React.useState(false)
    React.useEffect(() => setMounted(true), [])

    return (
        <div className="mx-auto flex h-dvh max-w-2xl flex-col gap-3 p-4">
            <header className="shrink-0 border-b border-border/40 pb-2">
                <h1 className="text-xl font-semibold tracking-tight">Browser workspace</h1>
                <p className="text-xs text-muted-foreground">
                    Side-panel layout for a browser-agent run: live view + Console/Network/Transcript.
                </p>
            </header>
            <div className="min-h-0 flex-1 rounded-lg border border-border">
                {mounted && <BrowserAgentWorkspace run={SAMPLE_RUN} />}
            </div>
        </div>
    )
}
