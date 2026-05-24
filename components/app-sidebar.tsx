"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  CalendarClock,
  Inbox as InboxIcon,
  LineChart,
  MapPinned,
  Telescope,
  LoaderCircle,
  Plus,
  Search,
  MoreHorizontal,
  Settings,
  Trash,
  X,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useChatStore } from "@/hooks/use-chat-store"
import { useRuntimeConfig } from "@/hooks/use-runtime-config"
import { useInboxUnread } from "@/hooks/use-inbox-unread"
import type { Conversation } from "@/lib/types"

const TABLET_NAV_MEDIA =
  "(min-width: 768px) and (max-width: 1180px), (pointer: coarse) and (min-width: 768px) and (max-width: 1366px)"
const SEARCH_DEBOUNCE_MS = 180
const MOBILE_CONVERSATION_PREFETCH_COUNT = 4
const MAPS_CONFIG_CHANGED_EVENT = "orch:maps-config-changed"

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions
  ) => number
  cancelIdleCallback?: (handle: number) => void
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
}

function truncate(value: string, length = 120): string {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= length) return singleLine
  return `${singleLine.slice(0, length - 1).trimEnd()}...`
}

function getSearchPreview(
  conversation: Conversation,
  normalizedQuery: string
): string {
  const fallbackPreview =
    conversation.searchMatchPreview ||
    conversation.lastMessagePreview ||
    conversation.messages.at(-1)?.content ||
    "No messages yet."

  if (!normalizedQuery) {
    return truncate(fallbackPreview)
  }

  if (normalizeSearchText(conversation.title).includes(normalizedQuery)) {
    return truncate(fallbackPreview || "Title match")
  }

  if (conversation.searchMatchPreview) {
    return truncate(conversation.searchMatchPreview)
  }

  if (conversation.lastMessagePreview) {
    return truncate(conversation.lastMessagePreview)
  }

  const message = conversation.messages.find((item) =>
    normalizeSearchText(item.content).includes(normalizedQuery)
  )

  return truncate(
    message?.content ??
      conversation.messages.at(-1)?.content ??
      "No messages yet."
  )
}

function conversationMatches(
  conversation: Conversation,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true
  if (normalizeSearchText(conversation.title).includes(normalizedQuery))
    return true
  if (
    conversation.lastMessagePreview &&
    normalizeSearchText(conversation.lastMessagePreview).includes(
      normalizedQuery
    )
  ) {
    return true
  }
  if (
    conversation.searchMatchPreview &&
    normalizeSearchText(conversation.searchMatchPreview).includes(
      normalizedQuery
    )
  ) {
    return true
  }
  return conversation.messages.some((message) =>
    normalizeSearchText(message.content).includes(normalizedQuery)
  )
}

function useMapsConfigured(): boolean {
  const [configured, setConfigured] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/maps/config", {
        cache: "no-store",
      })
      const body = (await res.json().catch(() => ({}))) as {
        maps?: { configured?: unknown }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setConfigured(body.maps?.configured === true)
    } catch {
      setConfigured(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()

    const onMapsConfigChanged = () => void refresh()
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh()
    }

    window.addEventListener(MAPS_CONFIG_CHANGED_EVENT, onMapsConfigChanged)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener(MAPS_CONFIG_CHANGED_EVENT, onMapsConfigChanged)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [refresh])

  return configured
}

interface SidebarSearchFieldProps {
  value: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onChange: (value: string) => void
  onClose: () => void
  onFocus: () => void
}

function SidebarSearchField({
  value,
  inputRef,
  onChange,
  onClose,
  onFocus,
}: SidebarSearchFieldProps) {
  return (
    <div className="relative flex h-8 items-center rounded-md border border-border/70 bg-background/75 transition-colors hover:bg-background focus-within:border-foreground/25 focus-within:bg-background dark:bg-muted/40 dark:hover:bg-muted/55 dark:focus-within:bg-muted/55">
      <Search className="pointer-events-none absolute left-2 size-4 shrink-0 text-foreground/45" />
      <input
        ref={inputRef}
        value={value}
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
        }}
        placeholder="Search chats..."
        className="h-full min-w-0 flex-1 bg-transparent pr-8 pl-8 text-[15px] leading-none text-foreground outline-none placeholder:text-foreground/40"
      />
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="absolute right-1.5 flex size-5 shrink-0 items-center justify-center rounded text-foreground/45 transition-colors hover:bg-background/65 hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:outline-none"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

