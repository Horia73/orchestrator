"use client"

import * as React from "react"
import { Loader2, AlertTriangle, Table2 } from "lucide-react"
import type { Workbook, Worksheet, Cell as ExcelCell } from "exceljs"
import { ViewerFrame, ViewerToolbar, FormatBadge } from "@/components/office/viewer-chrome"
import { cn } from "@/lib/utils"

const ROW_CAP = 500
const MAX_COLS = 120

type GridCell = { text: string; style?: React.CSSProperties; colSpan?: number; rowSpan?: number }
type SheetModel = {
    name: string
    colCount: number
    colWidths: number[]
    rows: (GridCell | null)[][]
    totalRows: number
    truncated: boolean
}

// --- address helpers -------------------------------------------------------
const cellKey = (r: number, c: number) => `${r}:${c}`
function colToNum(letters: string): number {
    let n = 0
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64)
    return n
}
function numToCol(n: number): string {
    let s = ""
    while (n > 0) {
        const m = (n - 1) % 26
        s = String.fromCharCode(65 + m) + s
        n = Math.floor((n - 1) / 26)
    }
    return s
}
function parseAddr(a: string): { r: number; c: number } | null {
    const m = /^([A-Za-z]+)(\d+)$/.exec(a.trim())
    if (!m) return null
    return { c: colToNum(m[1].toUpperCase()), r: parseInt(m[2], 10) }
}

// --- value + style extraction ----------------------------------------------
function argbToCss(argb?: string): string | undefined {
    if (!argb || argb.length < 6) return undefined
    const hex = argb.length === 8 ? argb.slice(2) : argb
    if (argb.length === 8) {
        const a = parseInt(argb.slice(0, 2), 16) / 255
        if (a < 1) {
            const r = parseInt(hex.slice(0, 2), 16)
            const g = parseInt(hex.slice(2, 4), 16)
            const b = parseInt(hex.slice(4, 6), 16)
            return `rgba(${r},${g},${b},${a.toFixed(2)})`
        }
    }
    return `#${hex}`
}

type NumFmt = { format: (pattern: string, value: unknown) => string }

function fmt(numFmt: string | undefined, val: number | Date, numfmt: NumFmt): string {
    if (!numFmt) return val instanceof Date ? val.toISOString().slice(0, 10) : String(val)
    try {
        return numfmt.format(numFmt, val)
    } catch {
        return val instanceof Date ? val.toISOString().slice(0, 10) : String(val)
    }
}

function resolveCell(cell: ExcelCell, numfmt: NumFmt): { text: string; numeric: boolean } {
    const v = cell.value as unknown
    if (v == null) return { text: "", numeric: false }
    if (typeof v === "number") return { text: fmt(cell.numFmt, v, numfmt), numeric: true }
    if (v instanceof Date) return { text: fmt(cell.numFmt || "yyyy-mm-dd", v, numfmt), numeric: true }
    if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE", numeric: false }
    if (typeof v === "string") return { text: v, numeric: false }
    if (typeof v === "object") {
        const o = v as Record<string, unknown>
        if ("formula" in o || "sharedFormula" in o) {
            const res = o.result
            if (res == null) return { text: "", numeric: false }
            if (res instanceof Date) return { text: fmt(cell.numFmt || "yyyy-mm-dd", res, numfmt), numeric: true }
            if (typeof res === "number") return { text: fmt(cell.numFmt, res, numfmt), numeric: true }
            if (typeof res === "object" && res && "error" in res) return { text: String((res as { error: unknown }).error), numeric: false }
            return { text: String(res), numeric: false }
        }
        if ("richText" in o) return { text: (o.richText as { text: string }[]).map((t) => t.text).join(""), numeric: false }
        if ("text" in o && "hyperlink" in o) return { text: String(o.text), numeric: false }
        if ("error" in o) return { text: String(o.error), numeric: false }
    }
    return { text: cell.text ? String(cell.text) : "", numeric: false }
}

