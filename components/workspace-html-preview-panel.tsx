"use client"

import * as React from "react"
import { ExternalLink, Globe, Loader2, RotateCw, X } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkspaceHtmlPreview } from "@/lib/workspace-html-preview"

export function WorkspaceHtmlPreviewPanel({
  tabs,
  activeId,
  onSelect,
  onCloseTab,
  onClose,
}: {
  tabs: WorkspaceHtmlPreview[]
  activeId: string | null
  onSelect: (id: string) => void
  onCloseTab: (id: string) => void
  onClose: () => void
}) {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null
  const [reloadKeys, setReloadKeys] = React.useState<Record<string, number>>({})
  const [loading, setLoading] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    if (!active) return
    setLoading((current) =>
      current[active.id] === undefined ? { ...current, [active.id]: true } : current
    )
  }, [active])

  const reload = React.useCallback(() => {
    if (!active) return
    setLoading((current) => ({ ...current, [active.id]: true }))
    setReloadKeys((current) => ({
      ...current,
      [active.id]: (current[active.id] ?? 0) + 1,
    }))
  }, [active])

  if (!active) return null

  const reloadKey = reloadKeys[active.id] ?? 0
  const iframeSrc = reloadKey === 0 ? active.src : `${active.src}?_r=${reloadKey}`
  const isLoading = loading[active.id] !== false

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border/70 bg-background">
      <header className="flex min-h-0 flex-col border-b border-border/70 bg-muted/35">
        <div className="flex min-w-0 items-end gap-1 overflow-x-auto px-2 pt-2">
          {tabs.map((tab) => {
            const selected = tab.id === active.id
            return (
              <div
                key={tab.id}
                title={tab.filePath}
                className={cn(
                  "group flex h-9 min-w-[128px] max-w-[220px] items-center rounded-t-md border text-[12px] transition-colors",
                  selected
                    ? "border-border border-b-background bg-background text-foreground"
                    : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left"
                >
                  <Globe className="size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  title="Close tab"
                  onClick={() => onCloseTab(tab.id)}
                  className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview panel"
            title="Close preview panel"
            className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 border-t border-border/60 bg-background px-2 py-1.5">
          <div className="flex min-w-0 flex-1 items-center rounded-md border border-border/70 bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            <span className="truncate">{active.src}</span>
          </div>
          <button
            type="button"
            onClick={reload}
            aria-label="Reload preview"
            title="Reload preview"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <RotateCw className="size-4" />
          </button>
          <a
            href={active.src}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open preview in new tab"
            title="Open in new tab"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-4" />
          </a>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 bg-white">
        {isLoading ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/80 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-xs">Loading preview...</span>
          </div>
        ) : null}
        <iframe
          key={`${active.id}:${reloadKey}`}
          src={iframeSrc}
          title={active.title}
          onLoad={() => setLoading((current) => ({ ...current, [active.id]: false }))}
          className="size-full border-0 bg-white"
          sandbox="allow-downloads allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      </div>
    </aside>
  )
}
