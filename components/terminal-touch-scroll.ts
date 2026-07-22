import type { Terminal } from "@xterm/xterm"

const AXIS_LOCK_THRESHOLD_PX = 4
const FALLBACK_ROW_HEIGHT_PX = 16

/**
 * Add vertical touch scrolling to xterm 6's custom viewport. Its screen and
 * scrollbar are siblings rather than a native overflow hierarchy, so mobile
 * browsers cannot discover a scrollable ancestor from a touch on the canvas.
 * Wheel input is handled by xterm itself; this fills only the touch gap.
 */
export function enableTerminalTouchScroll(
  terminal: Terminal,
  container: HTMLElement
): () => void {
  let touchId: number | null = null
  let lastX = 0
  let lastY = 0
  let pendingPixels = 0
  let undecidedX = 0
  let undecidedY = 0
  let axis: "x" | "y" | null = null
  let terminalOwnsGesture = false

  const reset = () => {
    touchId = null
    pendingPixels = 0
    undecidedX = 0
    undecidedY = 0
    axis = null
    terminalOwnsGesture = false
  }

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      reset()
      return
    }
    const touch = event.touches[0]
    touchId = touch.identifier
    lastX = touch.clientX
    lastY = touch.clientY
    pendingPixels = 0
    undecidedX = 0
    undecidedY = 0
    axis = null
    terminalOwnsGesture = false
  }

  const handleTouchMove = (event: TouchEvent) => {
    if (touchId === null) return
    const touch = findTouch(event.touches, touchId)
    if (!touch) return

    const deltaX = lastX - touch.clientX
    const deltaY = lastY - touch.clientY
    lastX = touch.clientX
    lastY = touch.clientY

    let scrollDelta = deltaY
    if (axis === null) {
      undecidedX += deltaX
      undecidedY += deltaY
      if (
        Math.max(Math.abs(undecidedX), Math.abs(undecidedY)) <
        AXIS_LOCK_THRESHOLD_PX
      ) {
        return
      }
      axis = Math.abs(undecidedY) >= Math.abs(undecidedX) ? "y" : "x"
      scrollDelta = undecidedY
    }
    if (axis === "x") return

    const buffer = terminal.buffer.active
    const canScroll =
      scrollDelta < 0
        ? buffer.viewportY > 0
        : scrollDelta > 0 && buffer.viewportY < buffer.baseY

    if (!canScroll) {
      // Keep a gesture which started inside the terminal latched there, but let
      // a fresh gesture at an edge scroll the surrounding chat normally.
      if (terminalOwnsGesture && event.cancelable) event.preventDefault()
      return
    }

    terminalOwnsGesture = true
    if (event.cancelable) event.preventDefault()
    pendingPixels += scrollDelta

    const rowHeight = terminalRowHeight(container, terminal.rows)
    const lines =
      pendingPixels > 0
        ? Math.floor(pendingPixels / rowHeight)
        : Math.ceil(pendingPixels / rowHeight)
    if (lines === 0) return

    terminal.scrollLines(lines)
    pendingPixels -= lines * rowHeight
  }

  container.addEventListener("touchstart", handleTouchStart, { passive: true })
  container.addEventListener("touchmove", handleTouchMove, { passive: false })
  container.addEventListener("touchend", reset, { passive: true })
  container.addEventListener("touchcancel", reset, { passive: true })

  return () => {
    container.removeEventListener("touchstart", handleTouchStart)
    container.removeEventListener("touchmove", handleTouchMove)
    container.removeEventListener("touchend", reset)
    container.removeEventListener("touchcancel", reset)
  }
}

function findTouch(touches: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index)
    if (touch?.identifier === identifier) return touch
  }
  return null
}

function terminalRowHeight(container: HTMLElement, rows: number): number {
  const screenHeight = container
    .querySelector<HTMLElement>(".xterm-screen")
    ?.getBoundingClientRect().height
  if (!screenHeight || rows <= 0) return FALLBACK_ROW_HEIGHT_PX
  return screenHeight / rows
}