function cellStyle(cell: ExcelCell, numeric: boolean): React.CSSProperties | undefined {
    const s: React.CSSProperties = {}
    const f = cell.font
    if (f) {
        if (f.bold) s.fontWeight = 600
        if (f.italic) s.fontStyle = "italic"
        if (f.underline) s.textDecoration = "underline"
        if (f.size) s.fontSize = `${(f.size / 11) * 12}px`
        if (f.name) s.fontFamily = `${f.name}, sans-serif`
        const c = argbToCss(f.color?.argb)
        if (c) s.color = c
    }
    const fill = cell.fill
    if (fill && fill.type === "pattern" && fill.pattern === "solid") {
        const bg = argbToCss((fill.fgColor as { argb?: string } | undefined)?.argb)
        if (bg) s.backgroundColor = bg
    }
    const a = cell.alignment
    if (a?.horizontal) s.textAlign = a.horizontal as React.CSSProperties["textAlign"]
    else if (numeric) s.textAlign = "right"
    if (a?.vertical) s.verticalAlign = a.vertical === "middle" ? "middle" : a.vertical
    if (a?.wrapText) s.whiteSpace = "pre-wrap"
    return Object.keys(s).length ? s : undefined
}

function buildSheetModel(ws: Worksheet, numfmt: NumFmt): SheetModel {
    const colCount = Math.min(Math.max(ws.actualColumnCount || 0, 1), MAX_COLS)
    const totalRows = Math.max(ws.actualRowCount || 0, 0)
    const rowCount = Math.min(totalRows, ROW_CAP)

    let merges: string[] = []
    try {
        merges = (ws.model?.merges as string[] | undefined) ?? []
    } catch {
        merges = []
    }
    const span = new Map<string, { rowSpan: number; colSpan: number }>()
    const covered = new Set<string>()
    for (const range of merges) {
        const [a, b] = range.split(":")
        if (!a || !b) continue
        const A = parseAddr(a)
        const B = parseAddr(b)
        if (!A || !B) continue
        span.set(cellKey(A.r, A.c), { rowSpan: B.r - A.r + 1, colSpan: B.c - A.c + 1 })
        for (let r = A.r; r <= B.r; r++) {
            for (let c = A.c; c <= B.c; c++) {
                if (!(r === A.r && c === A.c)) covered.add(cellKey(r, c))
            }
        }
    }

    const colWidths: number[] = []
    for (let c = 1; c <= colCount; c++) {
        const w = ws.getColumn(c).width
        colWidths.push(w ? Math.min(480, Math.max(32, Math.round(w * 7 + 5))) : 84)
    }

    const rows: (GridCell | null)[][] = []
    for (let r = 1; r <= rowCount; r++) {
        const row: (GridCell | null)[] = []
        for (let c = 1; c <= colCount; c++) {
            if (covered.has(cellKey(r, c))) {
                row.push(null)
                continue
            }
            const cell = ws.getCell(r, c)
            const { text, numeric } = resolveCell(cell, numfmt)
            const sp = span.get(cellKey(r, c))
            row.push({ text, style: cellStyle(cell, numeric), colSpan: sp?.colSpan, rowSpan: sp?.rowSpan })
        }
        rows.push(row)
    }
    return { name: ws.name, colCount, colWidths, rows, totalRows, truncated: totalRows > rowCount }
}

// --- CSV / TSV -------------------------------------------------------------
function parseDelimited(text: string, delim: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ""
    let inQ = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (inQ) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"'
                    i++
                } else inQ = false
            } else field += ch
            continue
        }
        // Only a quote at the *start* of a field opens a quoted field; a stray
        // quote mid-field (e.g. 12" monitor) is kept literal so it can't hijack
        // delimiter/newline handling for the rest of the row.
        if (ch === '"' && field === "") inQ = true
        else if (ch === delim) {
            row.push(field)
            field = ""
        } else if (ch === "\n") {
            row.push(field)
            field = ""
            rows.push(row)
            row = []
        } else if (ch === "\r") {
            // swallow; \r\n handled by the \n branch
        } else field += ch
    }
    row.push(field)
    if (row.length > 1 || row[0] !== "") rows.push(row)
    return rows
}

