"use client"

import * as React from "react"
import {
    Check, Code, Copy, Download, X,
    FileText, FileCode, FileJson, FileImage, FileVideo, FileAudio,
    Folder, FolderOpen, File as FileIcon, AlertTriangle, SquareTerminal,
    Pencil, Search, Globe,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"
import { MarkdownRenderer } from "@/components/markdown-renderer"

// ---------------------------------------------------------------------------
// Public payload types
// ---------------------------------------------------------------------------

export interface CodeBlockArtifact {
    kind: "code-block"
    title: string
    language: string
    code: string
}

export interface ToolResultArtifact {
    kind: "tool-result"
    toolCallId: string
    toolName: string
    title: string
    args: Record<string, unknown>
    /** Stringified result data (or "Error: ..." on failure) */
    resultJson: string
    success: boolean
}

export type ArtifactPayload = CodeBlockArtifact | ToolResultArtifact

/** Stable key used for "is this the currently-open artifact?" comparisons. */
export function artifactKey(a: ArtifactPayload): string {
    if (a.kind === "tool-result") return `tool:${a.toolCallId}`
    return `code:${a.title}:${a.language}:${a.code.length}:${a.code.slice(0, 64)}`
}

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------

const EXT_TO_LANGUAGE: Record<string, string> = {
    ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    py: "python", pyi: "python",
    go: "go", rs: "rust", rb: "ruby",
    java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", swift: "swift",
    c: "c", h: "c", cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hh: "cpp",
    cs: "csharp", fs: "fsharp", vb: "vb",
    php: "php",
    sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell", bat: "bat",
    lua: "lua", r: "r", pl: "perl",
    dart: "dart", ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang",
    clj: "clojure", cljs: "clojure", edn: "clojure",
    html: "html", htm: "html", xml: "xml", svg: "xml",
    css: "css", scss: "scss", sass: "sass", less: "less",
    vue: "vue", svelte: "svelte", astro: "astro",
    json: "json", jsonc: "jsonc", json5: "json5", geojson: "json", ndjson: "json",
    yaml: "yaml", yml: "yaml",
    toml: "toml", ini: "ini", conf: "ini", properties: "ini",
    sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
    md: "markdown", mdx: "mdx", markdown: "markdown",
    txt: "text", log: "log", text: "text",
    env: "shellscript",
    tex: "latex", bib: "bibtex",
    mk: "makefile",
    nginx: "nginx",
    diff: "diff", patch: "diff",
    csv: "csv", tsv: "tsv",
}

const SPECIAL_FILENAMES: Record<string, string> = {
    "dockerfile": "docker",
    "containerfile": "docker",
    "makefile": "makefile",
    "gnumakefile": "makefile",
    "cmakelists.txt": "cmake",
    "rakefile": "ruby",
    "gemfile": "ruby",
    "guardfile": "ruby",
    "podfile": "ruby",
    "fastfile": "ruby",
    "vagrantfile": "ruby",
    ".gitignore": "ignore",
    ".dockerignore": "ignore",
    ".npmignore": "ignore",
    ".prettierignore": "ignore",
    ".eslintignore": "ignore",
    ".env": "shellscript",
    ".envrc": "shellscript",
    ".bashrc": "bash",
    ".zshrc": "bash",
    ".profile": "bash",
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "heic"])
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"])
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"])

interface FileKindInfo {
    kind: "markdown" | "code" | "json" | "text" | "binary"
    language: string
    iconKind: "code" | "text" | "json" | "image" | "video" | "audio" | "file"
}

function detectFileKind(filePath: string): FileKindInfo {
    const lower = filePath.toLowerCase()
    const base = lower.split("/").pop() || ""
    const dotIdx = base.lastIndexOf(".")
    const ext = dotIdx > 0 ? base.slice(dotIdx + 1) : ""

    if (SPECIAL_FILENAMES[base]) {
        const lang = SPECIAL_FILENAMES[base]
        return { kind: "code", language: lang, iconKind: "code" }
    }
    if (base.startsWith(".env.")) {
        return { kind: "code", language: "shellscript", iconKind: "code" }
    }

    if (IMAGE_EXTS.has(ext)) return { kind: "binary", language: "text", iconKind: "image" }
    if (VIDEO_EXTS.has(ext)) return { kind: "binary", language: "text", iconKind: "video" }
    if (AUDIO_EXTS.has(ext)) return { kind: "binary", language: "text", iconKind: "audio" }

    const lang = EXT_TO_LANGUAGE[ext]
    if (!lang) return { kind: "text", language: "text", iconKind: "file" }
    if (lang === "markdown" || lang === "mdx") return { kind: "markdown", language: lang, iconKind: "text" }
    if (lang === "json" || lang === "jsonc" || lang === "json5") return { kind: "json", language: lang, iconKind: "json" }
    if (lang === "text" || lang === "log") return { kind: "text", language: lang, iconKind: "text" }
    return { kind: "code", language: lang, iconKind: "code" }
}

