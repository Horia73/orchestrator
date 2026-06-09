"use client"

import * as React from "react"

import { ChatInput } from "@/components/chat-input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"
import { displayUserName, useRuntimeConfig } from "@/hooks/use-runtime-config"

// Last measured on-screen keyboard height, remembered across focuses (and
// remounts) within the session. A *subsequent* focus uses it to pre-position
// the content before iOS Safari opens the keyboard — see the lift effect.
let lastKeyboardInset = 0

function getGreeting(userName: string): string {
  const hour = new Date().getHours()
  const name = displayUserName(userName)
  const suffix = name ? `, ${name}` : ""
  if (hour >= 5 && hour < 12) return `Good morning${suffix}`
  if (hour >= 12 && hour < 17) return `Good afternoon${suffix}`
  if (hour >= 17 && hour < 21) return `Good evening${suffix}`
  return `Good night${suffix}`
}

export function HomeView() {
  const { userName } = useRuntimeConfig()
  const greeting = getGreeting(userName)
  const keyboardInset = useMobileKeyboardInset()
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [keyboardLift, setKeyboardLift] = React.useState(0)
  const [isInputFocused, setIsInputFocused] = React.useState(false)

  // Remember the real keyboard height once it's measured, so the *next* focus
  // can act on it before iOS finishes the open animation.
  React.useEffect(() => {
    if (keyboardInset > 0) lastKeyboardInset = keyboardInset
  }, [keyboardInset])

  // The height we lay out against. While focused but before the visual viewport
  // has resized (the gap iOS Safari fills by panning the whole page), fall back
  // to the cached height so the content is already where Safari wants it.
  const effectiveInset =
    keyboardInset > 0
      ? keyboardInset
      : isInputFocused
        ? lastKeyboardInset
        : 0

  React.useLayoutEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.orchHomePage
    root.dataset.orchHomePage = "true"
    return () => {
      if (previous === undefined) delete root.dataset.orchHomePage
      else root.dataset.orchHomePage = previous
    }
  }, [])

  React.useLayoutEffect(() => {
    const element = contentRef.current
    if (!element || effectiveInset <= 0) {
      setKeyboardLift(0)
      return
    }

    let frame: number | null = null
    const updateLift = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        const viewportHeight = Math.max(
          window.innerHeight,
          document.documentElement.clientHeight
        )
        // Center the content within the space above the keyboard — that's
        // roughly where Safari would scroll the focused field to, so Safari
        // has no reason to pan the viewport (which is what dragged the top bar
        // up). offsetTop is unaffected by our transform, so there's no loop.
        const visibleHeight = viewportHeight - effectiveInset
        const desiredTop = Math.max(0, (visibleHeight - element.offsetHeight) / 2)
        const nextLift = Math.max(0, Math.round(element.offsetTop - desiredTop))

        setKeyboardLift((current) =>
          Math.abs(current - nextLift) <= 1 ? current : nextLift
        )
      })
    }

    updateLift()
    const observer = new ResizeObserver(updateLift)
    observer.observe(element)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [effectiveInset])

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col items-center justify-center overflow-hidden px-4 pb-[clamp(5rem,22dvh,13rem)]">
      <div className="absolute top-[calc(0.75rem+env(safe-area-inset-top))] left-3 md:hidden">
        <SidebarTrigger className="size-10 text-foreground/60 hover:text-foreground" />
      </div>
      <div
        ref={contentRef}
        className="flex w-full max-w-[672px] flex-col items-center gap-7"
        onFocus={() => setIsInputFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsInputFocused(false)
          }
        }}
        style={{
          transform:
            keyboardLift > 0
              ? `translate3d(0, -${keyboardLift}px, 0)`
              : undefined,
        }}
      >
        {/* Hero greeting */}
        <h1 className="relative -top-[15px] [font-family:var(--font-display)] text-3xl font-normal tracking-[-0.03em] text-foreground/75 md:text-4xl lg:text-[42px]">
          {greeting}
        </h1>

        {/* Chat input */}
        <ChatInput variant="home" />
      </div>
    </div>
  )
}
