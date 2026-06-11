"use client"

import * as React from "react"

import { ChatInput } from "@/components/chat-input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"
import { displayUserName, useRuntimeConfig } from "@/hooks/use-runtime-config"

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
  // useMobileKeyboardInset reports the cached keyboard height the instant the
  // field is focused (before iOS opens the keyboard), so the lift below lands
  // pre-emptively and Safari never pans the page.
  const keyboardInset = useMobileKeyboardInset()
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [keyboardLift, setKeyboardLift] = React.useState(0)

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
    if (!element || keyboardInset <= 0) {
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
        // Lift only when the keyboard would actually cover the input, and only
        // by the overlap. When there's room, nothing moves — re-centering on
        // every focus made the greeting + input jump for no reason.
        // offsetTop/offsetHeight are layout values unaffected by our
        // transform, so there's no feedback loop.
        const visibleHeight = viewportHeight - keyboardInset
        const contentBottom = element.offsetTop + element.offsetHeight
        const nextLift = Math.max(
          0,
          Math.round(contentBottom - (visibleHeight - 12))
        )

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
  }, [keyboardInset])

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col items-center justify-center overflow-hidden px-4 pb-[clamp(5rem,22dvh,13rem)]">
      <div className="absolute top-[calc(0.75rem+env(safe-area-inset-top))] left-3 md:hidden">
        <SidebarTrigger className="size-10 text-foreground/60 hover:text-foreground" />
      </div>
      <div
        ref={contentRef}
        className="flex w-full max-w-[672px] flex-col items-center gap-7 transition-transform duration-200 ease-out motion-reduce:transition-none"
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
