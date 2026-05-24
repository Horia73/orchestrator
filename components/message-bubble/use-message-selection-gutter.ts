"use client"

import * as React from "react"

const MESSAGE_SELECTION_GUTTER_PX = 64
const INTERACTIVE_SELECTION_TARGET =
    'a,button,input,textarea,select,summary,[role="button"],[contenteditable="true"]'

type CaretBoundary = {
    node: Node
    offset: number
}

type CaretPointDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node | null; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
}

function rootContainsNode(root: HTMLElement, node: Node): boolean {
    if (node === root) return true
    const owner = node.nodeType === Node.ELEMENT_NODE
        ? node
        : (node as ChildNode).parentElement
    return owner ? root.contains(owner) : false
}

function getCaretBoundaryAtPoint(root: HTMLElement, x: number, y: number): CaretBoundary | null {
    const doc = root.ownerDocument as CaretPointDocument
    const position = doc.caretPositionFromPoint?.(x, y)
    if (position?.offsetNode && rootContainsNode(root, position.offsetNode)) {
        return { node: position.offsetNode, offset: position.offset }
    }

    const range = doc.caretRangeFromPoint?.(x, y)
    if (range && rootContainsNode(root, range.startContainer)) {
        return { node: range.startContainer, offset: range.startOffset }
    }

    return null
}

function getLineStartBoundary(root: HTMLElement, contentLeft: number, y: number): CaretBoundary | null {
    const direct = getCaretBoundaryAtPoint(root, contentLeft + 1, y)
    if (direct) return direct

    const doc = root.ownerDocument
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let best: { x: number; y: number; distance: number } | null = null

    while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.textContent?.trim()) continue

        const range = doc.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
            if (rect.width <= 0 || rect.height <= 0) continue
            const distance = y < rect.top
                ? rect.top - y
                : y > rect.bottom
                    ? y - rect.bottom
                    : 0
            if (distance > Math.max(10, rect.height / 2)) continue
            if (best && distance >= best.distance) continue
            best = {
                x: Math.max(rect.left + 1, contentLeft + 1),
                y: Math.min(Math.max(y, rect.top + 1), rect.bottom - 1),
                distance,
            }
        }
    }

    return best ? getCaretBoundaryAtPoint(root, best.x, best.y) : null
}

function boundaryIsBefore(a: CaretBoundary, b: CaretBoundary): boolean {
    if (a.node === b.node) return a.offset < b.offset
    return Boolean(a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING)
}

function applySelection(root: HTMLElement, anchor: CaretBoundary, focus: CaretBoundary): void {
    const selection = root.ownerDocument.getSelection()
    if (!selection) return

    selection.removeAllRanges()
    const collapsed = root.ownerDocument.createRange()
    collapsed.setStart(anchor.node, anchor.offset)
    collapsed.collapse(true)
    selection.addRange(collapsed)

    if (typeof selection.extend === "function") {
        try {
            selection.extend(focus.node, focus.offset)
            return
        } catch {
            selection.removeAllRanges()
        }
    }

    const range = root.ownerDocument.createRange()
    if (boundaryIsBefore(focus, anchor)) {
        range.setStart(focus.node, focus.offset)
        range.setEnd(anchor.node, anchor.offset)
    } else {
        range.setStart(anchor.node, anchor.offset)
        range.setEnd(focus.node, focus.offset)
    }
    selection.addRange(range)
}

export function useMessageSelectionGutter() {
    const rootRef = React.useRef<HTMLDivElement>(null)

    const handlePointerDownCapture = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || event.pointerType === "touch") return
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

        const root = rootRef.current
        if (!root) return

        const target = event.target instanceof Element ? event.target : null
        if (target?.closest(INTERACTIVE_SELECTION_TARGET)) return

        const rect = root.getBoundingClientRect()
        const contentLeft = rect.left + MESSAGE_SELECTION_GUTTER_PX
        const inVerticalBounds = event.clientY >= rect.top && event.clientY <= rect.bottom
        const inSelectionGutter = event.clientX >= rect.left && event.clientX < contentLeft
        if (!inVerticalBounds || !inSelectionGutter) return

        const anchor = getLineStartBoundary(root, contentLeft, event.clientY)
        if (!anchor) return

        event.preventDefault()
        event.stopPropagation()

        const doc = root.ownerDocument
        const view = doc.defaultView

        const updateFocus = (clientX: number, clientY: number) => {
            const x = Math.max(clientX, contentLeft + 1)
            const focus =
                getCaretBoundaryAtPoint(root, x, clientY) ??
                getLineStartBoundary(root, contentLeft, clientY)
            if (!focus) return
            applySelection(root, anchor, focus)
        }

        updateFocus(contentLeft + 1, event.clientY)

        const handlePointerMove = (moveEvent: PointerEvent) => {
            moveEvent.preventDefault()
            updateFocus(moveEvent.clientX, moveEvent.clientY)
        }
        const cleanup = () => {
            view?.removeEventListener("pointermove", handlePointerMove)
            view?.removeEventListener("pointerup", cleanup)
            view?.removeEventListener("pointercancel", cleanup)
            try {
                root.releasePointerCapture(event.pointerId)
            } catch {
                // Pointer capture may already be released by the browser.
            }
        }

        try {
            root.setPointerCapture(event.pointerId)
        } catch {
            // Pointer capture is an enhancement; document listeners still handle the drag.
        }
        view?.addEventListener("pointermove", handlePointerMove, { passive: false })
        view?.addEventListener("pointerup", cleanup)
        view?.addEventListener("pointercancel", cleanup)
    }, [])

    return { rootRef, handlePointerDownCapture }
}
