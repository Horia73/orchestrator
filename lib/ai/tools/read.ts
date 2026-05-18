import fs from 'fs'
import path from 'path'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { resolveSandboxed, displayPath, isInsideProtectedAgentPath, protectedAgentPathError } from './sandbox'
import { clamp, isProbablyBinary, numberArg, stringArg, truncateText } from './helpers'

const MAX_TEXT_CHARS = 120_000
const MAX_PDF_PAGES = 50

export const readTool: ToolDef = {
    id: 'Read',
    name: 'Read',
    description: 'Reads a file inside the agent workspace. Text files support 1-based line offset and limit. PDF files support optional 1-based pages/ranges such as "1-3,5".',
    input_schema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path to read, relative to the workspace root. Absolute paths are accepted only inside the workspace.',
            },
            file_path: {
                type: 'string',
                description: 'Alias for path, accepted for legacy CLI compatibility.',
            },
            offset: {
                type: 'integer',
                description: '1-based text line number to start from. Ignored for PDFs.',
            },
            limit: {
                type: 'integer',
                description: 'Number of text lines to return. Ignored for PDFs.',
            },
            pages: {
                type: 'string',
                description: 'PDF page selection, e.g. "1", "1-3", or "1,3-5". Omit to read from the first pages up to the page cap.',
            },
        },
    },
    tags: ['read', 'filesystem'],
}

export async function executeRead(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = stringArg(args, ['path', 'file_path'])
    if (!filePath) return { success: false, error: 'Missing required parameter: path' }

    const sandboxed = resolveSandboxed(filePath)
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }

    const resolved = sandboxed.resolved
    if (isInsideProtectedAgentPath(resolved)) {
        return { success: false, error: protectedAgentPathError(resolved) }
    }

    try {
        if (!fs.existsSync(resolved)) return { success: false, error: `File not found: ${displayPath(resolved)}` }
        const stat = fs.statSync(resolved)
        if (!stat.isFile()) return { success: false, error: `Not a file: ${displayPath(resolved)}` }

        if (isPdf(resolved)) {
            return await readPdf(resolved, stringArg(args, ['pages']))
        }

        const buffer = fs.readFileSync(resolved)
        if (isProbablyBinary(buffer)) {
            return { success: false, error: `Binary file cannot be read as text: ${displayPath(resolved)}` }
        }

        const raw = buffer.toString('utf-8')
        const allLines = raw.split('\n')
        const offset = clamp(Math.floor(numberArg(args, ['offset'], 1)), 1, Math.max(1, allLines.length))
        const defaultLimit = allLines.length - offset + 1
        const limit = clamp(Math.floor(numberArg(args, ['limit'], defaultLimit)), 1, allLines.length)
        const startIdx = offset - 1
        const selected = allLines.slice(startIdx, startIdx + limit)
        const numbered = selected.map((line, i) => `${String(startIdx + i + 1).padStart(6)}  ${line}`)
        const truncated = truncateText(numbered.join('\n'), MAX_TEXT_CHARS)

        return {
            success: true,
            data: {
                path: displayPath(resolved),
                content: truncated.text,
                totalLines: allLines.length,
                linesReturned: selected.length,
                startLine: offset,
                ...(truncated.truncated ? { truncated: true } : {}),
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error reading file' }
    }
}

function isPdf(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.pdf'
}

async function readPdf(filePath: string, pagesArg: string): Promise<ToolResult> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(fs.readFileSync(filePath))
    const loadingTask = pdfjs.getDocument({ data } as Parameters<typeof pdfjs.getDocument>[0])
    const pdf = await loadingTask.promise
    const pageNumbers = parsePages(pagesArg, pdf.numPages)
    const chunks: string[] = []

    for (const pageNo of pageNumbers) {
        const page = await pdf.getPage(pageNo)
        const textContent = await page.getTextContent()
        const text = textContent.items
            .map((item: unknown) => {
                const record = item as { str?: unknown }
                return typeof record.str === 'string' ? record.str : ''
            })
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
        chunks.push(`--- Page ${pageNo} ---\n${text}`)
    }

    await loadingTask.destroy()
    const truncated = truncateText(chunks.join('\n\n'), MAX_TEXT_CHARS)
    return {
        success: true,
        data: {
            path: displayPath(filePath),
            content: truncated.text,
            totalPages: pdf.numPages,
            pagesReturned: pageNumbers,
            ...(truncated.truncated ? { truncated: true } : {}),
        },
    }
}

function parsePages(input: string, totalPages: number): number[] {
    if (!input.trim()) {
        return Array.from({ length: Math.min(totalPages, MAX_PDF_PAGES) }, (_, i) => i + 1)
    }

    const out = new Set<number>()
    for (const part of input.split(',')) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
        if (range) {
            const start = clamp(Number(range[1]), 1, totalPages)
            const end = clamp(Number(range[2]), 1, totalPages)
            for (let n = Math.min(start, end); n <= Math.max(start, end); n++) out.add(n)
            continue
        }
        const page = Number(trimmed)
        if (Number.isInteger(page)) out.add(clamp(page, 1, totalPages))
    }

    return Array.from(out).sort((a, b) => a - b).slice(0, MAX_PDF_PAGES)
}