function csvToModel(rows: string[][], name: string): SheetModel {
    const totalRows = rows.length
    const shown = rows.slice(0, ROW_CAP)
    const colCount = Math.min(Math.max(1, ...shown.map((r) => r.length)), MAX_COLS)
    const model: (GridCell | null)[][] = shown.map((r) => {
        const out: (GridCell | null)[] = []
        for (let c = 0; c < colCount; c++) out.push({ text: r[c] ?? "" })
        return out
    })
    return {
        name,
        colCount,
        colWidths: Array.from({ length: colCount }, () => 140),
        rows: model,
        totalRows,
        truncated: totalRows > ROW_CAP,
    }
}

// --- component -------------------------------------------------------------
type Source =
    | { kind: "xlsx"; wb: Workbook; numfmt: NumFmt }
    | { kind: "csv"; rows: string[][] }

export function SpreadsheetViewer({
    url,
    filename,
    mimeType,
    onClose,
}: {
    url: string
    filename: string
    mimeType: string
    onClose: () => void
}) {
    const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
    const [errorMsg, setErrorMsg] = React.useState<string | null>(null)
    const [source, setSource] = React.useState<Source | null>(null)
    const [sheetNames, setSheetNames] = React.useState<string[]>([])
    const [active, setActive] = React.useState(0)

    const ext = filename.toLowerCase().split(".").pop() ?? ""
    const isCsv = ext === "csv" || ext === "tsv" || mimeType === "text/csv"

    React.useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                if (ext === "xls") {
                    // Legacy BIFF binary — ExcelJS only reads OOXML .xlsx.
                    if (!cancelled) {
                        setErrorMsg("Legacy .xls files can't be previewed yet — download to open.")
                        setStatus("error")
                    }
                    return
                }
                const res = await fetch(url)
                if (!res.ok) throw new Error(`fetch ${res.status}`)
                if (isCsv) {
                    const text = await res.text()
                    if (cancelled) return
                    const rows = parseDelimited(text, ext === "tsv" ? "\t" : ",")
                    setSource({ kind: "csv", rows })
                    setSheetNames([filename])
                    setStatus("ready")
                    return
                }
                const buf = await res.arrayBuffer()
                if (cancelled) return
                const exceljsMod = (await import("exceljs")) as unknown as { default?: { Workbook: new () => Workbook }; Workbook?: new () => Workbook }
                const numfmtMod = (await import("numfmt")) as unknown as { format?: NumFmt["format"]; default?: NumFmt }
                const numfmt = (numfmtMod.format ? (numfmtMod as unknown as NumFmt) : numfmtMod.default!) as NumFmt
                const ExcelJS = exceljsMod.default ?? exceljsMod
                const WorkbookCtor = ExcelJS.Workbook!
                const wb = new WorkbookCtor()
                await wb.xlsx.load(buf)
                if (cancelled) return
                const names = wb.worksheets.map((w) => w.name)
                if (names.length === 0) throw new Error("no sheets")
                setSource({ kind: "xlsx", wb, numfmt })
                setSheetNames(names)
                setStatus("ready")
            } catch (err) {
                console.error("Spreadsheet preview failed:", err)
                if (!cancelled) {
                    setErrorMsg(null)
                    setStatus("error")
                }
            }
        }
        load()
        return () => {
            cancelled = true
        }
    }, [url, filename, ext, isCsv])

    const model = React.useMemo<SheetModel | null>(() => {
        if (!source) return null
        try {
            if (source.kind === "csv") return csvToModel(source.rows, filename)
            const ws = source.wb.worksheets[active]
            if (!ws) return null
            return buildSheetModel(ws, source.numfmt)
        } catch (err) {
            console.error("Sheet model build failed:", err)
            return null
        }
    }, [source, active, filename])

    return (
        <ViewerFrame>
            <ViewerToolbar
                icon={<Table2 className="size-4 shrink-0 text-pdf-text-muted" />}
                filename={filename}
                badge={<FormatBadge label={ext === "tsv" ? "TSV" : isCsv ? "CSV" : ext.toUpperCase() || "XLSX"} />}
                downloadUrl={url}
                downloadName={filename}
                onClose={onClose}
            >
                {model?.truncated ? (
                    <span className="mr-1 hidden rounded bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300 sm:inline">
                        {ROW_CAP} of {model.totalRows} rows
                    </span>
                ) : null}
            </ViewerToolbar>

            <div className="relative min-h-0 flex-1 bg-white">
                {status === "loading" ? (
                    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                        <Loader2 className="mr-2 size-5 animate-spin" />
                        Loading spreadsheet…
                    </div>
                ) : status === "error" ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-neutral-500">
                        <AlertTriangle className="size-7 text-amber-500" />
                        <p className="text-sm text-neutral-700">{errorMsg ?? "This spreadsheet couldn't be previewed."}</p>
                        <a href={url} download={filename} className="text-sm text-blue-600 underline underline-offset-2 hover:text-blue-700">
                            Download {filename}
                        </a>
                    </div>
                ) : model ? (
                    <SheetGrid model={model} />
                ) : null}
            </div>

            {sheetNames.length > 1 ? (
                <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-pdf-border bg-pdf-toolbar px-2 py-1.5">
                    {sheetNames.map((name, i) => (
                        <button
                            key={`${name}-${i}`}
                            type="button"
                            onClick={() => setActive(i)}
                            className={cn(
                                "shrink-0 rounded px-2.5 py-1 text-xs transition-colors",
                                i === active
                                    ? "bg-white text-neutral-900"
                                    : "text-pdf-text-muted hover:bg-pdf-hover hover:text-white"
                            )}
                            title={name}
                        >
                            {name}
                        </button>
                    ))}
                </div>
            ) : null}
        </ViewerFrame>
    )
}

