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

/** Markdown renders GitHub-style (typeset prose) in the dedicated MarkdownViewer,
 *  with a toggle back to the raw source. `.mdx` deliberately stays in the code
 *  viewer — its JSX is code, not something react-markdown would render usefully. */
export function isMarkdownFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    const e = ext(att.filename)
    if (e === "md" || e === "markdown") return true
    const m = att.mimeType.toLowerCase()
    return m === "text/markdown" || m === "text/x-markdown"
}

/** Excel / tabular. Matched by extension + MIME (NOT the stored Attachment.type)
 *  so files uploaded before office types existed still route correctly. */
export function isSpreadsheetFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    const e = ext(att.filename)
    if (e === "xlsx" || e === "xls" || e === "csv" || e === "tsv") return true
    const m = att.mimeType.toLowerCase()
    return m.includes("spreadsheetml") || m === "application/vnd.ms-excel" || m === "text/csv"
}

/** PowerPoint. Extension + MIME so legacy uploads (stored type "other") route
 *  to the slide viewer; .ppt is handled by the same server-side conversion. */
export function isPresentationFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    const e = ext(att.filename)
    if (e === "pptx" || e === "ppt") return true
    const m = att.mimeType.toLowerCase()
    return m.includes("presentationml") || m === "application/vnd.ms-powerpoint"
}

/** HTML documents are previewable as pages, but still served as safe text from
 *  the generic file API. Dedicated viewers decide whether to render a static
 *  sandboxed page or show source. */
export function isHtmlFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    const e = ext(att.filename)
    if (e === "html" || e === "htm" || e === "xhtml") return true
    const m = att.mimeType.toLowerCase()
    return m === "text/html" || m === "application/xhtml+xml"
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

/** 3D model files the in-app three.js viewer can render (CAD outputs,
 *  printables). STEP stays download-only — no client-side B-rep tessellation. */
export function is3DModelFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    const e = ext(att.filename)
    if (e === "glb" || e === "stl" || e === "3mf") return true
    const m = att.mimeType.toLowerCase()
    return m === "model/gltf-binary" || m === "model/stl" || m === "model/3mf"
}

/** Whether a file should open in the syntax-highlighted code/text viewer.
 *  True for text/* and json/xml MIME, or any known source extension. */
export function isCodeOrTextFile(att: Pick<Attachment, "filename" | "mimeType">): boolean {
    // Office OOXML containers are ZIPs whose MIME contains "xml" (openXMLformats)
    // — exclude them so they never fall into the code viewer as raw ZIP bytes.
    if (isDocxFile(att) || isSpreadsheetFile(att) || isPresentationFile(att) || isHtmlFile(att)) return false
    // Markdown gets the rendered MarkdownViewer (it exposes its own source toggle),
    // so keep it out of the plain code viewer even though `md` is a known grammar.
    if (isMarkdownFile(att)) return false
    const mime = att.mimeType.toLowerCase()
    if (mime.startsWith("text/")) return true
    if (mime.includes("json") || mime.includes("xml")) return true
    return ext(att.filename) in EXT_LANG
}

/** Whether a file opens in the in-app preview modal (vs. download-only). */
export function isInAppPreviewable(att: Pick<Attachment, "filename" | "mimeType" | "type">): boolean {
    if (att.type === "image" || att.type === "video" || att.type === "pdf") return true
    return (
        isSpreadsheetFile(att) ||
        isPresentationFile(att) ||
        isDocxFile(att) ||
        isHtmlFile(att) ||
        isSvgFile(att) ||
        isMarkdownFile(att) ||
        is3DModelFile(att) ||
        isCodeOrTextFile(att)
    )
}
