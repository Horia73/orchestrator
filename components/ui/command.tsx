"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"

import { cn } from "@/lib/utils"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandInput({
  className,
  containerClassName,
  endSlot,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  containerClassName?: string
  /** Optional trailing control (e.g. a clear button), like the chat search. */
  endSlot?: React.ReactNode
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      // Mirrors the main chat sidebar search box: a rounded, ringed field
      // rather than a flat bottom-border divider.
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg bg-background/70 px-2.5 text-foreground/75 ring-1 ring-border/70 focus-within:ring-foreground/20",
        containerClassName
      )}
    >
      <Search className="size-4 shrink-0 text-foreground/45" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-foreground/40 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
      {endSlot}
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-[320px] overflow-y-auto overflow-x-hidden p-1", className)}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-[13px] text-foreground/50", className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  heading,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group> & { heading?: React.ReactNode }) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      heading={typeof heading === "string" ? heading : undefined}
      className={cn(
        "overflow-hidden text-foreground",
        // cmdk renders the heading prop in [cmdk-group-heading] — style it here
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-foreground/45",
        className
      )}
      {...props}
    >
      {/* If caller passed a non-string heading element, render it manually so they can compose */}
      {heading && typeof heading !== "string" ? (
        <div className="flex items-center px-2 pt-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground/45">
          {heading}
        </div>
      ) : null}
      {props.children}
    </CommandPrimitive.Group>
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px] outline-none select-none",
        "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto text-[11px] tracking-wider text-foreground/40", className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
  CommandItem,
  CommandShortcut,
}
