"use client"

import * as React from "react"
import { Camera, CloudSun, Clock3, ExternalLink, ImageIcon, LineChart, Search, Trophy } from "lucide-react"

import type { ToolCallReasoningEntry } from "@/lib/types"
import type { ArtifactPayload } from "@/components/artifact-panel"
import { cn } from "@/lib/utils"
import {
    LiveTerminal,
    TERMINAL_MIN_WIDTH_CLASS,
} from "@/components/tool-call-terminal"
import { useTrapWheel } from "@/components/use-trap-wheel"
import {
    FileChangePreview,
    fileChangeSummary,
    fileChangeTitle,
} from "@/components/tool-call-file-change"

export { TerminalOutput } from "@/components/tool-call-terminal"

interface InlineToolCallViewProps {
    entry: ToolCallReasoningEntry
    onOpen?: (artifact: ArtifactPayload) => void
    searchDisplay?: "expanded" | "compact"
    ownerLabel?: string
}

type ParsedData = Record<string, unknown> | null

// Every boxed tool-call panel (terminal, generic frame, web activity) renders
// at this exact height so the collapsed thought preview can be sized in whole
// cards — message-bubble imports it to fit exactly 2 full cards before the
// "Show more" affordance.
export const TOOL_CALL_CARD_HEIGHT = 230
const TOOL_CALL_PANEL_HEIGHT = `min(${TOOL_CALL_CARD_HEIGHT}px, calc(100vh - 360px))`
const TOOL_CALL_PANEL_MIN_HEIGHT = "160px"
const TOOL_CALL_PANEL_STYLE: React.CSSProperties = {
    height: TOOL_CALL_PANEL_HEIGHT,
    minHeight: TOOL_CALL_PANEL_MIN_HEIGHT,
    overscrollBehavior: "contain",
}
const TOOL_CALL_INSET_CLASS = "ml-7 w-[calc(100%_-_1.75rem)] max-w-[760px]"

export function InlineToolCallView({ entry, searchDisplay = "expanded", ownerLabel }: InlineToolCallViewProps) {
    const status = entry.status ?? (entry.content ? (entry.success === false ? "error" : "ok") : "running")
    const data = parseToolData(entry.content)
    const terminalWrapRef = useTrapWheel<HTMLDivElement>()

    if (isHiddenToolCall(entry)) return null

    if (entry.toolName === "Bash" || entry.toolName === "shell") {
        return (
            <div
                ref={terminalWrapRef}
                className={cn(
                    "tool-call-scroll relative z-10 flex flex-col overflow-x-auto overflow-y-hidden rounded-md border border-[#24242a] bg-[#0c0c0e] text-left shadow-sm [touch-action:pan-x_pan-y]",
                    TOOL_CALL_INSET_CLASS
                )}
                style={TOOL_CALL_PANEL_STYLE}
            >
                {ownerLabel && (
                    <div className="flex shrink-0 items-center justify-end border-b border-[#24242a] px-2 py-1.5">
                        <ToolOwnerPill label={ownerLabel} />
                    </div>
                )}
                <LiveTerminal entry={entry} data={data} className={TERMINAL_MIN_WIDTH_CLASS} />
            </div>
        )
    }

    if (isSearchTool(entry.toolName)) {
        if (searchDisplay === "compact") {
            return (
                <div className={cn("relative z-10 py-1 text-left", TOOL_CALL_INSET_CLASS)}>
                    <CompactSearchPreview entry={entry} status={status} data={data} ownerLabel={ownerLabel} />
                </div>
            )
        }
        return <InlineWebSearchGroup entries={[entry]} ownerLabel={ownerLabel} />
    }

    return (
        <ToolFrame ownerLabel={ownerLabel}>
            <ToolPreview entry={entry} data={data} />
        </ToolFrame>
    )
}

function isHiddenToolCall(entry: ToolCallReasoningEntry): boolean {
    // Strip any MCP server prefix ("mcp__orch-tools__delegate_to",
    // "orch-tools__delegate_to", "orch-tools.delegate_to") so CLI/codex-backed
    // delegations are matched the same as native ones.
    const stripMcpPrefix = (raw: string): string => {
        let n = raw.trim()
        const dunder = n.lastIndexOf("__")
        if (dunder >= 0) n = n.slice(dunder + 2)
        const dot = n.lastIndexOf(".")
        if (dot >= 0) n = n.slice(dot + 1)
        return n.toLowerCase()
    }
    const name = stripMcpPrefix(entry.toolName ?? entry.title)
    // Delegations render as their own agent blocks; the tool-call row would be an
    // empty box, so hide it (delegate_to and delegate_parallel, native or MCP).
    if (name === "todowrite" || name === "delegate_to" || name === "delegate_parallel") return true
    // Fallback for entries that only carry the human title.
    const title = (entry.title ?? "").trim().toLowerCase()
    return title.startsWith("delegate to ") || title.startsWith("delegate in parallel") || /^delegate \d+ jobs in parallel/.test(title)
}

function isSearchTool(toolName: string | undefined): boolean {
    return toolName === "web_search" || toolName === "WebSearch"
}

export function isWebSearchToolCall(entry: ToolCallReasoningEntry): boolean {
    return isSearchTool(entry.toolName)
}

