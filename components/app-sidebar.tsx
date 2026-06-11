"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Inbox as InboxIcon,
  Library as LibraryIcon,
  LineChart,
  MapPinned,
  Telescope,
  LoaderCircle,
  LogOut,
  Plus,
  Search,
  MoreHorizontal,
  Settings,
  Trash,
  UserRound,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AnimatedTitle } from "@/components/animated-title"
import { useChatStore } from "@/hooks/use-chat-store"
import { useRuntimeConfig } from "@/hooks/use-runtime-config"
import { useInboxUnread } from "@/hooks/use-inbox-unread"
import {
  profileInitials,
  useCurrentProfile,
} from "@/components/profiles/use-profiles"
import type { Conversation } from "@/lib/types"
import { VIEW_FADE_MS, VIEW_LEAVE_EVENT } from "@/lib/view-fade"

// Runs before the browser paints on the client (so the tablet-nav collapse
// is applied in the same frame the sidebar mounts), and degrades to a plain
// effect during SSR to avoid the useLayoutEffect-on-server warning. AppSidebar
// is mounted per-route, so without this the sidebar paints one expanded frame
// — flashing the conversation list — before a post-paint effect collapses it.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect

const TABLET_NAV_MEDIA =
  "(min-width: 768px) and (max-width: 1180px), (pointer: coarse) and (min-width: 768px) and (max-width: 1366px)"
const SEARCH_DEBOUNCE_MS = 180
const MOBILE_CONVERSATION_PREFETCH_COUNT = 4
const CONVERSATION_ACTION_LONG_PRESS_MS = 520
const CONVERSATION_ACTION_LONG_PRESS_MOVE_TOLERANCE = 12
const CONVERSATION_ACTION_CLICK_SUPPRESSION_MS = 750

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

function clearNativeTextSelection() {
  if (typeof window === "undefined") return
  window.getSelection()?.removeAllRanges()
}

function vibrateConversationActionMenu() {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.vibrate === "function"
  ) {
    navigator.vibrate(12)
  }
}

function getConversationLastMessageAt(
  conversation: Conversation
): number | null {
  const timestamps = [
    conversation.lastMessageAt,
    conversation.messages.at(-1)?.timestamp,
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0
  )

  return timestamps.length > 0 ? Math.max(...timestamps) : null
}

function formatConversationActivityAge(
  timestamp: number | null,
  currentTime: number | null
): string {
  if (!timestamp || !currentTime) return ""

  const diff = Math.max(0, currentTime - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return "now"
  if (diff < hour) return `${Math.floor(diff / minute)}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`

  return new Date(timestamp).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })
}

