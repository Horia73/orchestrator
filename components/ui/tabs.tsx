"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  )
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "relative inline-flex h-10 items-center gap-1 border-b border-border",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-10 items-center gap-1.5 px-3 text-[14px] font-medium text-foreground/55 outline-none transition-colors",
        "hover:text-foreground/80",
        "focus-visible:text-foreground",
        "data-[state=active]:text-foreground",
        // Underline indicator — animates with the active state
        "after:pointer-events-none after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity",
        "data-[state=active]:after:opacity-100",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      // No enter animation — Radix toggles content synchronously, and an
      // animate-in fade caused a visible flash between old/new tab content
      // because the previous panel's exit and new panel's enter overlapped.
      // Keep `hidden` on inactive panels so only one is in the DOM at a time.
      className={cn("outline-none data-[state=inactive]:hidden", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
