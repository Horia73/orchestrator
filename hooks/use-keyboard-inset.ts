import * as React from "react"

const MOBILE_KEYBOARD_INSET_THRESHOLD = 80

export function computeMobileKeyboardInset(
  baselineHeight: number,
  visualViewportHeight: number
) {
  if (
    !Number.isFinite(baselineHeight) ||
    !Number.isFinite(visualViewportHeight) ||
    baselineHeight <= 0 ||
    visualViewportHeight <= 0
  ) {
    return 0
  }

  const inset = baselineHeight - visualViewportHeight
  return inset > MOBILE_KEYBOARD_INSET_THRESHOLD ? Math.round(inset) : 0
}

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

function currentLayoutViewportHeight() {
  const visualViewportHeight = window.visualViewport?.height ?? 0
  return Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
    visualViewportHeight
  )
}

function readMobileKeyboardInset(baselineHeight: number) {
  if (typeof window === "undefined" || !isMobileKeyboardViewport()) return 0

  const visualViewport = window.visualViewport
  if (!visualViewport) return 0
  if (visualViewport.scale > 1.02) return 0

  // iOS is inconsistent about whether window.innerHeight/clientHeight remain
  // at the layout viewport height or shrink together with visualViewport. The
  // keyboard-closed baseline is therefore captured by the hook and retained
  // while an editable field is focused. Deliberately ignore offsetTop: it is
  // Safari's page-pan signal and feeding it back into layout makes the composer
  // wobble while the keyboard animates.
  return computeMobileKeyboardInset(baselineHeight, visualViewport.height)
}

// Focus a field without letting the browser scroll/pan the page to reveal it.
// Each surface positions its own input against the keyboard inset, so the
// browser's auto-reveal would only fight that (the iOS pan that dragged the
// header up).
export function focusWithoutViewportScroll(
  field: HTMLTextAreaElement | HTMLInputElement | null
) {
  if (!field) return

  const scrollX = window.scrollX
  const scrollY = window.scrollY

  try {
    field.focus({ preventScroll: true })
  } catch {
    field.focus()
  }

  window.requestAnimationFrame(() => {
    if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
      window.scrollTo(scrollX, scrollY)
    }
  })
}

// Last real keyboard height, remembered across focuses (and component mounts)
// for the whole session. The first focus warms it; every focus after that can
// act on it before iOS Safari has even started opening the keyboard.
let cachedKeyboardInset = 0

function isEditableElement(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  const tag = node.tagName
  return tag === "TEXTAREA" || tag === "INPUT" || node.isContentEditable
}

export function useMobileKeyboardInset() {
  const [keyboardInset, setKeyboardInset] = React.useState(0)

  React.useEffect(() => {
    let frame: number | null = null
    let baselineHeight = currentLayoutViewportHeight()
    // Non-zero between a focus and the moment the visual viewport actually
    // shrinks. iOS Safari fills that gap by *panning* the whole page to reveal
    // the focused field; by reporting the cached height immediately we let each
    // surface pre-position its input first, so Safari has nothing to pan and the
    // reactive race (the jitter) never starts.
    let predictedInset = 0
    let predictionTimer: number | null = null

    const apply = (value: number) =>
      setKeyboardInset((current) => (current === value ? current : value))

    const clearPrediction = () => {
      predictedInset = 0
      if (predictionTimer !== null) {
        window.clearTimeout(predictionTimer)
        predictionTimer = null
      }
    }

    const measure = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        const hasEditableFocus = isEditableElement(document.activeElement)
        const candidateBaseline = currentLayoutViewportHeight()
        let measured = readMobileKeyboardInset(baselineHeight)

        // Browser chrome and orientation changes also resize visualViewport.
        // When no field is active they are not a keyboard, so accept the new
        // closed height and keep the public inset at zero. While typing, only
        // grow the baseline (rotation / toolbar expansion); never let iOS's
        // keyboard-driven innerHeight shrink erase it.
        if (!hasEditableFocus) {
          baselineHeight = candidateBaseline
          measured = 0
        } else if (measured === 0) {
          baselineHeight = candidateBaseline
        } else if (candidateBaseline > baselineHeight) {
          baselineHeight = candidateBaseline
          measured = readMobileKeyboardInset(baselineHeight)
        }

        if (measured > 0) {
          cachedKeyboardInset = measured
          clearPrediction()
          apply(measured)
        } else {
          // Real viewport hasn't resized yet — hold the prediction if we have
          // one, otherwise the keyboard is closed.
          apply(predictedInset)
        }
      })
    }

    const onFocusIn = (event: FocusEvent) => {
      if (!isMobileKeyboardViewport()) return
      if (!isEditableElement(event.target)) return
      if (cachedKeyboardInset <= 0) return
      if (readMobileKeyboardInset(baselineHeight) > 0) return // keyboard already up

      predictedInset = cachedKeyboardInset
      apply(predictedInset)

      // Hardware/Bluetooth keyboard: focus fires but no on-screen keyboard
      // arrives, so the visual viewport never shrinks. Drop the prediction so
      // the layout doesn't stay lifted over empty space.
      if (predictionTimer !== null) window.clearTimeout(predictionTimer)
      predictionTimer = window.setTimeout(() => {
        predictionTimer = null
        if (readMobileKeyboardInset(baselineHeight) === 0) {
          predictedInset = 0
          apply(0)
        }
      }, 600)
    }

    const onFocusOut = () => {
      clearPrediction()
      measure()
    }

    measure()

    const visualViewport = window.visualViewport
    visualViewport?.addEventListener("resize", measure)
    visualViewport?.addEventListener("scroll", measure)
    window.addEventListener("resize", measure)
    window.addEventListener("orientationchange", measure)
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (predictionTimer !== null) window.clearTimeout(predictionTimer)
      visualViewport?.removeEventListener("resize", measure)
      visualViewport?.removeEventListener("scroll", measure)
      window.removeEventListener("resize", measure)
      window.removeEventListener("orientationchange", measure)
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("focusout", onFocusOut)
    }
  }, [])

  return keyboardInset
}
