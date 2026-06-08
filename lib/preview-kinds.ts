import type { Attachment } from "@/lib/types"

/**
 * Routing helpers shared by the preview modal and the attachment cards. These
 * decide which in-app viewer (if any) a non-image/video/pdf file gets, based on
 * filename + MIME — keeping that logic in one place instead of scattered regex.
 */

function ext(filename: string): string {
    const i = filename.lastIndexOf(".")
    return i >= 0 ? filename.slice(i + 1).toLowerCase() : ""
}

/** Word: only .docx renders client-side (docx-preview). Legacy .doc is binary
 *  and falls back to download (or the server PPTX/Office pipeline later). */
export function isDocxFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    return ext(att.filename) === "docx" || att.mimeType.includes("wordprocessingml")
}

/** SVG renders as a sanitized image (the file is served as text/plain). */
export function isSvgFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    return ext(att.filename) === "svg" || att.mimeType === "image/svg+xml"
}

/** Extension → Shiki language id. Covers the source/markup/config files an
 *  assistant actually receives. Anything not listed renders as plain text. */
const EXT_LANG: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
    swift: "swift", php: "php", scala: "scala", clj: "clojure", ex: "elixir", exs: "elixir",
    erl: "erlang", hs: "haskell", lua: "lua", pl: "perl", r: "r", dart: "dart", zig: "zig",
    sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell",
    sql: "sql", graphql: "graphql", gql: "graphql",
    html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less", vue: "vue", svelte: "svelte",
    json: "json", jsonc: "jsonc", json5: "json5", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
    xml: "xml", svg: "xml", env: "dotenv", dockerfile: "docker",
    md: "markdown", markdown: "markdown", mdx: "mdx", tex: "latex",
    diff: "diff", patch: "diff", log: "log", txt: "text", text: "text", csv: "csv", tsv: "text",
    proto: "proto", makefile: "makefile", gradle: "groovy", groovy: "groovy",
}

export function extToShikiLang(filename: string): string {
    const e = ext(filename)
    if (e === "" && /(^|\/)dockerfile$/i.test(filename)) return "docker"
    if (e === "" && /(^|\/)makefile$/i.test(filename)) return "makefile"
    return EXT_LANG[e] ?? "text"
}

/** Whether a file should open in the syntax-highlighted code/text viewer.
 *  True for text/* and json/xml MIME, or any known source extension. */
export function isCodeOrTextFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    if (isDocxFile(att)) return false
    const mime = att.mimeType.toLowerCase()
    if (mime.startsWith("text/")) return true
    if (mime.includes("json") || mime.includes("xml")) return true
    return ext(att.filename) in EXT_LANG
}

/** Whether a file opens in the in-app preview modal (vs. download-only). */
export function isInAppPreviewable(att: Pick<Attachment, "filename" | "mimeType" | "type">): boolean {
    if (att.type === "image" || att.type === "video" || att.type === "pdf") return true
    if (att.type === "spreadsheet" || att.type === "presentation") return true
    return isDocxFile(att) || isCodeOrTextFile(att)
}