function formatConversationActivityTitle(timestamp: number | null): string {
  if (!timestamp) return ""
  return `Last message ${new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`
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
    <div className="relative flex h-8 items-center rounded-md border border-border/70 bg-background/75 transition-colors focus-within:border-foreground/25 focus-within:bg-background hover:bg-background dark:bg-muted/40 dark:focus-within:bg-muted/55 dark:hover:bg-muted/55">
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
    archiveConversation,
    unarchiveConversation,
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
  const searchParams = useSearchParams()
  // `state` tracks the persisted desktop open/closed preference and ignores
  // the mobile sheet — which always renders at full width. Treat the sheet as
  // never collapsed so a "collapsed" cookie carried over from desktop/tablet
  // can't hide the wordmark, search, or conversation list on a phone.
  const isCollapsed = sidebarState === "collapsed" && !isMobile
  const isOnChatHome = pathname === "/"
  const isOnSettings = pathname?.startsWith("/settings") ?? false
  const isOnScheduling = pathname?.startsWith("/scheduling") ?? false
  const isOnWatchlist = pathname?.startsWith("/watchlist") ?? false
  const isOnMonitor = pathname?.startsWith("/monitor") ?? false
  const isOnMaps = pathname?.startsWith("/maps") ?? false
  const isOnInbox = pathname?.startsWith("/inbox") ?? false
  // /workouts redirects to /library?tab=workouts — treat both as "Library" active.
  const isOnLibrary =
    (pathname?.startsWith("/library") ?? false) ||
    (pathname?.startsWith("/workouts") ?? false)
  const shouldConstrainTabletNav =
    isOnSettings ||
    isOnScheduling ||
    isOnWatchlist ||
    isOnMonitor ||
    isOnMaps ||
    isOnInbox ||
    isOnLibrary
  const isTabletNavViewport = useMediaQuery(TABLET_NAV_MEDIA)
  const isCompactRouteNav =
    shouldConstrainTabletNav && isTabletNavViewport && !isMobile
  const inboxUnread = useInboxUnread()
  const {
    profile: currentProfile,
    isAdmin,
    loading: profileLoading,
  } = useCurrentProfile()
  const [searchActive, setSearchActive] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [searchResults, setSearchResults] = React.useState<
    Conversation[] | null
  >(null)
  const [searchLoading, setSearchLoading] = React.useState(false)
  const [archiveViewActive, setArchiveViewActive] = React.useState(false)
  const [archivedConversations, setArchivedConversations] = React.useState<
    Conversation[]
  >([])
  const [archivedLoading, setArchivedLoading] = React.useState(false)
  const [archivedError, setArchivedError] = React.useState<string | null>(null)
  const [conversationActionMenuId, setConversationActionMenuId] =
    React.useState<string | null>(null)
  const [profileMenuOpen, setProfileMenuOpen] = React.useState(false)
  const [currentTime, setCurrentTime] = React.useState<number | null>(null)
  const [isConversationScrollbarVisible, setIsConversationScrollbarVisible] =
    React.useState(false)
  const deferredSearchQuery = React.useDeferredValue(searchQuery)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const profileTriggerRef = React.useRef<HTMLButtonElement>(null)
  const conversationScrollbarVisibleRef = React.useRef(false)
  const conversationScrollbarFadeTimeoutRef = React.useRef<number | null>(null)
  const conversationActionLongPressTimerRef = React.useRef<number | null>(null)
  const conversationActionLongPressPointerRef = React.useRef<{
    pointerId: number
    x: number
    y: number
  } | null>(null)
  const conversationActionLongPressCompletedRef = React.useRef<string | null>(
    null
  )
  const { assistantName } = useRuntimeConfig()
  const normalizedSearchQuery = normalizeSearchText(deferredSearchQuery.trim())
  const isFiltering = normalizedSearchQuery.length > 0
  const showArchiveView = archiveViewActive && !isFiltering
  const showConversationSection = !isCollapsed && !isCompactRouteNav
  const showSettingsLink = isAdmin || (profileLoading && isOnSettings)

  const filteredConversations = React.useMemo(
    () =>
      state.conversations.filter(
        (conversation) =>
          (isFiltering || !conversation.archivedAt) &&
          conversationMatches(conversation, normalizedSearchQuery)
      ),
    [isFiltering, normalizedSearchQuery, state.conversations]
  )
  const displayedConversations = showArchiveView
    ? archivedConversations
    : isFiltering && searchResults
      ? searchResults
      : filteredConversations
  const conversationsLoading =
    state.isLoading || (showArchiveView && archivedLoading)
  const conversationSectionLabel = isFiltering
    ? "Search results"
    : showArchiveView
      ? "Archive"
      : "Recents"

  React.useEffect(() => {
    const updateClock = () => setCurrentTime(Date.now())
    updateClock()
    const timer = window.setInterval(updateClock, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const revealConversationScrollbar = React.useCallback(() => {
    if (!conversationScrollbarVisibleRef.current) {
      conversationScrollbarVisibleRef.current = true
      setIsConversationScrollbarVisible(true)
    }

    if (conversationScrollbarFadeTimeoutRef.current !== null) {
      window.clearTimeout(conversationScrollbarFadeTimeoutRef.current)
    }

    conversationScrollbarFadeTimeoutRef.current = window.setTimeout(() => {
      conversationScrollbarVisibleRef.current = false
      conversationScrollbarFadeTimeoutRef.current = null
      setIsConversationScrollbarVisible(false)
    }, 700)
  }, [])

  const clearConversationActionLongPress = React.useCallback(() => {
    if (conversationActionLongPressTimerRef.current !== null) {
      window.clearTimeout(conversationActionLongPressTimerRef.current)
      conversationActionLongPressTimerRef.current = null
    }
    conversationActionLongPressPointerRef.current = null
  }, [])

  const openConversationActionMenu = React.useCallback(
    (conversationId: string) => {
      clearNativeTextSelection()
      vibrateConversationActionMenu()
      conversationActionLongPressCompletedRef.current = conversationId
      setConversationActionMenuId(conversationId)

      window.setTimeout(() => {
        if (
          conversationActionLongPressCompletedRef.current === conversationId
        ) {
          conversationActionLongPressCompletedRef.current = null
        }
      }, CONVERSATION_ACTION_CLICK_SUPPRESSION_MS)
    },
    []
  )

  const handleConversationLongPressStart = React.useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      conversation: Conversation
    ) => {
      if (typeof conversation.archivedAt === "number") return
      if (event.pointerType === "mouse" && event.button !== 0) return

      clearConversationActionLongPress()
      conversationActionLongPressPointerRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      }
      conversationActionLongPressTimerRef.current = window.setTimeout(() => {
        conversationActionLongPressTimerRef.current = null
        conversationActionLongPressPointerRef.current = null
        openConversationActionMenu(conversation.id)
      }, CONVERSATION_ACTION_LONG_PRESS_MS)
    },
    [clearConversationActionLongPress, openConversationActionMenu]
  )

  const handleConversationLongPressMove = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const pointer = conversationActionLongPressPointerRef.current
      if (!pointer || pointer.pointerId !== event.pointerId) return

      const moved =
        Math.abs(event.clientX - pointer.x) >
          CONVERSATION_ACTION_LONG_PRESS_MOVE_TOLERANCE ||
        Math.abs(event.clientY - pointer.y) >
          CONVERSATION_ACTION_LONG_PRESS_MOVE_TOLERANCE
      if (moved) clearConversationActionLongPress()
    },
    [clearConversationActionLongPress]
  )

  const handleConversationLongPressContextMenu = React.useCallback(
    (
      event: React.MouseEvent<HTMLButtonElement>,
      conversation: Conversation
    ) => {
      if (typeof conversation.archivedAt === "number") return
      event.preventDefault()
      event.stopPropagation()
      clearConversationActionLongPress()
      openConversationActionMenu(conversation.id)
    },
    [clearConversationActionLongPress, openConversationActionMenu]
  )

  const handleConversationScroll = React.useCallback(() => {
    setConversationActionMenuId(null)
    revealConversationScrollbar()
  }, [revealConversationScrollbar])

  const handleConversationWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const target = event.currentTarget
      const maxScrollTop = target.scrollHeight - target.clientHeight

      if (maxScrollTop <= 0) return

      const isMovingDown = event.deltaY > 0 && target.scrollTop < maxScrollTop
      const isMovingUp = event.deltaY < 0 && target.scrollTop > 0

      if (isMovingDown || isMovingUp) revealConversationScrollbar()
    },
    [revealConversationScrollbar]
  )

  const handleConversationTouchMove = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      setConversationActionMenuId(null)
      const target = event.currentTarget
      if (target.scrollHeight > target.clientHeight) {
        revealConversationScrollbar()
      }
    },
    [revealConversationScrollbar]
  )

  React.useEffect(() => {
    return () => {
      clearConversationActionLongPress()
      if (conversationScrollbarFadeTimeoutRef.current !== null) {
        window.clearTimeout(conversationScrollbarFadeTimeoutRef.current)
      }
    }
  }, [clearConversationActionLongPress])

  React.useEffect(() => {
    if (!showConversationSection) {
      setConversationActionMenuId(null)
      clearConversationActionLongPress()
    }
  }, [clearConversationActionLongPress, showConversationSection])

  React.useEffect(() => {
    if (!conversationActionMenuId) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest("[data-conversation-action-menu='true']")
      ) {
        return
      }
      setConversationActionMenuId(null)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [conversationActionMenuId])

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

  React.useEffect(() => {
    if (!showArchiveView) return

    const controller = new AbortController()
    setArchivedLoading(true)
    setArchivedError(null)
    void fetch("/api/conversations?summary=1&archived=1", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<Conversation[]>
      })
      .then((rows) => setArchivedConversations(rows))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        setArchivedError("Couldn't load archived chats.")
        setArchivedConversations([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setArchivedLoading(false)
      })

    return () => controller.abort()
  }, [showArchiveView])

  const openSidebarSearch = React.useCallback(() => {
    setOpen(true)
    setArchiveViewActive(false)
    setConversationActionMenuId(null)
    setSearchActive(true)
    window.setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [setOpen])

  const tabletRestoreOpenRef = React.useRef<boolean | null>(null)

  useIsomorphicLayoutEffect(() => {
    if (isCompactRouteNav) {
      if (tabletRestoreOpenRef.current === null) {
        tabletRestoreOpenRef.current = sidebarOpen
      }
      if (sidebarOpen) setOpen(false)
      return
    }
    if (!isCompactRouteNav && tabletRestoreOpenRef.current !== null) {
      const shouldRestore = tabletRestoreOpenRef.current
      tabletRestoreOpenRef.current = null
      if (shouldRestore) setOpen(true)
    }
  }, [isCompactRouteNav, setOpen, sidebarOpen])

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
    // Already on the chat route: the store's fade gate handles the chat↔chat /
    // chat↔home crossfade. Just strip any leftover ?chat=/?msg= deep-link params.
    if (pathname === "/") {
      if (searchParams.toString().length === 0) return
      if (isMobile) router.replace("/")
      else router.push("/")
      return
    }
    // Coming from another route (inbox / monitor / maps / …): ease the
    // departing view out first (it listens for VIEW_LEAVE_EVENT) so the
    // conversation fades in over a blank bridge — same choreography on mobile
    // and desktop, no splash. Reduced-motion navigates immediately.
    const navigate = () => {
      if (isMobile) router.replace("/")
      else router.push("/")
    }
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    if (reduceMotion) {
      navigate()
      return
    }
    window.dispatchEvent(new Event(VIEW_LEAVE_EVENT))
    window.setTimeout(navigate, VIEW_FADE_MS)
  }, [isMobile, pathname, router, searchParams])

  const handleNewChat = React.useCallback(() => {
    setArchiveViewActive(false)
    setConversationActionMenuId(null)
    if (isMobile) setOpenMobile(false)
    newChat()
    navigateHome()
  }, [isMobile, navigateHome, newChat, setOpenMobile])

  const handleSelectConversation = React.useCallback(
    (conversation: Conversation) => {
      if (
        conversationActionLongPressCompletedRef.current === conversation.id
      ) {
        conversationActionLongPressCompletedRef.current = null
        return
      }
      setConversationActionMenuId(null)

      selectConversation(conversation.id, conversation)
      navigateHome()
      if (isMobile) setOpenMobile(false)
    },
    [isMobile, navigateHome, selectConversation, setOpenMobile]
  )

  const handleArchiveConversation = React.useCallback(
    (event: React.MouseEvent, id: string) => {
      event.preventDefault()
      event.stopPropagation()
      setConversationActionMenuId(null)
      const archivedAt = Date.now()
      archiveConversation(id)
      setArchivedConversations((current) => [
        ...state.conversations
          .filter((conversation) => conversation.id === id)
          .map((conversation) => ({ ...conversation, archivedAt })),
        ...current.filter((conversation) => conversation.id !== id),
      ])
      setSearchResults((current) =>
        current
          ? current.map((conversation) =>
              conversation.id === id
                ? { ...conversation, archivedAt }
                : conversation
            )
          : current
      )
      if (isMobile) setOpenMobile(false)
      navigateHome()
    },
    [
      archiveConversation,
      isMobile,
      navigateHome,
      setOpenMobile,
      state.conversations,
    ]
  )

  const handleRestoreConversation = React.useCallback(
    (conversation: Conversation) => {
      unarchiveConversation(conversation.id, conversation)
      setArchivedConversations((current) =>
        current.filter((item) => item.id !== conversation.id)
      )
      setSearchResults((current) =>
        current
          ? current.map((item) =>
              item.id === conversation.id ? { ...item, archivedAt: null } : item
            )
          : current
      )
    },
    [unarchiveConversation]
  )

  const handleDeleteConversation = React.useCallback(
    (id: string) => {
      setConversationActionMenuId(null)
      deleteConversation(id)
      setSearchResults((current) =>
        current
          ? current.filter((conversation) => conversation.id !== id)
          : current
      )
      setArchivedConversations((current) =>
        current.filter((conversation) => conversation.id !== id)
      )
    },
    [deleteConversation]
  )

  const handleDeleteConversationAction = React.useCallback(
    (event: React.MouseEvent, id: string) => {
      event.preventDefault()
      event.stopPropagation()
      handleDeleteConversation(id)
      if (isMobile) setOpenMobile(false)
      navigateHome()
    },
    [handleDeleteConversation, isMobile, navigateHome, setOpenMobile]
  )

  const closeMobileSidebar = React.useCallback(() => {
    setProfileMenuOpen(false)
    profileTriggerRef.current?.blur()
    if (isMobile) setOpenMobile(false)
  }, [isMobile, setOpenMobile])

  const handleSwitchProfile = React.useCallback(() => {
    closeMobileSidebar()
    router.push(`/profiles?next=${encodeURIComponent(pathname || "/")}`)
  }, [closeMobileSidebar, pathname, router])

  // Navigate to the inbox with a fade-out hand-off. From the chat/home view we
  // ease that shell out (it listens for VIEW_LEAVE_EVENT) and only then swap
  // routes, so the inbox fades in over a blank background instead of flashing a
  // skeleton. From other routes — or for modified / reduced-motion clicks — we
  // fall through to the plain Link navigation (no artificial delay).
  const handleInboxNavigate = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      closeMobileSidebar()
      if (!isOnChatHome) return
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.button !== 0
      )
        return
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
        return
      event.preventDefault()
      window.dispatchEvent(new Event(VIEW_LEAVE_EVENT))
      window.setTimeout(() => {
        if (isMobile) router.replace("/inbox")
        else router.push("/inbox")
      }, VIEW_FADE_MS)
    },
    [closeMobileSidebar, isMobile, isOnChatHome, router]
  )

  const handleLogoutProfile = React.useCallback(() => {
    setProfileMenuOpen(false)
    profileTriggerRef.current?.blur()
    void fetch("/api/profiles/logout", { method: "POST" }).finally(() => {
      router.replace("/profiles")
      router.refresh()
    })
  }, [router])

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="shrink-0 pb-2">
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

      <SidebarContent className="overflow-hidden">
        {/* Main actions */}
        <SidebarGroup className="shrink-0 py-0">
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

        {/* Watchlist + Scheduling + Inbox */}
        <SidebarGroup className="shrink-0 py-0">
          <SidebarGroupContent>
            <SidebarMenu>
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
                    onClick={handleInboxNavigate}
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

        {showConversationSection && (
          <>
            {/* Recents section */}
            <SidebarGroup className="group/archive-section min-h-0 flex-1 py-0">
              <SidebarGroupLabel className="justify-between text-[12px] tracking-wider text-foreground/50 uppercase">
                <span>{conversationSectionLabel}</span>
                {!isFiltering && (
                  <button
                    type="button"
                    aria-label={
                      showArchiveView ? "Show recents" : "Show archived chats"
                    }
                    title={showArchiveView ? "Recents" : "Archived chats"}
                    onClick={() => {
                      setConversationActionMenuId(null)
                      setArchiveViewActive((active) => !active)
                    }}
                    className={`flex size-6 items-center justify-center rounded-md transition-all hover:bg-[#e7e5dd] hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:outline-none dark:hover:bg-white/[0.1] ${
                      showArchiveView
                        ? "bg-[#f0ede6] text-foreground dark:bg-muted"
                        : isMobile
                          ? "text-foreground/60 opacity-100"
                          : "text-foreground/45 opacity-0 group-hover/archive-section:opacity-100 focus-visible:opacity-100"
                    }`}
                  >
                    {showArchiveView ? (
                      <ArchiveRestore className="size-3.5" />
                    ) : (
                      <Archive className="size-3.5" />
                    )}
                  </button>
                )}
              </SidebarGroupLabel>
              <SidebarGroupContent
                data-scrollbar-visible={
                  isConversationScrollbarVisible ? "true" : "false"
                }
                onScroll={handleConversationScroll}
                onWheel={handleConversationWheel}
                onTouchMove={handleConversationTouchMove}
                className="sidebar-conversation-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
              >
                {conversationsLoading ? (
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
                      const isArchived = typeof conv.archivedAt === "number"
                      const isRunning =
                        Boolean(state.activeChatStreams[conv.id]) ||
                        (state.activeConversationId === conv.id &&
                          state.isStreaming &&
                          state.streamingConversationId === conv.id)
                      const isActiveConversationRow =
                        state.activeConversationId === conv.id && isOnChatHome
                      const activityAt = getConversationLastMessageAt(conv)
                      const activityLabel = formatConversationActivityAge(
                        activityAt,
                        currentTime
                      )
                      return (
                        <SidebarMenuItem key={conv.id}>
                          <SidebarMenuButton
                            tooltip={conv.title}
                            isActive={isActiveConversationRow}
                            onClick={() => handleSelectConversation(conv)}
                            onPointerDown={(event) =>
                              handleConversationLongPressStart(event, conv)
                            }
                            onPointerMove={handleConversationLongPressMove}
                            onPointerUp={clearConversationActionLongPress}
                            onPointerCancel={clearConversationActionLongPress}
                            onPointerLeave={clearConversationActionLongPress}
                            onContextMenu={(event) =>
                              handleConversationLongPressContextMenu(
                                event,
                                conv
                              )
                            }
                            onFocus={() => {
                              void prefetchConversationMessages(conv.id)
                            }}
                            onPointerEnter={(event) => {
                              if (event.pointerType === "touch") return
                              void prefetchConversationMessages(conv.id)
                            }}
                            aria-haspopup={!isArchived ? "menu" : undefined}
                            aria-expanded={
                              !isArchived
                                ? conversationActionMenuId === conv.id
                                : undefined
                            }
                            draggable={false}
                            className={`touch-pan-y select-none text-[15px] text-foreground/75 group-has-data-[sidebar=menu-action]/menu-item:pr-12 [-webkit-touch-callout:none] [-webkit-user-select:none] group-hover/menu-item:bg-[#f0ede6] group-hover/menu-item:text-foreground group-has-[[data-state=open]]/menu-item:bg-[#f0ede6] group-has-[[data-state=open]]/menu-item:text-foreground hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:group-hover/menu-item:bg-muted dark:group-has-[[data-state=open]]/menu-item:bg-muted dark:hover:bg-muted dark:data-[active=true]:bg-muted ${conversationActionMenuId === conv.id ? "bg-[#f0ede6] text-foreground dark:bg-muted" : ""} ${isFiltering ? "h-auto min-h-10 items-start py-1.5" : ""}`}
                          >
                            <span className="min-w-0 flex-1">
                              <span
                                className={`block truncate ${unread ? "font-semibold" : ""}`}
                              >
                                <AnimatedTitle title={conv.title} />
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
                          {isArchived ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <SidebarMenuAction
                                  type="button"
                                  aria-label="Archived conversation actions"
                                  className="!top-0 !right-0 !bottom-0 !h-full !w-[42px] !rounded-md text-foreground hover:bg-[#e7e5dd] focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none data-[state=open]:bg-[#e7e5dd] dark:hover:bg-white/[0.1] dark:data-[state=open]:bg-white/[0.1]"
                                >
                                  <MoreHorizontal className="!size-[20px]" />
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
                                  onClick={() =>
                                    handleRestoreConversation(conv)
                                  }
                                  className="cursor-pointer gap-2 px-2 py-1.5 text-[14px]"
                                >
                                  <ArchiveRestore
                                    className="size-4"
                                    strokeWidth={1.5}
                                  />
                                  Restore
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    handleDeleteConversation(conv.id)
                                  }
                                  className="cursor-pointer gap-2 px-2 py-1.5 text-[14px] text-[#802020] focus:bg-red-50 focus:text-[#802020]"
                                >
                                  <Trash className="size-4" strokeWidth={1.5} />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            <>
                              {isMobile ? (
                                <div
                                  data-sidebar="menu-action"
                                  aria-hidden="true"
                                  className="pointer-events-none absolute top-0 right-0 bottom-0 flex h-full w-[42px] items-center justify-center rounded-md text-foreground"
                                >
                                  {isRunning ? (
                                    <LoaderCircle className="!size-[16px] animate-spin text-foreground/45" />
                                  ) : activityLabel ? (
                                    <span
                                      className={`w-full truncate text-center text-[12px] tabular-nums ${unread ? "font-semibold text-[#b76440]" : "font-normal text-foreground/45"}`}
                                      title={formatConversationActivityTitle(
                                        activityAt
                                      )}
                                    >
                                      {activityLabel}
                                    </span>
                                  ) : unread ? (
                                    <span className="size-2 rounded-full bg-[#b76440]" />
                                  ) : null}
                                </div>
                              ) : (
                                <SidebarMenuAction
                                  type="button"
                                  aria-label="Archive conversation"
                                  title="Archive"
                                  onClick={(event) =>
                                    handleArchiveConversation(event, conv.id)
                                  }
                                  className="!top-0 !right-0 !bottom-0 !h-full !w-[42px] !rounded-md text-foreground hover:bg-[#e7e5dd] focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none dark:hover:bg-white/[0.1]"
                                >
                                  {isRunning ? (
                                    <LoaderCircle className="!size-[16px] animate-spin text-foreground/45 group-focus-within/menu-item:hidden group-hover/menu-item:hidden" />
                                  ) : activityLabel ? (
                                    <span
                                      className={`w-full truncate text-center text-[12px] tabular-nums group-focus-within/menu-item:hidden group-hover/menu-item:hidden ${unread ? "font-semibold text-[#b76440]" : "font-normal text-foreground/45"}`}
                                      title={formatConversationActivityTitle(
                                        activityAt
                                      )}
                                    >
                                      {activityLabel}
                                    </span>
                                  ) : unread ? (
                                    <span className="size-2 rounded-full bg-[#b76440] group-focus-within/menu-item:hidden group-hover/menu-item:hidden" />
                                  ) : null}
                                  <Archive className="hidden !size-[15px] group-focus-within/menu-item:block group-hover/menu-item:block" />
                                </SidebarMenuAction>
                              )}
                              {conversationActionMenuId === conv.id && (
                                <div
                                  data-conversation-action-menu="true"
                                  role="menu"
                                  className="absolute top-[calc(100%-2px)] right-2 z-50 w-36 rounded-lg border border-border/60 bg-background p-1 shadow-lg dark:bg-popover"
                                  onClick={(event) => event.stopPropagation()}
                                  onPointerDown={(event) =>
                                    event.stopPropagation()
                                  }
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={(event) =>
                                      handleArchiveConversation(event, conv.id)
                                    }
                                    className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] text-foreground transition-colors hover:bg-[#f0ede6] focus-visible:ring-2 focus-visible:ring-foreground/15 focus-visible:outline-none dark:hover:bg-muted"
                                  >
                                    <Archive
                                      className="size-4"
                                      strokeWidth={1.5}
                                    />
                                    Archive
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={(event) =>
                                      handleDeleteConversationAction(
                                        event,
                                        conv.id
                                      )
                                    }
                                    className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[14px] text-[#802020] transition-colors hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-[#802020]/20 focus-visible:outline-none dark:hover:bg-red-950/30"
                                  >
                                    <Trash
                                      className="size-4"
                                      strokeWidth={1.5}
                                    />
                                    Delete
                                  </button>
                                </div>
                              )}
                            </>
                          )}
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
                ) : showArchiveView ? (
                  <p className="px-2 text-[14px] whitespace-nowrap text-foreground/45">
                    {archivedError ?? "No archived chats yet."}
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

      <SidebarFooter className="shrink-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Library"
              isActive={isOnLibrary}
              className="text-[15px] text-foreground/75 hover:bg-[#f0ede6] hover:text-foreground data-[active=true]:bg-[#f0ede6] data-[active=true]:text-foreground dark:hover:bg-muted dark:data-[active=true]:bg-muted"
            >
              <Link
                href="/library"
                replace={isMobile}
                onClick={closeMobileSidebar}
              >
                <LibraryIcon className="size-4" />
                <span>Library</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {showSettingsLink && (
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
          )}
          {currentProfile && (
            <SidebarMenuItem>
              <DropdownMenu
                open={profileMenuOpen}
                onOpenChange={setProfileMenuOpen}
              >
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    ref={profileTriggerRef}
                    tooltip={currentProfile.name}
                    className="text-[15px] text-foreground/75 hover:bg-[#f0ede6] hover:text-foreground data-[state=open]:bg-[#f0ede6] data-[state=open]:text-foreground dark:hover:bg-muted dark:data-[state=open]:bg-muted"
                  >
                    <span
                      className="grid size-4 shrink-0 place-items-center rounded-[4px] text-[9px] font-semibold leading-none text-white"
                      style={{ backgroundColor: currentProfile.color }}
                    >
                      {profileInitials(currentProfile.name)}
                    </span>
                    <span className="truncate">{currentProfile.name}</span>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side={isMobile ? "top" : "right"}
                  align={isMobile ? "start" : "end"}
                  sideOffset={isMobile ? 8 : 4}
                  collisionPadding={12}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    window.requestAnimationFrame(() => {
                      profileTriggerRef.current?.blur()
                    })
                  }}
                  className={`w-52 ${isMobile ? "z-[70] rounded-xl shadow-xl" : ""}`}
                >
                  <DropdownMenuItem onClick={handleSwitchProfile}>
                    <UserRound className="mr-2 size-4" />
                    Switch profile
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleLogoutProfile}>
                    <LogOut className="mr-2 size-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      const media = window.matchMedia(query)
      media.addEventListener("change", onStoreChange)
      return () => media.removeEventListener("change", onStoreChange)
    },
    [query]
  )
  const getSnapshot = React.useCallback(
    () => window.matchMedia(query).matches,
    [query]
  )
  const getServerSnapshot = React.useCallback(() => false, [])

  return React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  )
}