function FileTypeIcon({ kind, className }: { kind: FileKindInfo["iconKind"]; className?: string }) {
    const cls = cn("size-4 shrink-0 text-muted-foreground", className)
    switch (kind) {
        case "code": return <FileCode className={cls} />
        case "text": return <FileText className={cls} />
        case "json": return <FileJson className={cls} />
        case "image": return <FileImage className={cls} />
        case "video": return <FileVideo className={cls} />
        case "audio": return <FileAudio className={cls} />
        default: return <FileIcon className={cls} />
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOWNLOAD_EXTENSION_BY_LANGUAGE: Record<string, string> = {
    javascript: "js", typescript: "ts", tsx: "tsx", jsx: "jsx",
    html: "html", css: "css", json: "json",
    markdown: "md", md: "md", python: "py", text: "txt",
}

function toFileName(title: string, language: string) {
    const normalized = language.trim().toLowerCase()
    const baseName = title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "code-snippet"
    const ext = DOWNLOAD_EXTENSION_BY_LANGUAGE[normalized] ?? normalized ?? "txt"
    return `${baseName}.${ext}`
}

function basename(p: string): string {
    if (!p) return ""
    return p.split("/").filter(Boolean).pop() || p
}

function formatBytes(n: number | undefined): string {
    if (n == null || !Number.isFinite(n)) return ""
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/**
 * read_file prefixes each line with `${padStart(6)}  `. Strip it and recover the
 * starting line number from the first parseable line.
 */
function stripLineNumberPrefix(content: string, fallbackStart = 1): { stripped: string; startLine: number } {
    const lines = content.split("\n")
    let startLine = fallbackStart
    let parsedStart = false
    const out: string[] = []
    for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s\s(.*)$/)
        if (m) {
            if (!parsedStart) { startLine = parseInt(m[1], 10); parsedStart = true }
            out.push(m[2])
        } else {
            out.push(line)
        }
    }
    return { stripped: out.join("\n"), startLine }
}

interface ReadFileData {
    path: string
    content: string
    totalLines?: number
    linesReturned?: number
    startLine?: number
    truncated?: boolean
}

interface ListDirData {
    path: string
    entries: Array<{ name: string; type: "file" | "directory"; size?: number }>
    count: number
}

interface GenericObjectData {
    path?: string
    content?: string
    output?: string
    stdout?: string
    stderr?: string
    matches?: string[]
    results?: Array<Record<string, unknown>>
    sources?: Array<Record<string, unknown>>
    count?: number
    bytes?: number
    replacements?: number
    exitCode?: number | null
    durationMs?: number
    command?: string
}

function tryParseJson<T>(s: string): T | null {
    if (!s) return null
    try { return JSON.parse(s) as T } catch { return null }
}

// ---------------------------------------------------------------------------
// Toolbar / shared bits
// ---------------------------------------------------------------------------

interface ToolbarButtonProps {
    onClick: () => void
    icon: React.ReactNode
    label?: string
    title?: string
}

function ToolbarButton({ onClick, icon, label, title }: ToolbarButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title ?? label}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-foreground/75 transition-colors hover:bg-muted hover:text-foreground"
        >
            {icon}
            {label && <span>{label}</span>}
        </button>
    )
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = React.useState(false)
    const handle = React.useCallback(async () => {
        if (!await copyTextToClipboard(text)) return
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
    }, [text])
    return (
        <ToolbarButton
            onClick={handle}
            icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            label={copied ? "Copied" : "Copy"}
        />
    )
}

