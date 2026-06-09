import * as React from "react"

const MOBILE_KEYBOARD_INSET_THRESHOLD = 80

export function isMobileKeyboardViewport() {
  if (typeof window === "undefined") return false

  const visualViewportWidth = window.visualViewport?.width
  const viewportWidth = Math.min(
    window.innerWidth,
    typeof visualViewportWidth === "number"
      ? visualViewportWidth
      : window.innerWidth
  )
  const hasTouchInput =
    navigator.maxTouchPoints > 0 ||
    window.matchMedia("(hover: none) and (pointer: coarse)").matches

  return viewportWidth < 768 || (hasTouchInput && viewportWidth < 900)
}

function readMobileKeyboardInset() {
  if (typeof window === "undefined" || !isMobileKeyboardViewport()) return 0

  const visualViewport = window.visualViewport
  if (!visualViewport) return 0

  const layoutViewportHeight = Math.max(
    window.innerHeight,
    document.documentElement.clientHeight
  )
  // Keyboard height = how much the visual viewport shrank. Deliberately ignore
  // visualViewport.offsetTop: that tracks where iOS Safari has *panned* the
  // page to keep the focused field visible, not the keyboard's size. Folding it
  // in made the inset wobble with the pan — a feedback loop (inset → input
  // transform / list margin / scroll-to-bottom → layout shift → Safari re-pans
  // → inset) that jittered the input, the message list, and the header for the
  // whole keyboard animation.
  const inset = layoutViewportHeight - visualViewport.height

  return inset > MOBILE_KEYBOARD_INSET_THRESHOLD ? Math.round(inset) : 0
}

export function useMobileKeyboardInset() {
  const [keyboardInset, setKeyboardInset] = React.useState(0)

  React.useEffect(() => {
    let frame: number | null = null

    const update = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        const nextInset = readMobileKeyboardInset()
        setKeyboardInset((currentInset) =>
          currentInset === nextInset ? currentInset : nextInset
        )
      })
    }

    update()

    const visualViewport = window.visualViewport
    visualViewport?.addEventListener("resize", update)
    visualViewport?.addEventListener("scroll", update)
    window.addEventListener("resize", update)
    window.addEventListener("orientationchange", update)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      visualViewport?.removeEventListener("resize", update)
      visualViewport?.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
      window.removeEventListener("orientationchange", update)
    }
  }, [])

  return keyboardInset
}
