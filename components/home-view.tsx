"use client"

import { ChatInput } from "@/components/chat-input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { displayUserName, useRuntimeConfig } from "@/hooks/use-runtime-config"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"

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

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-4 pb-52">
      <div className="absolute top-[calc(0.75rem+env(safe-area-inset-top))] left-3 md:hidden">
        <SidebarTrigger className="size-10 text-foreground/60 hover:text-foreground" />
      </div>
      <div
        className="flex w-full max-w-[672px] flex-col items-center gap-7"
        style={{
          transform:
            keyboardInset > 0
              ? `translateY(${keyboardInset / 2}px)`
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
