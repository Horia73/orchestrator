"use client"

import * as React from "react"

import { ChatInput } from "@/components/chat-input"
import { SidebarTrigger } from "@/components/ui/sidebar"
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

  React.useLayoutEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.orchHomePage
    root.dataset.orchHomePage = "true"
    return () => {
      if (previous === undefined) delete root.dataset.orchHomePage
      else root.dataset.orchHomePage = previous
    }
  }, [])

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col items-center justify-center overflow-hidden px-4 pb-[clamp(5rem,22dvh,13rem)]">
      <div className="absolute top-[calc(0.75rem+env(safe-area-inset-top))] left-3 md:hidden">
        <SidebarTrigger className="size-10 text-foreground/60 hover:text-foreground" />
      </div>
      <div className="flex w-full max-w-[672px] flex-col items-center gap-7">
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
