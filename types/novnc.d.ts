declare module '@novnc/novnc/core/rfb.js' {
    export default class RFB extends EventTarget {
        constructor(target: HTMLElement, url: string, options?: { credentials?: Record<string, string> })
        viewOnly: boolean
        scaleViewport: boolean
        resizeSession: boolean
        background: string
        qualityLevel: number
        compressionLevel: number
        showDotCursor: boolean
        focus(options?: FocusOptions): void
        clipboardPasteFrom(text: string): void
        disconnect(): void
    }
}

declare module '@novnc/novnc' {
    export default class RFB extends EventTarget {
        constructor(target: HTMLElement, url: string, options?: { credentials?: Record<string, string> })
        viewOnly: boolean
        scaleViewport: boolean
        resizeSession: boolean
        background: string
        qualityLevel: number
        compressionLevel: number
        showDotCursor: boolean
        focus(options?: FocusOptions): void
        clipboardPasteFrom(text: string): void
        disconnect(): void
    }
}