export function InlineWebSearchGroup({ entries, ownerLabel }: { entries: ToolCallReasoningEntry[]; ownerLabel?: string }) {
    const requests: WebRequestItem[] = []
    const websites: SearchWebsite[] = []
    let hasRunning = false
    let hasError = false

    for (const entry of entries) {
        const data = parseToolData(entry.content)
        requests.push(...webRequestItems(data, entry.args, entry.content))
        websites.push(...searchWebsites(data, entry.content))
        hasRunning ||= entry.status === "running" || (!entry.status && !entry.content)
        hasError ||= entry.success === false || entry.status === "error"
    }

    if (!requests.length && !websites.length) return null

    return (
        <div className={cn("relative z-10 text-left", TOOL_CALL_INSET_CLASS)}>
            <WebActivityCard
                requests={dedupeWebRequests(requests)}
                websites={dedupeWebsites(websites, requests)}
                status={hasRunning ? "running" : hasError ? "error" : "ok"}
                ownerLabel={ownerLabel}
            />
        </div>
    )
}

function ToolFrame({
    bodyClassName,
    children,
    ownerLabel,
}: {
    bodyClassName?: string
    children: React.ReactNode
    ownerLabel?: string
}) {
    const bodyRef = useTrapWheel<HTMLDivElement>()
    return (
        <div
            className={cn("relative z-10 flex flex-col overflow-hidden rounded-md border border-border bg-background text-left shadow-sm", TOOL_CALL_INSET_CLASS)}
            style={TOOL_CALL_PANEL_STYLE}
        >
            {ownerLabel && (
                <div className="flex shrink-0 items-center justify-end border-b border-border/60 px-2 py-1.5">
                    <ToolOwnerPill label={ownerLabel} />
                </div>
            )}
            <div
                ref={bodyRef}
                className={cn("tool-call-scroll min-h-0 flex-1 overflow-auto bg-background", bodyClassName)}
            >
                {children}
            </div>
        </div>
    )
}

function ToolOwnerPill({ label }: { label: string }) {
    return (
        <span className="rounded border border-border/70 bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
        </span>
    )
}

function StatusPill({ status }: { status: "running" | "ok" | "error" }) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
                status === "running" && "bg-blue-500/10 text-blue-600 dark:text-blue-300",
                status === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                status === "error" && "bg-destructive/10 text-destructive"
            )}
        >
            {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
            {status}
        </span>
    )
}

function CompactSearchPreview({ entry, status, data, ownerLabel }: { entry: ToolCallReasoningEntry; status: "running" | "ok" | "error"; data: ParsedData; ownerLabel?: string }) {
    const queries = searchQueries(data, entry.args, entry.content)
    const websites = searchWebsites(data, entry.content)
    const requests = webRequestItems(data, entry.args, entry.content)
    const entryTitle = entry.title?.trim() ?? ""
    const genericTitle = !entryTitle || entryTitle === "Search" || entryTitle === "Search web"
    const primary = genericTitle
        ? requests[0]?.label || (queries[0] ? `Search ${queries[0]}` : "Web")
        : entryTitle
    const detail = status === "running"
        ? requests.length > 1
            ? `${requests.length} web actions in progress`
            : queries.length > 1
                ? `${queries.length} searches in progress`
                : "Web action in progress"
        : websites.length > 0
            ? `${websites.length} source${websites.length === 1 ? "" : "s"} found`
            : requests.length > 0
                ? `${requests.length} web action${requests.length === 1 ? "" : "s"} finished`
                : queries.length > 0
                ? `${queries.length} search${queries.length === 1 ? "" : "es"} finished`
                : status === "error" ? "Web action failed" : "Web action finished"

    return (
        <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 py-2 shadow-sm">
            <span
                className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-md border",
                    status === "running" && "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-300",
                    status === "ok" && "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    status === "error" && "border-destructive/20 bg-destructive/10 text-destructive"
                )}
            >
                <Search className={cn("size-3.5", status === "running" && "animate-pulse")} />
            </span>
            <span className="min-w-0">
                <span
                    className={cn(
                        "block truncate text-[13px] font-medium",
                        status === "running" ? "search-shimmer-text" : "text-foreground/78"
                    )}
                    title={primary}
                >
                    {primary}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
            </span>
            {ownerLabel && <ToolOwnerPill label={ownerLabel} />}
            <StatusPill status={status} />
        </div>
    )
}

function ToolPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    if (entry.success === false) {
        return <ErrorPreview entry={entry} data={data} />
    }

    switch (entry.toolName) {
        case "Read":
        case "read_file":
            return <ReadPreview entry={entry} data={data} />
        case "Write":
            return <FileChangePreview summary={fileChangeSummary(entry, data)} fallbackRows={[
                ["Path", stringField(data, "path") || stringArg(entry.args, "file_path")],
                ["Bytes", numberField(data, "bytes")],
            ]} />
        case "Edit":
            return <EditPreview entry={entry} data={data} />
        case "file_change":
            return <FileChangePreview summary={fileChangeSummary(entry, data)} />
        case "Glob":
            return <GlobPreview entry={entry} data={data} />
        case "Grep":
            return <GrepPreview entry={entry} data={data} />
        case "WebFetch":
            return <TextPreview text={stringField(data, "content") || entry.content} />
        case "WebSearch":
        case "web_search":
            return <InlineWebSearchGroup entries={[entry]} />
        default:
            return <TextPreview text={entry.content || "No output yet."} />
    }
}

function TextPreview({ text }: { text: string }) {
    return <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-relaxed text-foreground/85">{text || "No output yet."}</pre>
}

function ErrorPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const raw = entry.content.replace(/^Error:\s*/, "").trim()
    const message = stringField(data, "message") || stringField(data, "error") || raw || "Tool call failed."
    const path = stringArg(entry.args, "path") || stringArg(entry.args, "file_path") || stringField(data, "path")
    const detail = raw && raw !== message ? raw : ""

    return (
        <div className="grid gap-2 border-l-2 border-l-destructive bg-destructive/5 p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium text-destructive">Tool failed</span>
                <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[11px] text-destructive">
                    {entry.toolName ?? entry.title}
                </span>
            </div>
            <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-destructive">
                {message}
            </div>
            {path && <div className="truncate font-mono text-[11px] text-destructive/75">{path}</div>}
            {detail && (
                <details className="text-[12px] text-destructive/80">
                    <summary className="cursor-pointer select-none">Details</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{detail}</pre>
                </details>
            )}
        </div>
    )
}

function ReadPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const text = stringField(data, "content") || entry.content
    const path = stringField(data, "path") || stringArg(entry.args, "path") || stringArg(entry.args, "file_path")
    const rows = readRows(text, numberField(data, "startLine") ?? numberArg(entry.args, "offset") ?? 1)
    const totalLines = numberField(data, "totalLines")
    const returned = numberField(data, "linesReturned") ?? rows.length
    const language = languageFromPath(path)

    return (
        <div className="divide-y divide-border/60">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                    <div className="truncate font-mono text-[12px] font-medium text-foreground/85" title={path}>
                        {path || "Read file"}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                        {returned} line{returned === 1 ? "" : "s"}{totalLines ? ` of ${totalLines}` : ""}
                    </div>
                </div>
                {language && (
                    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px]", languageClass(language))}>
                        {language}
                    </span>
                )}
            </div>
            <CodeRows rows={rows} />
        </div>
    )
}

interface CodeRow {
    lineNumber: number
    text: string
}

function CodeRows({ rows }: { rows: CodeRow[] }) {
    if (rows.length === 0) return <div className="px-3 py-3 text-[13px] text-muted-foreground">No content.</div>
    return (
        <div className="tool-call-scroll tool-call-scroll-x overflow-x-auto bg-background font-mono text-[12px] leading-5">
            {rows.map((row, index) => (
                <div key={`${row.lineNumber}-${index}`} className="grid min-w-[520px] max-md:min-w-full grid-cols-[56px_minmax(0,1fr)]">
                    <span className="select-none border-r border-border/40 px-2 text-right text-foreground/35">
                        {row.lineNumber}
                    </span>
                    <span className="min-w-0 whitespace-pre-wrap break-words px-2 text-foreground/82">
                        {row.text || " "}
                    </span>
                </div>
            ))}
        </div>
    )
}

function GlobPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const matches = arrayField(data, "matches")
    const count = numberField(data, "count") ?? matches.length
    const pattern = stringField(data, "pattern") || stringArg(entry.args, "pattern")

    if (matches.length === 0) {
        return (
            <div className="grid gap-1 p-3 text-[13px]">
                <div className="font-medium text-foreground/80">No matching files</div>
                {pattern && <div className="font-mono text-[12px] text-muted-foreground">{pattern}</div>}
            </div>
        )
    }

    return (
        <div className="divide-y divide-border/60">
            <ToolSummaryLine
                primary={`${count} file${count === 1 ? "" : "s"}`}
                secondary={pattern}
                trailing={booleanField(data, "truncated") ? "truncated" : undefined}
            />
            <PathList paths={matches} empty="No matching files." />
        </div>
    )
}

function GrepPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const pattern = stringField(data, "pattern") || stringArg(entry.args, "pattern")
    const mode = stringField(data, "output_mode") || stringArg(entry.args, "output_mode") || "content"
    const fileMatches = mode === "files_with_matches" ? arrayField(data, "matches") : []
    const rows = grepRows(data, entry.content)
    const count = numberField(data, "count") ?? (mode === "files_with_matches" ? fileMatches.length : rows.length)

    if (mode === "files_with_matches") {
        return (
            <div className="divide-y divide-border/60">
                <ToolSummaryLine primary={`${fileMatches.length} file${fileMatches.length === 1 ? "" : "s"} with matches`} secondary={pattern} />
                <PathList paths={fileMatches} empty="No files matched." />
            </div>
        )
    }

    if (rows.length === 0) {
        return (
            <div className="grid gap-1 p-3 text-[13px]">
                <div className="font-medium text-foreground/80">No matches</div>
                {pattern && <div className="font-mono text-[12px] text-muted-foreground">{pattern}</div>}
            </div>
        )
    }

    const groups = groupGrepRows(rows)
    return (
        <div className="divide-y divide-border/60">
            <ToolSummaryLine
                primary={`${count} match${count === 1 ? "" : "es"}`}
                secondary={pattern}
                trailing={booleanField(data, "truncated") ? "truncated" : undefined}
            />
            <div className="divide-y divide-border/50">
                {groups.map(group => (
                    <div key={group.file} className="min-w-0">
                        <div className="flex items-center justify-between gap-2 bg-muted/20 px-3 py-1.5">
                            <span className="min-w-0 truncate font-mono text-[12px] font-medium text-foreground/85" title={group.file}>
                                {group.file}
                            </span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                {group.rows.length}
                            </span>
                        </div>
                        <div className="tool-call-scroll tool-call-scroll-x overflow-x-auto font-mono text-[12px] leading-5">
                            {group.rows.map((row, index) => (
                                <div key={`${row.line}-${row.column}-${index}`} className="grid min-w-[520px] max-md:min-w-full grid-cols-[56px_minmax(0,1fr)]">
                                    <span className="select-none border-r border-border/40 px-2 text-right text-foreground/35">
                                        {row.line || ""}
                                    </span>
                                    <span className="min-w-0 whitespace-pre-wrap break-words px-2 text-foreground/82">
                                        <HighlightedText text={row.text} needle={pattern} />
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

function ToolSummaryLine({ primary, secondary, trailing }: { primary: string; secondary?: string; trailing?: string }) {
    return (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2 text-[12px]">
            <div className="min-w-0">
                <div className="font-medium text-foreground/80">{primary}</div>
                {secondary && <div className="truncate font-mono text-[11px] text-muted-foreground" title={secondary}>{secondary}</div>}
            </div>
            {trailing && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">{trailing}</span>}
        </div>
    )
}

function PathList({ paths, empty }: { paths: string[]; empty: string }) {
    const groups = groupPaths(paths)
    if (paths.length === 0) return <div className="p-3 text-[13px] text-muted-foreground">{empty}</div>
    return (
        <div className="divide-y divide-border/50">
            {groups.map(group => (
                <div key={group.dir} className="grid gap-1 px-3 py-2">
                    <div className="truncate font-mono text-[11px] text-muted-foreground" title={group.dir}>{group.dir}</div>
                    <div className="grid gap-0.5">
                        {group.items.map(item => (
                            <div key={item.full} className="flex min-w-0 items-center gap-2 font-mono text-[12px] text-foreground/85">
                                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", extensionDotClass(item.name))} />
                                <span className="truncate" title={item.full}>{item.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}

export function shouldExpandToolCallByDefault(entry: ToolCallReasoningEntry): boolean {
    return !isHiddenToolCall(entry)
}

export function getToolCallDisplayTitle(entry: ToolCallReasoningEntry, parsedData: ParsedData = parseToolData(entry.content)): string {
    if (entry.success === false) return `Failed ${entry.toolName ?? entry.title}`
    if (entry.toolName === "Read" || entry.toolName === "read_file") {
        const path = stringField(parsedData, "path") || stringArg(entry.args, "path") || stringArg(entry.args, "file_path")
        const lines = numberField(parsedData, "linesReturned")
        return path ? `Read ${basename(path)}${lines ? ` (${lines} lines)` : ""}` : entry.title
    }
    if (entry.toolName === "Glob") {
        const count = numberField(parsedData, "count") ?? arrayField(parsedData, "matches").length
        return count > 0 ? `Found ${count} file${count === 1 ? "" : "s"}` : entry.title
    }
    if (entry.toolName === "Grep") {
        const count = numberField(parsedData, "count")
        return typeof count === "number" ? `Found ${count} match${count === 1 ? "" : "es"}` : entry.title
    }
    if (isSearchTool(entry.toolName)) {
        const requests = webRequestItems(parsedData, entry.args, entry.content)
        if (requests.length > 1) return `${requests.length} web actions`
        if (requests.length === 1) return requests[0].label
    }
    const summary = fileChangeSummary(entry, parsedData)
    if (summary) return fileChangeTitle(summary)
    return entry.title
}

function EditPreview({ entry, data }: { entry: ToolCallReasoningEntry; data: ParsedData }) {
    const oldText = stringArg(entry.args, "old_string")
    const newText = stringArg(entry.args, "new_string")
    return (
        <div className="grid gap-2 p-3">
            <SummaryRows rows={[
                ["Path", stringField(data, "path") || stringArg(entry.args, "file_path")],
                ["Replacements", numberField(data, "replacements")],
            ]} />
            {(oldText || newText) && (
                <div className="grid gap-1 font-mono text-[12px]">
                    <pre className="tool-call-scroll overflow-auto rounded border border-red-500/20 bg-red-500/5 p-2 text-red-700 dark:text-red-300">- {oldText}</pre>
                    <pre className="tool-call-scroll overflow-auto rounded border border-emerald-500/20 bg-emerald-500/5 p-2 text-emerald-700 dark:text-emerald-300">+ {newText}</pre>
                </div>
            )}
        </div>
    )
}

function splitDiffLines(diff: string): string[] {
    const lines = diff.replace(/\r\n/g, "\n").split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    return lines
}

function basename(path: string): string {
    const normalized = path.replace(/\\/g, "/")
    return normalized.split("/").filter(Boolean).pop() || normalized || "file"
}

function dirname(path: string): string {
    const normalized = path.replace(/\\/g, "/")
    const parts = normalized.split("/").filter(Boolean)
    if (parts.length <= 1) return "."
    const hasLeadingSlash = normalized.startsWith("/")
    return `${hasLeadingSlash ? "/" : ""}${parts.slice(0, -1).join("/")}`
}

function readRows(text: string, startLine: number): CodeRow[] {
    if (!text.trim()) return []
    return splitDiffLines(text).map((line, index) => {
        const numbered = line.match(/^\s*(\d+)\s{2}(.*)$/)
        if (numbered) {
            return { lineNumber: Number(numbered[1]), text: numbered[2] }
        }
        return { lineNumber: startLine + index, text: line }
    })
}

interface PathGroup {
    dir: string
    items: Array<{ name: string; full: string }>
}

function groupPaths(paths: string[]): PathGroup[] {
    const groups = new Map<string, Array<{ name: string; full: string }>>()
    for (const full of paths) {
        const dir = dirname(full)
        const items = groups.get(dir) ?? []
        items.push({ name: basename(full), full })
        groups.set(dir, items)
    }
    return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dir, items]) => ({ dir, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
}

interface GrepRow {
    file: string
    line: number | null
    column: number | null
    text: string
}

function grepRows(data: ParsedData, rawText: string): GrepRow[] {
    const content = stringField(data, "content") || rawText
    const lines = splitDiffLines(content).filter(Boolean)
    return lines.map(parseGrepLine).filter((row): row is GrepRow => Boolean(row))
}

function parseGrepLine(line: string): GrepRow | null {
    const contentMatch = line.match(/^(.+?)([:-])(\d+)\2(\d+)\2(.*)$/)
    if (contentMatch) {
        return {
            file: contentMatch[1],
            line: Number(contentMatch[3]),
            column: Number(contentMatch[4]),
            text: contentMatch[5],
        }
    }

    const countMatch = line.match(/^(.+?):(\d+)$/)
    if (countMatch) {
        return {
            file: countMatch[1],
            line: null,
            column: null,
            text: `${countMatch[2]} matches`,
        }
    }

    return line.trim() ? { file: ".", line: null, column: null, text: line } : null
}

function groupGrepRows(rows: GrepRow[]): Array<{ file: string; rows: GrepRow[] }> {
    const groups = new Map<string, GrepRow[]>()
    for (const row of rows) {
        const current = groups.get(row.file) ?? []
        current.push(row)
        groups.set(row.file, current)
    }
    return [...groups.entries()].map(([file, groupRows]) => ({ file, rows: groupRows }))
}

function HighlightedText({ text, needle }: { text: string; needle: string }) {
    const cleanNeedle = literalSearchNeedle(needle)
    if (!cleanNeedle) return <>{text}</>
    const lower = text.toLowerCase()
    const lowerNeedle = cleanNeedle.toLowerCase()
    const index = lower.indexOf(lowerNeedle)
    if (index === -1) return <>{text}</>
    return (
        <>
            {text.slice(0, index)}
            <mark className="rounded bg-yellow-300/35 px-0.5 text-inherit dark:bg-yellow-300/25">
                {text.slice(index, index + cleanNeedle.length)}
            </mark>
            {text.slice(index + cleanNeedle.length)}
        </>
    )
}

function literalSearchNeedle(pattern: string): string {
    const trimmed = pattern.trim()
    if (!trimmed || /[\\^$.*+?()[\]{}|]/.test(trimmed)) return ""
    return trimmed
}

function languageFromPath(path: string): string {
    const ext = basename(path).split(".").pop()?.toLowerCase() ?? ""
    const map: Record<string, string> = {
        ts: "ts",
        tsx: "tsx",
        js: "js",
        jsx: "jsx",
        json: "json",
        md: "md",
        css: "css",
        scss: "scss",
        html: "html",
        mjs: "mjs",
        cjs: "cjs",
        py: "py",
        sh: "sh",
        yml: "yaml",
        yaml: "yaml",
        toml: "toml",
        sql: "sql",
    }
    return map[ext] ?? ext
}

function languageClass(language: string): string {
    if (language === "tsx" || language === "ts") return "bg-sky-500/10 text-sky-700 dark:text-sky-300"
    if (language === "jsx" || language === "js" || language === "mjs") return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
    if (language === "json") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    if (language === "md") return "bg-violet-500/10 text-violet-700 dark:text-violet-300"
    return "bg-muted text-muted-foreground"
}

function extensionDotClass(path: string): string {
    const language = languageFromPath(path)
    if (language === "tsx" || language === "ts") return "bg-sky-500"
    if (language === "jsx" || language === "js" || language === "mjs") return "bg-yellow-500"
    if (language === "json") return "bg-emerald-500"
    if (language === "md") return "bg-violet-500"
    return "bg-muted-foreground/45"
}

interface SearchWebsite {
    host: string
    url: string
    title: string
}

interface WebRequestItem {
    kind: "search" | "image" | "weather" | "finance" | "sports" | "time" | "open" | "click" | "find" | "screenshot"
    label: string
    href?: string
}

function WebActivityCard({
    requests,
    websites,
    status,
    ownerLabel,
}: {
    requests: WebRequestItem[]
    websites: SearchWebsite[]
    status: "running" | "ok" | "error"
    ownerLabel?: string
}) {
    const queryCount = requests.filter(item => item.kind === "search" || item.kind === "image").length
    const actionCount = requests.length - queryCount
    const summary = [
        queryCount ? `${queryCount} search${queryCount === 1 ? "" : "es"}` : "",
        actionCount ? `${actionCount} action${actionCount === 1 ? "" : "s"}` : "",
        websites.length ? `${websites.length} source${websites.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" · ")
    const listRef = useTrapWheel<HTMLDivElement>()

    return (
        <div
            className="flex flex-col overflow-hidden rounded-md border border-border/70 bg-background shadow-sm"
            style={TOOL_CALL_PANEL_STYLE}
        >
            <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-md border border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-300">
                    <Search className={cn("size-3.5", status === "running" && "animate-pulse")} />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground/85">Web activity</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{summary || "Web action"}</span>
                </span>
                {ownerLabel && <ToolOwnerPill label={ownerLabel} />}
                <StatusPill status={status} />
            </div>
            <div ref={listRef} className="tool-call-scroll min-h-0 flex-1 divide-y divide-border/45 overflow-y-auto overscroll-contain [touch-action:pan-y]">
                {requests.map((request, index) => (
                    <WebRequestRow key={`${request.kind}-${request.label}-${index}`} request={request} />
                ))}
                {websites.map((website, index) => (
                    <WebSourceRow key={`source-${website.url}-${index}`} website={website} />
                ))}
            </div>
        </div>
    )
}

function WebRequestRow({ request }: { request: WebRequestItem }) {
    const primary = webRequestPrimaryText(request)
    const detail = webRequestDetailText(request)
    const body = (
        <>
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-sm bg-muted/50 text-muted-foreground">
                <WebRequestIcon kind={request.kind} />
            </span>
            <span className="min-w-0">
                <span className="block truncate text-[13px] text-foreground/82">{primary}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
            </span>
        </>
    )

    if (request.href) {
        return (
            <div className="min-w-0">
                <a
                    href={request.href}
                    target="_blank"
                    rel="noreferrer"
                    title={request.label}
                    className="flex max-w-full items-start gap-2 px-3 py-2 transition-colors hover:bg-muted/35"
                >
                    {body}
                </a>
            </div>
        )
    }

    return (
        <div className="flex min-w-0 max-w-full items-start gap-2 px-3 py-2">
            {body}
        </div>
    )
}

function WebSourceRow({ website }: { website: SearchWebsite }) {
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(website.host)}&sz=32`
    const title = website.title && website.title !== website.url ? website.title : compactUrlLabel(website.url)
    return (
        <div className="min-w-0">
            <a
                href={website.url}
                target="_blank"
                rel="noreferrer"
                title={website.title}
                className="flex max-w-full items-start gap-2 px-3 py-2 transition-colors hover:bg-muted/35"
            >
                <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center overflow-hidden rounded-sm bg-muted text-[10px] font-semibold uppercase text-muted-foreground">
                    {website.host[0]}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={faviconUrl}
                        alt=""
                        className="absolute inset-0 size-full bg-background object-contain"
                        onError={event => { event.currentTarget.remove() }}
                    />
                </span>
                <span className="min-w-0">
                    <span className="block truncate text-[13px] text-foreground/82">{title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{website.host}</span>
                </span>
            </a>
        </div>
    )
}

function dedupeWebRequests(requests: WebRequestItem[]): WebRequestItem[] {
    const seen = new Set<string>()
    return requests.filter(item => {
        const key = `${item.kind}:${item.label}:${item.href ?? ""}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function dedupeWebsites(websites: SearchWebsite[], requests: WebRequestItem[]): SearchWebsite[] {
    const requestUrls = new Set(requests.map(item => item.href ? normalizeUrl(item.href) : "").filter(Boolean))
    const seen = new Set<string>()
    return websites.filter(website => {
        const url = normalizeUrl(website.url)
        if (!url || requestUrls.has(url) || seen.has(url)) return false
        seen.add(url)
        return true
    })
}

function webRequestPrimaryText(request: WebRequestItem): string {
    const label = request.label
    if (request.kind === "search" && label.startsWith("Search ")) return label.slice("Search ".length)
    if (request.kind === "image" && label.startsWith("Image search ")) return label.slice("Image search ".length)
    if (request.kind === "open" && label.startsWith("Open ")) return compactUrlLabel(label.slice("Open ".length))
    if (request.kind === "click" && label.startsWith("Click ")) return compactUrlLabel(label.slice("Click ".length))
    if (request.kind === "find" && label.startsWith("Find ")) return label.slice("Find ".length)
    if (request.kind === "screenshot" && label.startsWith("Screenshot ")) return compactUrlLabel(label.slice("Screenshot ".length))
    return label
}

function webRequestDetailText(request: WebRequestItem): string {
    if (request.kind === "image") return "Image search"
    if (request.kind === "open") return request.href ? `Open · ${hostFromUrl(request.href) || "web"}` : "Open"
    if (request.kind === "click") return request.href ? `Click · ${hostFromUrl(request.href) || "web"}` : "Click"
    if (request.kind === "find") return "Find on page"
    if (request.kind === "screenshot") return "Screenshot"
    if (request.kind === "weather") return "Weather"
    if (request.kind === "finance") return "Finance"
    if (request.kind === "sports") return "Sports"
    if (request.kind === "time") return "Time"
    return "Search"
}

function compactUrlLabel(value: string): string {
    const url = normalizeUrl(value)
    try {
        const parsed = new URL(url)
        const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, "")
        return `${parsed.host}${path || ""}`
    } catch {
        return value
    }
}

function WebRequestIcon({ kind }: { kind: WebRequestItem["kind"] }) {
    if (kind === "weather") return <CloudSun className="size-3" />
    if (kind === "finance") return <LineChart className="size-3" />
    if (kind === "sports") return <Trophy className="size-3" />
    if (kind === "time") return <Clock3 className="size-3" />
    if (kind === "image") return <ImageIcon className="size-3" />
    if (kind === "screenshot") return <Camera className="size-3" />
    if (kind === "open" || kind === "click") return <ExternalLink className="size-3" />
    if (kind === "find") return <Search className="size-3" />
    return <Search className="size-3" />
}

function searchWebsites(data: ParsedData, rawText: string): SearchWebsite[] {
    const seen = new Set<string>()
    const websites: SearchWebsite[] = []

    for (const source of searchSources(data, rawText)) {
        const host = hostFromUrl(source.url)
        if (!host || seen.has(host)) continue
        seen.add(host)
        websites.push({
            host,
            url: normalizeUrl(source.url),
            title: source.title || host,
        })
    }

    return websites
}

function searchSources(data: ParsedData, rawText: string): SearchWebsite[] {
    const sources: SearchWebsite[] = []
    collectSearchSources(data, sources)
    for (const url of urlsFromText(rawText)) {
        sources.push({ url, host: "", title: hostFromUrl(url) || url })
    }
    return sources
}

function collectSearchSources(value: unknown, out: SearchWebsite[], depth = 0) {
    if (depth > 5 || value == null) return
    if (Array.isArray(value)) {
        value.forEach(item => collectSearchSources(item, out, depth + 1))
        return
    }
    if (typeof value === "string") {
        for (const url of urlsFromText(value)) {
            out.push({ url, host: "", title: hostFromUrl(url) || url })
        }
        return
    }
    const record = objectRecord(value)
    if (!record) return

    const directUrl = sourceUrl(record)
    if (directUrl) {
        out.push({
            url: directUrl,
            host: "",
            title: stringField(record, "title") || stringField(record, "name") || hostFromUrl(directUrl) || directUrl,
        })
    }

    Object.values(record).forEach(item => collectSearchSources(item, out, depth + 1))
}

function sourceUrl(item: Record<string, unknown>): string {
    return stringField(item, "url")
        || stringField(item, "uri")
        || stringField(item, "link")
        || stringField(item, "source_url")
        || stringField(item, "sourceUrl")
}

function webRequestItems(data: ParsedData, args: Record<string, unknown> | undefined, rawText: string): WebRequestItem[] {
    const items: WebRequestItem[] = [
        ...searchQueries(data, args, rawText).map(query => ({
            kind: "search" as const,
            label: `Search ${query}`,
            href: searchEngineUrl(query),
        })),
        ...imageSearchQueries(data, args, rawText).map(query => ({
            kind: "image" as const,
            label: `Image search ${query}`,
            href: searchEngineUrl(`${query} images`),
        })),
    ]

    for (const record of webDataRecords(data, args, rawText)) {
        collectWebActionItems(record, items)
    }

    const seen = new Set<string>()
    return items.filter(item => {
        const key = `${item.kind}:${item.label}:${item.href ?? ""}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function webDataRecords(data: ParsedData, args: Record<string, unknown> | undefined, rawText: string): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = []
    const addRecord = (value: unknown) => {
        const record = objectRecord(value)
        if (!record || records.includes(record)) return
        records.push(record)
        const action = objectRecord(record.action)
        if (action && !records.includes(action)) records.push(action)
    }

    addRecord(args)
    addRecord(data)
    addRecord(tryParseJson(rawText))
    return records
}

function collectWebActionItems(record: Record<string, unknown>, out: WebRequestItem[]) {
    collectWebCollection(record.weather, weatherRequestItem, out)
    collectWebCollection(record.finance, financeRequestItem, out)
    collectWebCollection(record.sports, sportsRequestItem, out)
    collectWebCollection(record.time, timeRequestItem, out)
    collectWebCollection(record.open, openRequestItem, out)
    collectWebCollection(record.click, clickRequestItem, out)
    collectWebCollection(record.find, findRequestItem, out)
    collectWebCollection(record.screenshot, screenshotRequestItem, out)

    const typed = typedWebActionItem(record)
    if (typed) out.push(typed)
}

function collectWebCollection(
    value: unknown,
    build: (value: unknown) => WebRequestItem | null,
    out: WebRequestItem[]
) {
    if (value === undefined || value === null) return
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
        const built = build(item)
        if (built) out.push(built)
    }
}

function typedWebActionItem(record: Record<string, unknown>): WebRequestItem | null {
    const type = normalizeWebActionType(stringField(record, "type") || stringField(record, "action"))
    if (type === "weather") return weatherRequestItem(record)
    if (type === "finance") return financeRequestItem(record)
    if (type === "sports") return sportsRequestItem(record)
    if (type === "time") return timeRequestItem(record)
    if (type === "open" || type === "openpage") return openRequestItem(record)
    if (type === "click") return clickRequestItem(record)
    if (type === "find" || type === "findinpage") return findRequestItem(record)
    if (type === "screenshot") return screenshotRequestItem(record)
    return null
}

function weatherRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    const location = typeof value === "string"
        ? value
        : firstText(record?.location, record?.city, record?.place)
    if (!location) return null
    const start = firstText(record?.start, record?.date)
    const label = `Weather ${location}${start ? ` ${start}` : ""}`
    return { kind: "weather", label, href: searchEngineUrl(label) }
}

function financeRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    const ticker = typeof value === "string"
        ? value
        : firstText(record?.ticker, record?.symbol)
    if (!ticker) return null
    const market = firstText(record?.market)
    const label = `Finance ${ticker}${market ? ` ${market}` : ""}`
    return { kind: "finance", label, href: searchEngineUrl(`${ticker} price ${market}`.trim()) }
}

function sportsRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    if (!record && typeof value !== "string") return null
    const league = typeof value === "string" ? value : firstText(record?.league)
    const fn = record ? firstText(record.fn, record.function, record.type) : ""
    const team = record ? firstText(record.team) : ""
    const opponent = record ? firstText(record.opponent) : ""
    const date = record ? firstText(record.date_from, record.dateFrom, record.date) : ""
    const parts = [league ? league.toUpperCase() : "", fn, team, opponent ? `vs ${opponent}` : "", date].filter(Boolean)
    if (!parts.length) return null
    const label = `Sports ${parts.join(" ")}`
    return { kind: "sports", label, href: searchEngineUrl(parts.join(" ")) }
}

function timeRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    const target = typeof value === "string"
        ? value
        : firstText(record?.location, record?.utc_offset, record?.utcOffset, record?.timezone, record?.time_zone)
    if (!target) return null
    const label = `Time ${target}`
    return { kind: "time", label }
}

function openRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    const target = typeof value === "string"
        ? value
        : firstText(record?.url, record?.ref_id, record?.refId)
    if (!target) return null
    return { kind: "open", label: `Open ${target}`, href: urlHref(target) }
}

function clickRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    if (!record) return null
    const target = firstText(record.ref_id, record.refId, record.url)
    const id = typeof record.id === "number" || typeof record.id === "string" ? String(record.id) : ""
    if (!target && !id) return null
    return { kind: "click", label: `Click ${[target, id ? `#${id}` : ""].filter(Boolean).join(" ")}`, href: urlHref(target) }
}

function findRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    if (!record) return null
    const pattern = firstText(record.pattern, record.query, record.text)
    const target = firstText(record.ref_id, record.refId, record.url)
    if (!pattern && !target) return null
    return { kind: "find", label: `Find ${pattern || "text"}${target ? ` in ${target}` : ""}`, href: urlHref(target) }
}

function screenshotRequestItem(value: unknown): WebRequestItem | null {
    const record = objectRecord(value)
    if (!record) return null
    const target = firstText(record.ref_id, record.refId, record.url)
    const page = typeof record.pageno === "number" || typeof record.pageno === "string" ? ` page ${record.pageno}` : ""
    if (!target && !page) return null
    return { kind: "screenshot", label: `Screenshot ${target}${page}`, href: urlHref(target) }
}

function normalizeWebActionType(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function urlHref(value: string): string | undefined {
    if (!value) return undefined
    return /^(https?:\/\/|www\.)/i.test(value) ? normalizeUrl(value) : undefined
}

function searchQueries(data: ParsedData, args: Record<string, unknown> | undefined, rawText: string): string[] {
    const root = objectRecord(data)
    const action = objectRecord(root?.action)
    const queries = [
        ...searchQueryValues(args),
        ...searchQueryValues(root),
        ...searchQueryValues(action),
    ]
    if (!queries.some(Boolean)) {
        const parsed = objectRecord(tryParseJson(rawText))
        queries.push(...searchQueryValues(parsed))
    }

    const seen = new Set<string>()
    return queries.map(cleanSearchQuery).filter(query => {
        if (!query || seen.has(query)) return false
        seen.add(query)
        return true
    })
}

function imageSearchQueries(data: ParsedData, args: Record<string, unknown> | undefined, rawText: string): string[] {
    const root = objectRecord(data)
    const action = objectRecord(root?.action)
    const queries = [
        ...imageQueryValues(args),
        ...imageQueryValues(root),
        ...imageQueryValues(action),
    ]
    if (!queries.some(Boolean)) {
        const parsed = objectRecord(tryParseJson(rawText))
        queries.push(...imageQueryValues(parsed))
    }

    const seen = new Set<string>()
    return queries.map(cleanSearchQuery).filter(query => {
        if (!query || seen.has(query)) return false
        seen.add(query)
        return true
    })
}

function searchQueryValues(value: unknown): string[] {
    const record = objectRecord(value)
    if (!record) return []

    const queries: string[] = []
    collectSearchQueryValue(record.q, queries)
    collectSearchQueryValue(record.query, queries)
    collectSearchQueryValue(record.queries, queries)
    collectSearchQueryValue(record.search_query, queries)
    collectSearchQueryValue(record.searchQuery, queries)

    const action = objectRecord(record.action)
    if (action) {
        collectSearchQueryValue(action.q, queries)
        collectSearchQueryValue(action.query, queries)
        collectSearchQueryValue(action.queries, queries)
        collectSearchQueryValue(action.search_query, queries)
        collectSearchQueryValue(action.searchQuery, queries)
    }

    return queries
}

function imageQueryValues(value: unknown): string[] {
    const record = objectRecord(value)
    if (!record) return []

    const queries: string[] = []
    collectSearchQueryValue(record.image_query, queries)
    collectSearchQueryValue(record.imageQuery, queries)

    const action = objectRecord(record.action)
    if (action) {
        collectSearchQueryValue(action.image_query, queries)
        collectSearchQueryValue(action.imageQuery, queries)
    }

    return queries
}

function collectSearchQueryValue(value: unknown, out: string[], depth = 0) {
    if (depth > 4 || value == null) return
    if (typeof value === "string") {
        out.push(value)
        return
    }
    if (Array.isArray(value)) {
        value.forEach(item => collectSearchQueryValue(item, out, depth + 1))
        return
    }

    const record = objectRecord(value)
    if (!record) return

    const direct = stringField(record, "q") || stringField(record, "query")
    if (direct) out.push(direct)
    collectSearchQueryValue(record.queries, out, depth + 1)
    collectSearchQueryValue(record.search_query, out, depth + 1)
    collectSearchQueryValue(record.searchQuery, out, depth + 1)
}

function cleanSearchQuery(value: string): string {
    return value.replace(/\\"/g, "\"").replace(/\s+/g, " ").trim()
}

function urlsFromText(value: string): string[] {
    return Array.from(value.matchAll(/(?:https?:\/\/|www\.)[^\s"'<>)\]]+/g), match => (
        match[0].replace(/[.,;:!?]+$/, "")
    ))
}

function normalizeUrl(value: string): string {
    const trimmed = value.trim()
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
    return `https://${trimmed}`
}

function hostFromUrl(value: string): string {
    try {
        return new URL(normalizeUrl(value)).hostname.toLowerCase().replace(/\.$/, "")
    } catch {
        return ""
    }
}

function searchEngineUrl(query: string): string {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

function SummaryRows({ rows }: { rows: Array<[string, unknown]> }) {
    return (
        <div className="grid gap-1 text-[12px]">
            {rows.filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => (
                <div key={label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="min-w-0 truncate font-mono text-foreground/85">{String(value)}</span>
                </div>
            ))}
        </div>
    )
}

function parseToolData(content: string): ParsedData {
    const raw = content.startsWith("Error: ") ? content.slice(7) : content
    if (!raw.trim()) return null
    try {
        const parsed = JSON.parse(raw) as unknown
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string {
    const value = args?.[key]
    return typeof value === "string" ? value : ""
}

function stringField(data: unknown, key: string): string {
    if (!data || typeof data !== "object" || Array.isArray(data)) return ""
    const value = (data as Record<string, unknown>)[key]
    return typeof value === "string" ? value : ""
}

function firstText(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value !== "string") continue
        const trimmed = value.trim()
        if (trimmed) return trimmed
    }
    return ""
}

function numberField(data: unknown, key: string): number | undefined {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
    const value = (data as Record<string, unknown>)[key]
    return typeof value === "number" ? value : undefined
}

function numberArg(args: Record<string, unknown> | undefined, key: string): number | undefined {
    const value = args?.[key]
    return typeof value === "number" ? value : undefined
}

function booleanField(data: unknown, key: string): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false
    return (data as Record<string, unknown>)[key] === true
}

function arrayField(data: unknown, key: string): string[] {
    if (!data || typeof data !== "object" || Array.isArray(data)) return []
    const value = (data as Record<string, unknown>)[key]
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function objectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function tryParseJson(raw: string): unknown {
    const trimmed = raw.startsWith("Error: ") ? raw.slice(7).trim() : raw.trim()
    if (!trimmed) return null
    try {
        return JSON.parse(trimmed) as unknown
    } catch {
        return null
    }
}