export function AppSidebar() {
  const {
    state,
    unreadConversationIds,
    newChat,
    selectConversation,
    prefetchConversationMessages,
    deleteConversation,
  } = useChatStore()
  const {
    state: sidebarState,
    open: sidebarOpen,
    openMobile,
    setOpen,
    setOpenMobile,
    isMobile,
  } = useSidebar()
  const pathname = usePathname()
  const router = useRouter()
  const isCollapsed = sidebarState === "collapsed"
  const isOnSettings = pathname?.startsWith("/settings") ?? false
  const isOnScheduling = pathname?.startsWith("/scheduling") ?? false
  const isOnWatchlist = pathname?.startsWith("/watchlist") ?? false
  const isOnMonitor = pathname?.startsWith("/monitor") ?? false
  const isOnMaps = pathname?.startsWith("/maps") ?? false
  const mapsConfigured = useMapsConfigured()
  const isOnInbox = pathname?.startsWith("/inbox") ?? false
  const shouldConstrainTabletNav =
    isOnSettings || isOnScheduling || isOnWatchlist || isOnMonitor || isOnMaps || isOnInbox
  const isTabletNavViewport = useMediaQuery(TABLET_NAV_MEDIA)
  const inboxUnread = useInboxUnread()
  const [searchActive, setSearchActive] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [searchResults, setSearchResults] = React.useState<
    Conversation[] | null
  >(null)
  const [searchLoading, setSearchLoading] = React.useState(false)
  const deferredSearchQuery = React.useDeferredValue(searchQuery)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const { assistantName } = useRuntimeConfig()
  const normalizedSearchQuery = normalizeSearchText(deferredSearchQuery.trim())
  const isFiltering = normalizedSearchQuery.length > 0

  const filteredConversations = React.useMemo(
    () =>
      state.conversations.filter((conversation) =>
        conversationMatches(conversation, normalizedSearchQuery)
      ),
    [normalizedSearchQuery, state.conversations]
  )
  const displayedConversations =
    isFiltering && searchResults ? searchResults : filteredConversations

  React.useEffect(() => {
    if (!isFiltering) {
      setSearchResults(null)
      setSearchLoading(false)
      return
    }

    const controller = new AbortController()
    setSearchResults(null)
    const timer = window.setTimeout(() => {
      setSearchLoading(true)
      void fetch(
        `/api/conversations?summary=1&q=${encodeURIComponent(deferredSearchQuery.trim())}`,
        { cache: "no-store", signal: controller.signal }
      )
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json() as Promise<Conversation[]>
        })
        .then((rows) => setSearchResults(rows))
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return
          setSearchResults(null)
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [deferredSearchQuery, isFiltering])

  const openSidebarSearch = React.useCallback(() => {
    setOpen(true)
    setSearchActive(true)
    window.setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [setOpen])

  const sidebarOpenRef = React.useRef(sidebarOpen)
  const tabletRestoreOpenRef = React.useRef<boolean | null>(null)

  React.useEffect(() => {
    sidebarOpenRef.current = sidebarOpen
  }, [sidebarOpen])

  React.useEffect(() => {
    const active = shouldConstrainTabletNav && isTabletNavViewport && !isMobile
    if (active && tabletRestoreOpenRef.current === null) {
      tabletRestoreOpenRef.current = sidebarOpenRef.current
      setOpen(false)
      return
    }
    if (!active && tabletRestoreOpenRef.current !== null) {
      const shouldRestore = tabletRestoreOpenRef.current
      tabletRestoreOpenRef.current = null
      if (shouldRestore) setOpen(true)
    }
  }, [isMobile, isTabletNavViewport, setOpen, shouldConstrainTabletNav])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        openSidebarSearch()
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [openSidebarSearch])

  React.useEffect(() => {
    if (searchActive && !isCollapsed) searchInputRef.current?.focus()
  }, [isCollapsed, searchActive])

  React.useEffect(() => {
    if (!isMobile || state.isLoading || isFiltering) return

    const candidates = state.conversations
      .filter((conversation) => {
        const status = state.conversationLoadState[conversation.id]
        return status == null || status === "summary"
      })
      .slice(0, MOBILE_CONVERSATION_PREFETCH_COUNT)
      .map((conversation) => conversation.id)

    if (candidates.length === 0) return

    let cancelled = false
    const warmConversations = () => {
      for (const id of candidates) {
        if (cancelled) return
        void prefetchConversationMessages(id)
      }
    }

    const browserWindow = window as WindowWithIdleCallback

    if (typeof browserWindow.requestIdleCallback === "function") {
      const idleId = browserWindow.requestIdleCallback(warmConversations, {
        timeout: openMobile ? 250 : 1200,
      })
      return () => {
        cancelled = true
        browserWindow.cancelIdleCallback?.(idleId)
      }
    }

    const timer = window.setTimeout(warmConversations, openMobile ? 80 : 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    isFiltering,
    isMobile,
    openMobile,
    prefetchConversationMessages,
    state.conversationLoadState,
    state.conversations,
    state.isLoading,
  ])

  // Wrap chat actions so they always land on the chat page —
  // users can fire them from /settings or any other route.
  const navigateHome = React.useCallback(() => {
    if (pathname === "/") return
    if (isMobile) router.replace("/")
    else router.push("/")
  }, [isMobile, pathname, router])

  const handleNewChat = React.useCallback(() => {
    if (isMobile) setOpenMobile(false)
    newChat()
    navigateHome()
  }, [isMobile, navigateHome, newChat, setOpenMobile])

  const handleSelectConversation = React.useCallback(
    (id: string) => {
      if (isMobile) {
        setOpenMobile(false)
        window.requestAnimationFrame(() => {
          selectConversation(id)
          navigateHome()
        })
        return
      }

      selectConversation(id)
      navigateHome()
    },
    [isMobile, navigateHome, selectConversation, setOpenMobile]
  )

  const closeMobileSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile(false)
  }, [isMobile, setOpenMobile])

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="pb-2">
        <div className="flex h-9 items-center justify-between gap-2 px-1 md:h-7">
          {!isCollapsed && (
            <span
              className="min-w-0 truncate pl-1 text-[21px] leading-none font-semibold tracking-tight text-foreground/90"
              title={assistantName}
            >
              {assistantName}
            </span>
          )}
          <SidebarTrigger className="size-9 text-foreground/60 hover:text-foreground md:size-7" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Main actions */}
        <SidebarGroup className="py-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="New chat"
                  onClick={handleNewChat}
                  className="text-[15px] text-foreground/75 hover:text-foreground"
                >
                  <Plus className="size-4" />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {searchActive && !isCollapsed ? (
                <SidebarMenuItem>
                  <SidebarSearchField
                    inputRef={searchInputRef}
                    value={searchQuery}
                    onChange={setSearchQuery}
                    onFocus={() => setSearchActive(true)}
                    onClose={() => {
                      setSearchQuery("")
                      setSearchActive(false)
                      searchInputRef.current?.blur()
                    }}
                  />
                </SidebarMenuItem>
              ) : (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Search"
                    onClick={openSidebarSearch}
                    className="text-[15px] text-foreground/75 hover:text-foreground"
                  >
                    <Search className="size-4" />
                    <span>Search</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Scheduling + Watchlist + Inbox */}
        <SidebarGroup className="py-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Scheduling"
                  isActive={isOnScheduling}
                  className="text-[15px] text-foreground/75 hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:hover:bg-muted dark:data-[active=true]:bg-muted"
                >
                  <Link
                    href="/scheduling"
                    replace={isMobile}
                    onClick={closeMobileSidebar}
                  >
                    <CalendarClock className="size-4" />
                    <span>Scheduling</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Watchlist"
                  isActive={isOnWatchlist}
                  className="text-[15px] text-foreground/75 hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:hover:bg-muted dark:data-[active=true]:bg-muted"
                >
                  <Link
                    href="/watchlist"
                    replace={isMobile}
                    onClick={closeMobileSidebar}
                  >
                    <LineChart className="size-4" />
                    <span>Watchlist</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Smart monitor"
                  isActive={isOnMonitor}
                  className="text-[15px] text-foreground/75 hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:hover:bg-muted dark:data-[active=true]:bg-muted"
                >
                  <Link
                    href="/monitor"
                    replace={isMobile}
                    onClick={closeMobileSidebar}
                  >
                    <Telescope className="size-4" />
                    <span>Smart monitor</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {mapsConfigured && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Smart Maps"
                    isActive={isOnMaps}
                    className="text-[15px] text-foreground/75 hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:hover:bg-muted dark:data-[active=true]:bg-muted"
                  >
                    <Link
                      href="/maps"
                      replace={isMobile}
                      onClick={closeMobileSidebar}
                    >
                      <MapPinned className="size-4" />
                      <span>Smart Maps</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Inbox"
                  isActive={isOnInbox}
                  className="text-[15px] text-foreground/75 hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:hover:bg-muted dark:data-[active=true]:bg-muted"
                >
                  <Link
                    href="/inbox"
                    replace={isMobile}
                    onClick={closeMobileSidebar}
                  >
                    <InboxIcon className="size-4" />
                    <span>Inbox</span>
                  </Link>
                </SidebarMenuButton>
                {inboxUnread > 0 && (
                  <SidebarMenuBadge className="bg-[#802020] text-white peer-hover/menu-button:text-white peer-data-[active=true]/menu-button:text-white">
                    {inboxUnread > 99 ? "99+" : inboxUnread}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {!isCollapsed && (
          <>
            {/* Recents section */}
            <SidebarGroup className="flex-1 py-0">
              <SidebarGroupLabel className="text-[12px] tracking-wider text-foreground/50 uppercase">
                {isFiltering ? "Search results" : "Recents"}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                {state.isLoading ? (
                  <SidebarMenu className="space-y-0.5 px-2">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <SidebarMenuItem key={i}>
                        <div className="flex h-8 w-full items-center rounded-md px-2">
                          <div className="h-4 w-3/4 animate-pulse rounded bg-muted-foreground/20" />
                        </div>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                ) : displayedConversations.length > 0 ? (
                  <SidebarMenu className="space-y-0.5">
                    {displayedConversations.map((conv) => {
                      const unread = unreadConversationIds.has(conv.id)
                      const isRunning =
                        Boolean(state.activeChatStreams[conv.id]) ||
                        (state.activeConversationId === conv.id &&
                          state.isStreaming &&
                          state.streamingConversationId === conv.id)
                      const hasStatusSlot = isRunning || unread
                      const isActiveConversationRow =
                        state.activeConversationId === conv.id &&
                        !isOnSettings &&
                        !isOnScheduling &&
                        !isOnWatchlist &&
                        !isOnMonitor &&
                        !isOnMaps &&
                        !isOnInbox
                      return (
                        <SidebarMenuItem key={conv.id}>
                          <SidebarMenuButton
                            tooltip={conv.title}
                            isActive={isActiveConversationRow}
                            onClick={() => handleSelectConversation(conv.id)}
                            onFocus={() => {
                              void prefetchConversationMessages(conv.id)
                            }}
                            onPointerEnter={(event) => {
                              if (event.pointerType === "touch") return
                              void prefetchConversationMessages(conv.id)
                            }}
                            className={`text-[15px] text-foreground/75 group-hover/menu-item:bg-[#f0ede6] group-hover/menu-item:text-foreground group-has-[[data-state=open]]/menu-item:bg-[#f0ede6] group-has-[[data-state=open]]/menu-item:text-foreground hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:group-hover/menu-item:bg-muted dark:group-has-[[data-state=open]]/menu-item:bg-muted dark:hover:bg-muted dark:data-[active=true]:bg-muted ${isFiltering ? "h-auto min-h-10 items-start py-1.5" : ""}`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">
                                {conv.title}
                              </span>
                              {isFiltering && (
                                <span className="mt-0.5 block truncate text-[12px] font-normal text-foreground/45">
                                  {getSearchPreview(
                                    conv,
                                    normalizedSearchQuery
                                  )}
                                </span>
                              )}
                            </span>
                          </SidebarMenuButton>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <SidebarMenuAction
                                aria-label="Conversation actions"
                                showOnHover={
                                  !hasStatusSlot && !isActiveConversationRow
                                }
                                className="!top-0 !right-0 !bottom-0 !h-full !w-[34px] !rounded-md text-foreground hover:bg-[#e7e5dd] focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none data-[state=open]:bg-[#e7e5dd] dark:hover:bg-white/[0.1] dark:data-[state=open]:bg-white/[0.1]"
                              >
                                {isRunning ? (
                                  <LoaderCircle className="!size-[16px] animate-spin text-foreground/45 group-hover/menu-item:hidden group-focus-within/menu-item:hidden group-has-[[data-state=open]]/menu-item:hidden" />
                                ) : unread ? (
                                  <span className="size-2 rounded-full bg-[#b76440] group-hover/menu-item:hidden group-focus-within/menu-item:hidden group-has-[[data-state=open]]/menu-item:hidden" />
                                ) : null}
                                <MoreHorizontal
                                  className={`!size-[20px] ${hasStatusSlot ? "hidden group-hover/menu-item:block group-focus-within/menu-item:block group-has-[[data-state=open]]/menu-item:block" : ""}`}
                                />
                              </SidebarMenuAction>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              side="bottom"
                              align="end"
                              sideOffset={6}
                              onCloseAutoFocus={(e) => e.preventDefault()}
                              className="w-36 rounded-xl border-border/50 p-1 shadow-md"
                            >
                              <DropdownMenuItem
                                onClick={() => deleteConversation(conv.id)}
                                className="cursor-pointer gap-2 px-2 py-1.5 text-[14px] text-[#802020] focus:bg-red-50 focus:text-[#802020]"
                              >
                                <Trash className="size-4" strokeWidth={1.5} />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                ) : isFiltering ? (
                  <p className="px-2 text-[14px] whitespace-nowrap text-foreground/45">
                    {searchLoading
                      ? "Searching chats..."
                      : "No matching chats."}
                  </p>
                ) : (
                  <p className="px-2 text-[14px] whitespace-nowrap text-foreground/45">
                    No recent chats yet.
                  </p>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Settings"
              isActive={isOnSettings}
              className="text-[15px] text-foreground/75 hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:hover:bg-muted dark:data-[active=true]:bg-muted"
            >
              <Link
                href="/settings"
                replace={isMobile}
                onClick={closeMobileSidebar}
              >
                <Settings className="size-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false)

  React.useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [query])

  return matches
}
