export async function copyTextToClipboard(text: string): Promise<boolean> {
    if (typeof window === "undefined" || typeof document === "undefined") {
        return false
    }

    const clipboard = navigator.clipboard
    if (clipboard?.writeText && window.isSecureContext) {
        try {
            await clipboard.writeText(text)
            return true
        } catch {
            // Fall through to the legacy path. LAN HTTP origins are common for this app.
        }
    }

    return copyTextWithSelectionFallback(text)
}

function copyTextWithSelectionFallback(text: string): boolean {
    const textArea = document.createElement("textarea")
    textArea.value = text
    textArea.setAttribute("readonly", "")
    textArea.style.position = "fixed"
    textArea.style.left = "0"
    textArea.style.top = "0"
    textArea.style.width = "1px"
    textArea.style.height = "1px"
    textArea.style.opacity = "0"
    textArea.style.pointerEvents = "none"
    textArea.style.zIndex = "-1"

    const selection = document.getSelection()
    const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null

    document.body.appendChild(textArea)
    try {
        textArea.focus({ preventScroll: true })
    } catch {
        textArea.focus()
    }
    textArea.select()
    textArea.setSelectionRange(0, textArea.value.length)

    let copied = false
    try {
        copied = document.execCommand("copy")
    } catch {
        copied = false
    }

    document.body.removeChild(textArea)

    if (selectedRange && selection) {
        selection.removeAllRanges()
        selection.addRange(selectedRange)
    }
    activeElement?.focus({ preventScroll: true })

    return copied
}