function SheetGrid({ model }: { model: SheetModel }) {
    return (
        <div className="absolute inset-0 overflow-auto" style={{ overscrollBehavior: "contain" }}>
            <table className="border-collapse text-[12px] text-neutral-800" style={{ tableLayout: "fixed" }}>
                <colgroup>
                    <col style={{ width: 46 }} />
                    {model.colWidths.map((w, i) => (
                        <col key={i} style={{ width: w }} />
                    ))}
                </colgroup>
                <thead>
                    <tr>
                        <th className="sticky left-0 top-0 z-30 border border-neutral-300 bg-neutral-100" />
                        {Array.from({ length: model.colCount }, (_, i) => (
                            <th
                                key={i}
                                className="sticky top-0 z-20 border border-neutral-300 bg-neutral-100 px-1.5 py-1 text-center text-[11px] font-medium text-neutral-500"
                            >
                                {numToCol(i + 1)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {model.rows.map((row, r) => (
                        <tr key={r}>
                            <th className="sticky left-0 z-10 border border-neutral-300 bg-neutral-100 px-1.5 py-1 text-center text-[11px] font-medium text-neutral-500">
                                {r + 1}
                            </th>
                            {row.map((cell, c) =>
                                cell === null ? null : (
                                    <td
                                        key={c}
                                        colSpan={cell.colSpan}
                                        rowSpan={cell.rowSpan}
                                        className="overflow-hidden border border-neutral-200 px-1.5 py-1 align-top whitespace-nowrap"
                                        style={cell.style}
                                        title={cell.text}
                                    >
                                        {cell.text}
                                    </td>
                                )
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
