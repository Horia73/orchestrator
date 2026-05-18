export interface SseEvent {
    event?: string
    data: string
}

export async function readSse(response: Response, onEvent: (event: SseEvent) => void, signal?: AbortSignal): Promise<void> {
    if (!response.body) throw new Error('Streaming response had no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
        if (signal?.aborted) {
            try { await reader.cancel() } catch { /* ignore */ }
            return
        }

        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        for (;;) {
            const boundary = findSseEventBoundary(buffer)
            if (!boundary) break
            const raw = buffer.slice(0, boundary.index)
            buffer = buffer.slice(boundary.index + boundary.length)
            const event = parseSseEvent(raw)
            if (event) onEvent(event)
        }
    }

    const tail = buffer.trim()
    if (tail) {
        const event = parseSseEvent(tail)
        if (event) onEvent(event)
    }
}

function findSseEventBoundary(buffer: string): { index: number; length: number } | null {
    const lfIndex = buffer.indexOf('\n\n')
    const crlfIndex = buffer.indexOf('\r\n\r\n')

    if (lfIndex < 0 && crlfIndex < 0) return null
    if (lfIndex < 0) return { index: crlfIndex, length: 4 }
    if (crlfIndex < 0) return { index: lfIndex, length: 2 }
    return crlfIndex < lfIndex
        ? { index: crlfIndex, length: 4 }
        : { index: lfIndex, length: 2 }
}

function parseSseEvent(raw: string): SseEvent | null {
    let event: string | undefined
    const data: string[] = []

    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) {
            event = line.slice('event:'.length).trim()
        } else if (line.startsWith('data:')) {
            data.push(line.slice('data:'.length).trimStart())
        }
    }

    if (data.length === 0) return null
    return { event, data: data.join('\n') }
}
