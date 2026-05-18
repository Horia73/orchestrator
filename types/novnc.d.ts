declare module '@novnc/novnc/core/rfb.js' {
    export default class RFB extends EventTarget {
        constructor(target: HTMLElement, url: string, options?: { credentials?: Record<string, string> })
        viewOnly: boolean
        scaleViewport: boolean
        resizeSession: boolean
        background: string
        qualityLevel: number
        compressionLevel: number
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
        disconnect(): void
    }
}
