"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * Minimal CSV renderer. The model produces clean CSV (it's a smart LLM, not a
 * malformed export), so we parse with a small dialect-aware splitter rather
 * than pulling in PapaParse. Handles quoted fields with commas / newlines /
 * embedded quotes; that's enough for everything an artifact will plausibly
 * carry.
 *
 * For huge files we'd virtualize the rows, but in practice an inline CSV
 * artifact tops out at a few hundred rows — vanilla rendering is fine.
 */
export function CsvRenderer({ source, className }: { source: string; className?: string }) {
    const rows = React.useMemo(() => parseCsv(source.trim()), [source])
    if (rows.length === 0) {
        return <p className={cn("text-[12.5px] text-foreground/55", className)}>(empty CSV)</p>
    }
    const [header, ...body] = rows
    return (
        <div className={cn("overflow-x-auto rounded-lg border border-border/60", className)}>
            <table className="min-w-full border-collapse text-[13px]">
                <thead className="bg-muted/40">
                    <tr>
                        {header.map((cell, i) => (
                            <th key={i} className="border-b border-border/60 px-3 py-2 text-left font-medium text-foreground/80">
                                {cell}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {body.map((row, ri) => (
                        <tr key={ri} className="even:bg-muted/15">
                            {row.map((cell, ci) => (
                                <td key={ci} className="border-b border-border/30 px-3 py-1.5 tabular-nums text-foreground/85">
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/** Tiny CSV parser. Handles "..." quotes with "" escapes, commas + newlines inside quotes. */
function parseCsv(input: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ""
    let i = 0
    let inQuotes = false
    while (i < input.length) {
        const ch = input[i]
        if (inQuotes) {
            if (ch === '"') {
                if (input[i + 1] === '"') {
                    field += '"'
                    i += 2
                    continue
                }
                inQuotes = false
                i++
                continue
            }
            field += ch
            i++
            continue
        }
        if (ch === '"') {
            inQuotes = true
            i++
            continue
        }
        if (ch === ",") {
            row.push(field)
            field = ""
            i++
            continue
        }
        if (ch === "\n" || ch === "\r") {
            row.push(field)
            rows.push(row)
            field = ""
            row = []
            i++
            // Eat \r\n as a single newline.
            if (ch === "\r" && input[i] === "\n") i++
            continue
        }
        field += ch
        i++
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field)
        rows.push(row)
    }
    return rows
}