function DownloadButton({ text, filename }: { text: string; filename: string }) {
    const handle = React.useCallback(() => {
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 0)
    }, [text, filename])
    return (
        <ToolbarButton
            onClick={handle}
            icon={<Download className="size-4" />}
            label="Download"
        />
    )
}

function CloseButton({ onClose }: { onClose: () => void }) {
    return (
        <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-foreground/75 transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
        >
            <X className="size-4" />
        </button>
    )
}

interface PanelHeaderProps {
    icon: React.ReactNode
    title: React.ReactNode
    subtitle?: React.ReactNode
    actions: React.ReactNode
}

function PanelHeader({ icon, title, subtitle, actions }: PanelHeaderProps) {
    return (
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-3 shrink-0 gap-3">
            <div className="flex items-center gap-2 min-w-0">
                {icon}
                <div className="flex min-w-0 items-baseline gap-2">
                    <span className="text-sm font-medium truncate" title={typeof title === "string" ? title : undefined}>
                        {title}
                    </span>
                    {subtitle && (
                        <span className="text-[11px] text-muted-foreground shrink-0">
                            {subtitle}
                        </span>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">{actions}</div>
        </div>
    )
}

function PanelShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full flex-col border-l border-border/40 bg-white dark:bg-card">
            {children}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Highlighted code with optional line numbers
// ---------------------------------------------------------------------------

const highlightCache = new Map<string, string>()

function HighlightedCode({
    code,
    language,
    startLine,
    showLineNumbers = false,
}: {
    code: string
    language: string
    startLine?: number
    showLineNumbers?: boolean
}) {
    const cacheKey = `${language}:${code}`
    const [html, setHtml] = React.useState<string | null>(() => highlightCache.get(cacheKey) ?? null)

    React.useEffect(() => {
        const cached = highlightCache.get(cacheKey)
        if (cached !== undefined) { setHtml(cached); return }
        let cancelled = false
        // Dynamic import keeps Shiki out of the chat route's initial bundle;
        // the plain <pre> fallback below already shows the code instantly.
        import("shiki")
            .then(({ codeToHtml }) =>
                codeToHtml(code, { lang: language, theme: "github-light" })
            )
            .then((result) => {
                if (cancelled) return
                highlightCache.set(cacheKey, result)
                setHtml(result)
            })
            .catch(() => {
                if (!cancelled) {
                    highlightCache.set(cacheKey, "")
                    setHtml("")
                }
            })
        return () => { cancelled = true }
    }, [cacheKey, code, language])

    const lineNumberPadding = showLineNumbers
        ? `${String((startLine ?? 1) + Math.max(0, code.split("\n").length - 1)).length + 1}ch`
        : "0"

    if (html === null || html === "") {
        return (
            <pre
                className={cn(
                    "px-5 py-4 text-[13px] leading-relaxed font-mono whitespace-pre",
                    showLineNumbers && "[counter-reset:lineno]",
                )}
                style={showLineNumbers ? { counterReset: `lineno ${(startLine ?? 1) - 1}` } : undefined}
            >
                <code>
                    {showLineNumbers
                        ? code.split("\n").map((line, i) => (
                            <span
                                key={i}
                                className="flex"
                                style={{ counterIncrement: "lineno" } as React.CSSProperties}
                            >
                                <span
                                    className="select-none text-muted-foreground/60 text-right pr-4 shrink-0"
                                    style={{ minWidth: lineNumberPadding }}
                                >
                                    {(startLine ?? 1) + i}
                                </span>
                                <span className="flex-1">{line || " "}</span>
                            </span>
                        ))
                        : code}
                </code>
            </pre>
        )
    }

    return (
        <div
            className={cn(
                "px-5 py-4 text-[13px] leading-relaxed",
                "[&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_pre]:!whitespace-pre",
                "[&_code]:!bg-transparent [&_code]:!font-mono",
                showLineNumbers && [
                    "[&_.line]:flex",
                    "[&_.line]:before:content-[counter(lineno)]",
                    "[&_.line]:before:[counter-increment:lineno]",
                    "[&_.line]:before:select-none",
                    "[&_.line]:before:text-muted-foreground/60",
                    "[&_.line]:before:text-right",
                    "[&_.line]:before:pr-4",
                    "[&_.line]:before:shrink-0",
                ],
            )}
            style={showLineNumbers
                ? { counterReset: `lineno ${(startLine ?? 1) - 1}`, ["--line-num-w" as string]: lineNumberPadding }
                : undefined}
            dangerouslySetInnerHTML={{
                __html: showLineNumbers
                    ? html.replace(
                        /<span class="line">/g,
                        `<span class="line" style="--ln-w:${lineNumberPadding}">`,
                    )
                    : html,
            }}
        />
    )
}

// ---------------------------------------------------------------------------
// Code block panel (existing extracted-from-message artifact)
// ---------------------------------------------------------------------------

function CodeBlockPanel({ artifact, onClose }: { artifact: CodeBlockArtifact; onClose: () => void }) {
    return (
        <PanelShell>
            <PanelHeader
                icon={<Code className="size-4 text-muted-foreground" />}
                title={artifact.title}
                subtitle={
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground uppercase tracking-wider">
                        {artifact.language}
                    </span>
                }
                actions={
                    <>
                        <DownloadButton text={artifact.code} filename={toFileName(artifact.title, artifact.language)} />
                        <CopyButton text={artifact.code} />
                        <CloseButton onClose={onClose} />
                    </>
                }
            />
            <div className="flex-1 overflow-auto bg-white dark:bg-card">
                <HighlightedCode code={artifact.code} language={artifact.language || "text"} />
            </div>
        </PanelShell>
    )
}

// ---------------------------------------------------------------------------
// read_file result panel
// ---------------------------------------------------------------------------

function ReadFileResultPanel({ artifact, onClose }: { artifact: ToolResultArtifact; onClose: () => void }) {
    const data = tryParseJson<ReadFileData>(artifact.resultJson)
    const argPath = typeof artifact.args.path === "string" ? artifact.args.path : ""
    const filePath = data?.path || argPath || "file"
    const rawContent = data?.content ?? ""
    const fallbackStart = data?.startLine ?? 1
    const { stripped, startLine } = stripLineNumberPrefix(rawContent, fallbackStart)
    const fileKind = detectFileKind(filePath)
    const display = basename(filePath)

    if (!artifact.success) {
        return (
            <PanelShell>
                <PanelHeader
                    icon={<AlertTriangle className="size-4 text-destructive" />}
                    title={display || "File"}
                    subtitle={<span className="text-destructive/80">Error</span>}
                    actions={<CloseButton onClose={onClose} />}
                />
                <div className="flex-1 overflow-auto p-5 font-mono text-[13px] text-destructive whitespace-pre-wrap">
                    {artifact.resultJson}
                </div>
            </PanelShell>
        )
    }

    const subtitleParts: string[] = []
    if (data?.totalLines != null && data?.linesReturned != null) {
        if (data.linesReturned < data.totalLines) {
            subtitleParts.push(`Lines ${startLine}–${startLine + data.linesReturned - 1} of ${data.totalLines}`)
        } else {
            subtitleParts.push(`${data.totalLines} ${data.totalLines === 1 ? "line" : "lines"}`)
        }
    }
    if (data?.truncated) subtitleParts.push("truncated")

    const downloadName = display || toFileName(artifact.title, fileKind.language)

    return (
        <PanelShell>
            <PanelHeader
                icon={<FileTypeIcon kind={fileKind.iconKind} />}
                title={display || filePath}
                subtitle={
                    <span className="flex items-center gap-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground uppercase tracking-wider">
                            {fileKind.language}
                        </span>
                        {subtitleParts.length > 0 && <span>{subtitleParts.join(" · ")}</span>}
                    </span>
                }
                actions={
                    <>
                        <DownloadButton text={stripped} filename={downloadName} />
                        <CopyButton text={stripped} />
                        <CloseButton onClose={onClose} />
                    </>
                }
            />
            <div className="flex-1 overflow-auto bg-white dark:bg-card min-w-0">
                {fileKind.kind === "markdown" ? (
                    <div className="px-6 py-5 text-[14px] [&>*:first-child]:mt-0">
                        <MarkdownRenderer content={stripped} />
                    </div>
                ) : fileKind.kind === "binary" ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                        <FileTypeIcon kind={fileKind.iconKind} className="size-8" />
                        <span className="text-sm">{display}</span>
                        <span className="text-xs">Binary preview not supported in this panel.</span>
                    </div>
                ) : (
                    <HighlightedCode
                        code={stripped}
                        language={fileKind.language}
                        startLine={startLine}
                        showLineNumbers
                    />
                )}
            </div>
        </PanelShell>
    )
}

// ---------------------------------------------------------------------------
// list_dir result panel
// ---------------------------------------------------------------------------

function ListDirResultPanel({ artifact, onClose }: { artifact: ToolResultArtifact; onClose: () => void }) {
    const sortedEntries = React.useMemo(() => {
        const data = tryParseJson<ListDirData>(artifact.resultJson)
        return [...(data?.entries ?? [])].sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1
            return a.name.localeCompare(b.name)
        })
    }, [artifact.resultJson])

    const data = tryParseJson<ListDirData>(artifact.resultJson)
    const argPath = typeof artifact.args.path === "string" ? artifact.args.path : ""
    const dirPath = data?.path || argPath || "."
    const entries = data?.entries ?? []
    const display = basename(dirPath) || dirPath

    if (!artifact.success) {
        return (
            <PanelShell>
                <PanelHeader
                    icon={<AlertTriangle className="size-4 text-destructive" />}
                    title={display}
                    subtitle={<span className="text-destructive/80">Error</span>}
                    actions={<CloseButton onClose={onClose} />}
                />
                <div className="flex-1 overflow-auto p-5 font-mono text-[13px] text-destructive whitespace-pre-wrap">
                    {artifact.resultJson}
                </div>
            </PanelShell>
        )
    }

    const namesText = sortedEntries
        .map((e) => (e.type === "directory" ? `${e.name}/` : e.name))
        .join("\n")

    return (
        <PanelShell>
            <PanelHeader
                icon={<FolderOpen className="size-4 text-muted-foreground" />}
                title={display}
                subtitle={`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
                actions={
                    <>
                        <CopyButton text={namesText} />
                        <CloseButton onClose={onClose} />
                    </>
                }
            />
            <div className="flex-1 overflow-auto bg-white dark:bg-card">
                {sortedEntries.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                        <Folder className="size-6" />
                        <span className="text-sm">Empty directory</span>
                    </div>
                ) : (
                    <ul className="divide-y divide-border/30">
                        {sortedEntries.map((entry) => {
                            const isDir = entry.type === "directory"
                            const fileKind = isDir ? null : detectFileKind(entry.name)
                            return (
                                <li
                                    key={`${entry.type}:${entry.name}`}
                                    className="flex items-center gap-3 px-5 py-2 text-[13px]"
                                >
                                    {isDir ? (
                                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                                    ) : (
                                        <FileTypeIcon kind={fileKind!.iconKind} />
                                    )}
                                    <span className={cn("flex-1 truncate font-mono", isDir && "font-medium")}>
                                        {entry.name}{isDir ? "/" : ""}
                                    </span>
                                    {!isDir && entry.size != null && (
                                        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                                            {formatBytes(entry.size)}
                                        </span>
                                    )}
                                </li>
                            )
                        })}
                    </ul>
                )}
            </div>
        </PanelShell>
    )
}

function BashResultPanel({ artifact, onClose }: { artifact: ToolResultArtifact; onClose: () => void }) {
    const data = tryParseJson<GenericObjectData>(artifact.resultJson.startsWith("Error: ") ? artifact.resultJson.slice(7) : artifact.resultJson)
    const output = data?.output ?? data?.stdout ?? artifact.resultJson
    const command = data?.command ?? (typeof artifact.args.command === "string" ? artifact.args.command : artifact.title)
    return (
        <PanelShell>
            <PanelHeader
                icon={<SquareTerminal className="size-4 text-muted-foreground" />}
                title={command}
                subtitle={data?.exitCode != null ? `exit ${data.exitCode}` : artifact.success ? "done" : "error"}
                actions={
                    <>
                        <CopyButton text={output} />
                        <CloseButton onClose={onClose} />
                    </>
                }
            />
            <div className="flex-1 overflow-auto bg-[#0c0c0e] p-4">
                <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-zinc-100">{output || "No output."}</pre>
            </div>
        </PanelShell>
    )
}

function StructuredToolResultPanel({ artifact, onClose }: { artifact: ToolResultArtifact; onClose: () => void }) {
    const data = tryParseJson<GenericObjectData>(artifact.resultJson.startsWith("Error: ") ? artifact.resultJson.slice(7) : artifact.resultJson)
    const icon = structuredToolIcon(artifact.toolName, artifact.success)
    const matchesText = Array.isArray(data?.matches) ? data.matches.join("\n") : ""
    const primaryText = data?.content ?? (matchesText || artifact.resultJson)
    const summary = [
        data?.path,
        data?.count != null ? `${data.count} result${data.count === 1 ? "" : "s"}` : null,
        data?.bytes != null ? formatBytes(data.bytes) : null,
        data?.replacements != null ? `${data.replacements} replacement${data.replacements === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join(" · ")

    return (
        <PanelShell>
            <PanelHeader
                icon={icon}
                title={artifact.title}
                subtitle={summary || artifact.toolName}
                actions={
                    <>
                        <CopyButton text={primaryText || artifact.resultJson} />
                        <CloseButton onClose={onClose} />
                    </>
                }
            />
            <div className="flex-1 overflow-auto bg-white dark:bg-card">
                {artifact.toolName === "web_search" && data ? (
                    <SourceList data={data} />
                ) : (
                    <HighlightedCode code={primaryText || artifact.resultJson} language={artifact.toolName === "Grep" ? "text" : "json"} />
                )}
            </div>
        </PanelShell>
    )
}

function SourceList({ data }: { data: GenericObjectData }) {
    const record = data as Record<string, unknown>
    const action = record.action
    const actionSources = action && typeof action === "object" && !Array.isArray(action)
        ? (action as Record<string, unknown>).sources
        : undefined
    const contentSources = Array.isArray(record.content)
        ? record.content.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : undefined
    const actionSourceList = Array.isArray(actionSources)
        ? actionSources.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : undefined
    const rawSources = [
        data.results,
        data.sources,
        contentSources,
        actionSourceList,
    ]
        .map(value => Array.isArray(value)
            ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
            : [])
        .find(items => items.length > 0) ?? []
    if (!rawSources.length) {
        const queries = sourceListQueries(record)
        if (queries.length > 0) {
            return (
                <ul className="grid content-start items-start gap-1.5 p-5">
                    {queries.map((query, index) => (
                        <li key={`${query}-${index}`} className="min-w-0">
                            <a
                                href={sourceListSearchUrl(query)}
                                target="_blank"
                                rel="noreferrer"
                                title={query}
                                className="inline-flex max-w-full items-start gap-2 text-[14px] leading-5 text-muted-foreground transition-colors hover:text-foreground hover:underline"
                            >
                                <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground">
                                    <Search className="size-3" />
                                </span>
                                <span className="min-w-0 break-words">{query}</span>
                            </a>
                        </li>
                    ))}
                </ul>
            )
        }
        return <HighlightedCode code={JSON.stringify(data, null, 2)} language="json" />
    }
    return (
        <ul className="grid content-start items-start gap-1.5 p-5">
            {rawSources.map((source, index) => {
                const title = typeof source.title === "string" ? source.title : `Source ${index + 1}`
                const url = typeof source.url === "string"
                    ? source.url
                    : typeof source.uri === "string"
                        ? source.uri
                        : ""
                const host = sourceListHost(url)
                const faviconUrl = host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32` : ""
                return (
                    <li key={`${url}-${index}`} className="min-w-0">
                        {url ? (
                            <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                title={title}
                                className="inline-flex max-w-full items-start gap-2 text-[14px] leading-5 text-muted-foreground transition-colors hover:text-foreground hover:underline"
                            >
                                <span className="relative mt-0.5 grid size-4 shrink-0 place-items-center overflow-hidden rounded-sm bg-background text-[10px] font-semibold uppercase text-muted-foreground">
                                    {host[0] ?? "s"}
                                    {faviconUrl && (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={faviconUrl}
                                            alt=""
                                            className="absolute inset-0 size-full bg-background object-contain"
                                            onError={event => { event.currentTarget.remove() }}
                                        />
                                    )}
                                </span>
                                <span className="min-w-0 break-all">{url}</span>
                            </a>
                        ) : (
                            <div className="text-[14px] leading-5 text-muted-foreground">{title}</div>
                        )}
                    </li>
                )
            })}
        </ul>
    )
}

function sourceListQueries(record: Record<string, unknown>): string[] {
    const action = record.action && typeof record.action === "object" && !Array.isArray(record.action)
        ? record.action as Record<string, unknown>
        : null
    const candidates = [
        stringValue(record.query),
        ...stringArray(record.queries),
        stringValue(action?.query),
        ...stringArray(action?.queries),
    ]
    const seen = new Set<string>()
    return candidates.map(cleanQueryText).filter(query => {
        if (!query || seen.has(query)) return false
        seen.add(query)
        return true
    })
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : ""
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function cleanQueryText(value: string): string {
    return value.replace(/\\"/g, "\"").replace(/\s+/g, " ").trim()
}

function sourceListSearchUrl(query: string): string {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

function sourceListHost(value: string): string {
    if (!value) return ""
    try {
        const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`
        return new URL(normalized).hostname.toLowerCase().replace(/\.$/, "")
    } catch {
        return ""
    }
}

function structuredToolIcon(toolName: string, success: boolean) {
    const cls = success ? "size-4 text-muted-foreground" : "size-4 text-destructive"
    if (!success) return <AlertTriangle className={cls} />
    switch (toolName) {
        case "Write": return <FileText className={cls} />
        case "Edit": return <Pencil className={cls} />
        case "Glob":
        case "Grep": return <Search className={cls} />
        case "WebFetch":
        case "web_search": return <Globe className={cls} />
        default: return <Code className={cls} />
    }
}

// ---------------------------------------------------------------------------
// Generic tool-result panel (fallback for unknown tools)
// ---------------------------------------------------------------------------

function GenericToolResultPanel({ artifact, onClose }: { artifact: ToolResultArtifact; onClose: () => void }) {
    return (
        <PanelShell>
            <PanelHeader
                icon={artifact.success
                    ? <Code className="size-4 text-muted-foreground" />
                    : <AlertTriangle className="size-4 text-destructive" />}
                title={artifact.title}
                subtitle={
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground uppercase tracking-wider">
                        {artifact.toolName}
                    </span>
                }
                actions={
                    <>
                        <CopyButton text={artifact.resultJson} />
                        <CloseButton onClose={onClose} />
                    </>
                }
            />
            <div className="flex-1 overflow-auto bg-white dark:bg-card">
                <HighlightedCode code={artifact.resultJson} language="json" />
            </div>
        </PanelShell>
    )
}

// ---------------------------------------------------------------------------
// Public ArtifactPanel — dispatches by kind
// ---------------------------------------------------------------------------

interface ArtifactPanelProps {
    artifact: ArtifactPayload
    onClose: () => void
}

export function ArtifactPanel({ artifact, onClose }: ArtifactPanelProps) {
    if (artifact.kind === "tool-result") {
        if (artifact.toolName === "read_file" || artifact.toolName === "Read") return <ReadFileResultPanel artifact={artifact} onClose={onClose} />
        if (artifact.toolName === "list_dir") return <ListDirResultPanel artifact={artifact} onClose={onClose} />
        if (artifact.toolName === "Bash" || artifact.toolName === "shell") return <BashResultPanel artifact={artifact} onClose={onClose} />
        if (["Write", "Edit", "Glob", "Grep", "WebFetch", "web_search"].includes(artifact.toolName)) {
            return <StructuredToolResultPanel artifact={artifact} onClose={onClose} />
        }
        return <GenericToolResultPanel artifact={artifact} onClose={onClose} />
    }
    return <CodeBlockPanel artifact={artifact} onClose={onClose} />
}

// ---------------------------------------------------------------------------
// ArtifactCard (clickable card shown inside an assistant message)
// ---------------------------------------------------------------------------

interface ArtifactCardProps {
    title: string
    language: string
    onClick: () => void
}

export function ArtifactCard({ title, language, onClick }: ArtifactCardProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex items-center gap-3 w-full rounded-lg border border-border/60 px-3 py-2.5 hover:bg-muted/30 transition-colors text-left mt-3"
        >
            <div className="flex items-center justify-center size-9 rounded-md bg-muted/50 shrink-0">
                <Code className="size-4 text-muted-foreground" />
            </div>
            <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium truncate">{title}</span>
                <span className="text-xs text-muted-foreground">Code · {language}</span>
            </div>
        </button>
    )
}
