import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './ChatArea.css';
import { TypingIndicator } from './TypingIndicator.jsx';
import { IconArrowDown, IconClose, IconArrowLeft } from '../shared/icons.jsx';
import {
    buildAgentPanelMessage,
    findAgentToolCallInMessages,
    findLatestAgentToolCallInMessages,
} from './agentCallUtils.js';

const USER_SCROLL_FOCUS_OFFSET = 12;
const AUTO_SCROLL_SNAP_DISTANCE = 24;
const SCROLL_AT_BOTTOM_SENTINEL = Number.MAX_SAFE_INTEGER;
const INPUT_FLIP_DURATION_MS = 260;
const EXIT_FADE_DURATION_MS = INPUT_FLIP_DURATION_MS;
const ENTER_FADE_DURATION_MS = 340;
const DRAFT_SCROLL_KEY = '__draft__';
const SCROLL_POSITIONS_STORAGE_KEY = 'orchestrator.chat.scroll_positions.v1';
const AGENT_PANEL_STACK_STORAGE_KEY = 'orchestrator.chat.agent_panel_stack.v1';
const AGENT_PANEL_SCROLL_POSITIONS_STORAGE_KEY = 'orchestrator.chat.agent_panel_scroll_positions.v1';
const Message = lazy(() => import('./Message.jsx').then((module) => ({ default: module.Message })));
const ToolDetailPanel = lazy(() => import('./ToolDetailPanel.jsx').then((module) => ({ default: module.ToolDetailPanel })));
const BrowserAgentPanel = lazy(() => import('./BrowserAgentPanel.jsx').then((module) => ({ default: module.BrowserAgentPanel })));

function getElementOffsets(container, element) {
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const top = elementRect.top - containerRect.top + container.scrollTop;
    const bottom = elementRect.bottom - containerRect.top + container.scrollTop;
    return { top, bottom };
}

function normalizeConversationKey(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
}

function getConversationStorageKey(value) {
    return normalizeConversationKey(value) ?? DRAFT_SCROLL_KEY;
}

function getMaxScrollTop(container) {
    if (!container) {
        return 0;
    }

    return Math.max(0, container.scrollHeight - container.clientHeight);
}

function getDistanceToBottom(container) {
    if (!container) {
        return 0;
    }

    return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
}

function loadScrollPositions() {
    if (typeof window === 'undefined') return {};

    try {
        const raw = window.localStorage.getItem(SCROLL_POSITIONS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const sanitized = {};
        for (const [key, value] of Object.entries(parsed)) {
            const numericValue = Number(value);
            if (Number.isFinite(numericValue) && numericValue >= 0) {
                sanitized[key] = Math.trunc(numericValue);
            }
        }
        return sanitized;
    } catch {
        return {};
    }
}

function persistScrollPositions(scrollPositions) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(
            SCROLL_POSITIONS_STORAGE_KEY,
            JSON.stringify(scrollPositions),
        );
    } catch {
        // Ignore localStorage quota/permission issues.
    }
}

function sanitizeAgentPanelEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const callId = String(entry.callId ?? '').trim();
    if (!callId) {
        return null;
    }

    return {
        callId,
        agentId: String(entry.agentId ?? '').trim(),
        agentName: String(entry.agentName ?? '').trim() || 'Agent',
        instanceId: String(entry.instanceId ?? '').trim(),
        instanceLabel: String(entry.instanceLabel ?? '').trim(),
        toolName: String(entry.toolName ?? '').trim(),
        sourceContext: entry.sourceContext ?? null,
        toolPart: entry.toolPart ?? null,
    };
}

function loadAgentPanelStacks() {
    if (typeof window === 'undefined') return {};

    try {
        const raw = window.localStorage.getItem(AGENT_PANEL_STACK_STORAGE_KEY);
        if (!raw) return {};

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        const sanitized = {};
        for (const [key, value] of Object.entries(parsed)) {
            const conversationKey = normalizeConversationKey(key);
            if (!conversationKey || !Array.isArray(value)) {
                continue;
            }

            const stack = value
                .map(sanitizeAgentPanelEntry)
                .filter(Boolean);
            if (stack.length > 0) {
                sanitized[conversationKey] = stack;
            }
        }

        return sanitized;
    } catch {
        return {};
    }
}

function persistAgentPanelStacks(stacks) {
    if (typeof window === 'undefined') return;

    try {
        window.localStorage.setItem(
            AGENT_PANEL_STACK_STORAGE_KEY,
            JSON.stringify(stacks),
        );
    } catch {
        // Ignore localStorage quota/permission issues.
    }
}

function loadAgentPanelScrollPositions() {
    if (typeof window === 'undefined') return {};

    try {
        const raw = window.localStorage.getItem(AGENT_PANEL_SCROLL_POSITIONS_STORAGE_KEY);
        if (!raw) return {};

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        const sanitized = {};
        for (const [conversationKey, value] of Object.entries(parsed)) {
            const normalizedConversationKey = normalizeConversationKey(conversationKey);
            if (!normalizedConversationKey || !value || typeof value !== 'object' || Array.isArray(value)) {
                continue;
            }

            const entryMap = {};
            for (const [panelKey, scrollTop] of Object.entries(value)) {
                const normalizedPanelKey = String(panelKey ?? '').trim();
                const numericValue = Number(scrollTop);
                if (normalizedPanelKey && Number.isFinite(numericValue) && numericValue >= 0) {
                    entryMap[normalizedPanelKey] = Math.trunc(numericValue);
                }
            }

            if (Object.keys(entryMap).length > 0) {
                sanitized[normalizedConversationKey] = entryMap;
            }
        }

        return sanitized;
    } catch {
        return {};
    }
}

function persistAgentPanelScrollPositions(scrollPositions) {
    if (typeof window === 'undefined') return;

    try {
        window.localStorage.setItem(
            AGENT_PANEL_SCROLL_POSITIONS_STORAGE_KEY,
            JSON.stringify(scrollPositions),
        );
    } catch {
        // Ignore localStorage quota/permission issues.
    }
}

function buildAgentPanelScrollKey(selection, stack = []) {
    const stackPath = Array.isArray(stack)
        ? stack.map((entry) => String(entry?.callId ?? '').trim()).filter(Boolean).join('>')
        : '';
    const callId = String(selection?.callId ?? '').trim();
    const instanceId = String(selection?.instanceId ?? '').trim();
    const baseKey = stackPath || callId;
    if (!baseKey) {
        return '';
    }

    return [baseKey, instanceId].filter(Boolean).join(':');
}

function MessageFallback({ role = 'ai' }) {
    if (role === 'user') {
        return (
            <div className="message-user">
                <div className="message-user-stack">
                    <div className="message-user-bubble">Loading message…</div>
                </div>
            </div>
        );
    }

    return (
        <div className="message-ai">
            <div className="message-ai-content">
                <div className="message-markdown ai">Loading message…</div>
            </div>
        </div>
    );
}

function syncInputSlotHeight(slot) {
    if (!slot || !slot.parentElement) {
        return null;
    }

    const nextRect = slot.getBoundingClientRect();
    slot.parentElement.style.setProperty('--input-slot-height', `${nextRect.height}px`);
    return nextRect;
}

export function ChatArea({
    greeting,
    messages,
    isTyping,
    isChatMode,
    conversationKey,
    clientId,
    activeChatKind = null,
    onReplyFromMessage,
    agentStreaming,
    commandChunks,
    emptyStateFallback,
    disableScrollAnchoring = false,
    children,
}) {
    const scrollRef = useRef(null);
    const exitSnapshotRef = useRef(null);
    const lastUserMsgRef = useRef(null);
    const lastAiMsgRef = useRef(null);
    const shouldAutoFollowRef = useRef(false);
    const isProgrammaticScrollRef = useRef(false);
    const isJumpingToBottomRef = useRef(false);
    const previousUserMessageCountRef = useRef(0);
    const anchoredUserMessageIdRef = useRef('');
    const anchorLayoutRafRef = useRef(null);
    const spacerRef = useRef(null);
    const inputSlotRef = useRef(null);
    const inputFlipAnimationRef = useRef(null);
    const previousInputSlotRectRef = useRef(null);
    const previousRenderChatModeRef = useRef(isChatMode);
    const previousChatModeRef = useRef(isChatMode);
    const previousConversationKeyRef = useRef(conversationKey);
    const pendingScrollRestoreConversationRef = useRef(getConversationStorageKey(conversationKey));
    const pendingConversationEnterAnimationRef = useRef(null);
    const scrollPositionsRef = useRef(loadScrollPositions());
    const exitSnapshotScrollTopRef = useRef(0);
    const lastKnownScrollTopRef = useRef(0);
    const latestChatMessagesRef = useRef(messages);
    const enterFadeTimeoutRef = useRef(null);
    const exitFadeTimeoutRef = useRef(null);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const [exitSnapshotMessages, setExitSnapshotMessages] = useState([]);
    const [isConversationEnterVisible, setIsConversationEnterVisible] = useState(false);
    const agentPanelBodyRef = useRef(null);
    const agentPanelAutoFollowRef = useRef(true);
    const agentPanelProgrammaticScrollRef = useRef(false);
    const agentPanelStacksRef = useRef(null);
    const agentPanelScrollPositionsRef = useRef(loadAgentPanelScrollPositions());
    const panelLayoutFreezeTopRef = useRef(null);
    const panelLayoutFreezeRafRef = useRef(null);
    const panelLayoutFreezeTimeoutRef = useRef(null);
    const previousSidePanelStateRef = useRef({ isAgentPanelOpen: false, isToolPanelOpen: false });
    if (agentPanelStacksRef.current === null) {
        agentPanelStacksRef.current = loadAgentPanelStacks();
    }
    const [agentPanelStack, setAgentPanelStack] = useState(() => {
        const key = normalizeConversationKey(conversationKey);
        return key ? (agentPanelStacksRef.current[key] ?? []) : [];
    });
    const activeAgentCallSelection = agentPanelStack.length > 0 ? agentPanelStack[agentPanelStack.length - 1] : null;
    const persistAgentPanelStack = useCallback((rawKey, stack) => {
        const key = normalizeConversationKey(rawKey);
        const nextStack = Array.isArray(stack)
            ? stack.map(sanitizeAgentPanelEntry).filter(Boolean)
            : [];

        if (!key) {
            return;
        }

        const nextStacks = { ...agentPanelStacksRef.current };
        if (nextStack.length > 0) {
            nextStacks[key] = nextStack;
        } else {
            delete nextStacks[key];
        }

        agentPanelStacksRef.current = nextStacks;
        persistAgentPanelStacks(nextStacks);
    }, []);
    const applyAgentPanelStack = useCallback((value, rawKey = conversationKey) => {
        setAgentPanelStack((prev) => {
            const next = typeof value === 'function' ? value(prev) : value;
            const sanitizedNext = Array.isArray(next)
                ? next.map(sanitizeAgentPanelEntry).filter(Boolean)
                : [];
            persistAgentPanelStack(rawKey, sanitizedNext);
            return sanitizedNext;
        });
    }, [conversationKey, persistAgentPanelStack]);
    const setActiveAgentCallSelection = useCallback((value) => {
        if (value === null) {
            applyAgentPanelStack([]);
        } else if (typeof value === 'function') {
            applyAgentPanelStack((prev) => {
                const current = prev.length > 0 ? prev[prev.length - 1] : null;
                const result = value(current);
                if (result === null) return [];
                if (prev.length === 0) return [result];
                return [...prev.slice(0, -1), result];
            });
        } else {
            applyAgentPanelStack([value]);
        }
    }, [applyAgentPanelStack]);
    const [activeToolPanelSelection, setActiveToolPanelSelection] = useState(null);
    const [noSpacerAnim, setNoSpacerAnim] = useState(false);
    const [isConversationHidden, setIsConversationHidden] = useState(false);
    const userMessageCount = useMemo(
        () => messages.reduce(
            (count, message) => (message.role === 'user' ? count + 1 : count),
            0,
        ),
        [messages],
    );
    const lastUserMsgId = [...messages].reverse().find((message) => message.role === 'user')?.id;
    const lastAiMsgId = [...messages].reverse().find((message) => message.role === 'ai')?.id;

    const saveConversationScrollPosition = useCallback((rawKey, scrollTop) => {
        if (!Number.isFinite(scrollTop)) {
            return;
        }

        const key = getConversationStorageKey(rawKey);

        const normalizedTop = Math.max(0, Math.trunc(scrollTop));
        if (scrollPositionsRef.current[key] === normalizedTop) {
            return;
        }

        scrollPositionsRef.current = {
            ...scrollPositionsRef.current,
            [key]: normalizedTop,
        };
        persistScrollPositions(scrollPositionsRef.current);
    }, []);

    const saveActiveConversationScrollPosition = useCallback((container = scrollRef.current) => {
        if (!container) return;
        const maxScrollTop = getMaxScrollTop(container);
        const distanceFromBottom = Math.max(0, maxScrollTop - container.scrollTop);
        const scrollTop = distanceFromBottom <= AUTO_SCROLL_SNAP_DISTANCE
            ? SCROLL_AT_BOTTOM_SENTINEL
            : container.scrollTop;
        saveConversationScrollPosition(conversationKey, scrollTop);
    }, [conversationKey, saveConversationScrollPosition]);

    const saveAgentPanelScrollPosition = useCallback((rawConversationKey, panelKey, scrollTop) => {
        const conversationStorageKey = normalizeConversationKey(rawConversationKey);
        const normalizedPanelKey = String(panelKey ?? '').trim();
        const numericScrollTop = Number(scrollTop);
        if (!conversationStorageKey || !normalizedPanelKey || !Number.isFinite(numericScrollTop)) {
            return;
        }

        const normalizedScrollTop = Math.max(0, Math.trunc(numericScrollTop));
        const currentConversationMap = agentPanelScrollPositionsRef.current[conversationStorageKey] ?? {};
        if (currentConversationMap[normalizedPanelKey] === normalizedScrollTop) {
            return;
        }

        const nextConversationMap = {
            ...currentConversationMap,
            [normalizedPanelKey]: normalizedScrollTop,
        };
        agentPanelScrollPositionsRef.current = {
            ...agentPanelScrollPositionsRef.current,
            [conversationStorageKey]: nextConversationMap,
        };
        persistAgentPanelScrollPositions(agentPanelScrollPositionsRef.current);
    }, []);

    const handleAgentCallToggle = useCallback((payload) => {
        const callId = String(payload?.callId ?? '').trim();
        if (!callId) {
            return;
        }
        const toggleSource = String(payload?.toggleSource ?? 'main').trim().toLowerCase();

        // Close tool panel when opening agent panel
        setActiveToolPanelSelection(null);

        const newEntry = {
            callId,
            agentId: String(payload?.agentId ?? '').trim(),
            agentName: String(payload?.agentName ?? '').trim() || 'Agent',
            instanceId: String(payload?.instanceId ?? '').trim(),
            instanceLabel: String(payload?.instanceLabel ?? '').trim(),
            toolName: String(payload?.toolName ?? '').trim(),
            sourceContext: payload?.sourceContext ?? null,
            toolPart: payload?.toolPart ?? null,
        };

        applyAgentPanelStack((prev) => {
            const topEntry = prev.length > 0 ? prev[prev.length - 1] : null;
            const isSameEntry = (entry) => (
                !!entry
                && entry.callId === newEntry.callId
                && String(entry.instanceId ?? '').trim() === newEntry.instanceId
            );

            if (toggleSource !== 'panel') {
                if (isSameEntry(topEntry)) {
                    return [];
                }
                return [newEntry];
            }

            if (isSameEntry(topEntry)) {
                return prev.length > 1 ? prev.slice(0, -1) : [];
            }

            const existingIndex = prev.findIndex((entry) => isSameEntry(entry));
            if (existingIndex >= 0) {
                return prev.slice(0, existingIndex + 1);
            }

            if (prev.length === 0) {
                return [newEntry];
            }

            return [...prev, newEntry];
        });
    }, [applyAgentPanelStack]);

    const handleAgentPanelBack = useCallback(() => {
        applyAgentPanelStack((prev) => prev.length > 1 ? prev.slice(0, -1) : prev);
    }, [applyAgentPanelStack]);

    const handleToolPanelToggle = useCallback((payload) => {
        const callId = String(payload?.callId ?? '').trim();
        if (!callId) return;

        setActiveToolPanelSelection((previous) => {
            if (previous?.callId === callId) {
                return null;
            }

            // Close agent panel when opening tool panel
            setActiveAgentCallSelection(null);

            return {
                callId,
                toolName: String(payload?.toolName ?? '').trim(),
                toolPart: payload?.toolPart ?? null,
            };
        });
    }, [setActiveAgentCallSelection]);

    const refreshScrollButton = useCallback((container) => {
        const distanceToBottom = getDistanceToBottom(container);

        if (isJumpingToBottomRef.current) {
            if (distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE) {
                isJumpingToBottomRef.current = false;
            } else {
                setShowScrollToBottom((prev) => (prev ? false : prev));
                return distanceToBottom;
            }
        }

        const shouldShow = distanceToBottom > AUTO_SCROLL_SNAP_DISTANCE;
        setShowScrollToBottom((prev) => (prev === shouldShow ? prev : shouldShow));
        return distanceToBottom;
    }, []);

    const setSpacerHeight = useCallback((value) => {
        const spacer = spacerRef.current;
        if (!spacer) {
            return;
        }

        const normalized = Math.max(0, Math.ceil(Number(value) || 0));
        const next = `${normalized}px`;
        if (spacer.style.height !== next) {
            spacer.style.height = next;
        }
    }, []);

    const clearAnchorMode = useCallback(({ resetScrollPosition = false } = {}) => {
        anchoredUserMessageIdRef.current = '';
        setSpacerHeight(0);

        if (resetScrollPosition) {
            const container = scrollRef.current;
            if (container) {
                lastKnownScrollTopRef.current = container.scrollTop;
                refreshScrollButton(container);
            }
        }
    }, [refreshScrollButton, setSpacerHeight]);

    const applyAnchorLayout = useCallback(({ behavior = 'auto' } = {}) => {
        if (disableScrollAnchoring) {
            setSpacerHeight(0);
            return false;
        }

        const container = scrollRef.current;
        const userEl = lastUserMsgRef.current;
        const anchorMessageId = anchoredUserMessageIdRef.current;
        if (!container || !userEl || !anchorMessageId) {
            setSpacerHeight(0);
            return false;
        }

        if (!lastUserMsgId || anchorMessageId !== lastUserMsgId) {
            anchoredUserMessageIdRef.current = '';
            setSpacerHeight(0);
            return false;
        }

        setSpacerHeight(0);
        const { top: userTop } = getElementOffsets(container, userEl);
        const targetScrollTop = Math.max(0, userTop - USER_SCROLL_FOCUS_OFFSET);
        const contentHeightWithoutSpacer = container.scrollHeight;
        const requiredSpacer = Math.max(
            0,
            targetScrollTop + container.clientHeight - contentHeightWithoutSpacer,
        );
        setSpacerHeight(requiredSpacer);

        const maxScrollTop = getMaxScrollTop(container);
        const resolvedTargetTop = Math.min(targetScrollTop, maxScrollTop);
        isProgrammaticScrollRef.current = true;
        container.scrollTo({
            top: resolvedTargetTop,
            behavior,
        });
        lastKnownScrollTopRef.current = resolvedTargetTop;
        refreshScrollButton(container);
        saveActiveConversationScrollPosition(container);

        requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = false;
        });
        return true;
    }, [
        disableScrollAnchoring,
        lastUserMsgId,
        refreshScrollButton,
        saveActiveConversationScrollPosition,
        setSpacerHeight,
    ]);

    useLayoutEffect(() => {
        const slot = inputSlotRef.current;
        if (!slot) return;

        const nextRect = syncInputSlotHeight(slot);
        if (!nextRect) return;

        const previousRect = previousInputSlotRectRef.current;
        const wasChatMode = previousRenderChatModeRef.current;
        const prefersReducedMotion = (
            typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        );

        if (!prefersReducedMotion && previousRect && wasChatMode && !isChatMode && typeof slot.animate === 'function') {
            const translateX = previousRect.left - nextRect.left;
            const translateY = previousRect.top - nextRect.top;

            if (Math.abs(translateX) > 0.5 || Math.abs(translateY) > 0.5) {
                inputFlipAnimationRef.current?.cancel();
                inputFlipAnimationRef.current = slot.animate(
                    [
                        { transform: `translate(${translateX}px, ${translateY}px)` },
                        { transform: 'translate(0, 0)' },
                    ],
                    {
                        duration: INPUT_FLIP_DURATION_MS,
                        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                    },
                );
            }
        }

        previousInputSlotRectRef.current = nextRect;
        previousRenderChatModeRef.current = isChatMode;
    });

    useEffect(() => {
        const slot = inputSlotRef.current;
        if (!slot || typeof ResizeObserver === 'undefined') {
            return undefined;
        }

        const observer = new ResizeObserver(() => {
            syncInputSlotHeight(slot);
        });

        observer.observe(slot);
        syncInputSlotHeight(slot);

        return () => observer.disconnect();
    }, []);

    useLayoutEffect(() => {
        if (isChatMode && messages.length > 0) {
            latestChatMessagesRef.current = messages;
        }
    }, [isChatMode, messages]);

    useLayoutEffect(() => {
        const previousConversationKey = previousConversationKeyRef.current;
        if (previousConversationKey === conversationKey) {
            return;
        }

        const container = scrollRef.current;
        if (container) {
            const maxScrollTop = getMaxScrollTop(container);
            const distanceToBottom = Math.max(0, maxScrollTop - container.scrollTop);
            const shouldPersistBottom = shouldAutoFollowRef.current || distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE;
            const scrollTopToSave = shouldPersistBottom
                ? SCROLL_AT_BOTTOM_SENTINEL
                : Math.max(0, lastKnownScrollTopRef.current || container.scrollTop || 0);
            saveConversationScrollPosition(previousConversationKey, scrollTopToSave);
        }

        const hasConcreteConversation = conversationKey !== null && conversationKey !== undefined;
        const isTransitioningDraftToSaved = (
            (previousConversationKey === null || previousConversationKey === undefined)
            && hasConcreteConversation
            && previousChatModeRef.current
            && userMessageCount > 0
        );

        previousConversationKeyRef.current = conversationKey;
        previousUserMessageCountRef.current = userMessageCount;
        isJumpingToBottomRef.current = false;
        setNoSpacerAnim(hasConcreteConversation);

        if (isTransitioningDraftToSaved) {
            pendingScrollRestoreConversationRef.current = null;
            if (container) {
                lastKnownScrollTopRef.current = container.scrollTop;
                const scrollTopToSave = shouldAutoFollowRef.current
                    ? SCROLL_AT_BOTTOM_SENTINEL
                    : container.scrollTop;
                saveConversationScrollPosition(conversationKey, scrollTopToSave);
            }
            return;
        }

        pendingScrollRestoreConversationRef.current = getConversationStorageKey(conversationKey);
        pendingConversationEnterAnimationRef.current = hasConcreteConversation ? conversationKey : null;
        shouldAutoFollowRef.current = false;
        clearAnchorMode();
        setActiveToolPanelSelection(null);
        applyAgentPanelStack(
            hasConcreteConversation
                ? (agentPanelStacksRef.current[normalizeConversationKey(conversationKey)] ?? [])
                : [],
            conversationKey,
        );

        if (hasConcreteConversation) {
            setIsConversationHidden(messages.length === 0);
        }
    }, [
        conversationKey,
        userMessageCount,
        saveConversationScrollPosition,
        clearAnchorMode,
        messages.length,
        applyAgentPanelStack,
    ]);

    // Declanseaza animatia de enter abia cand mesajele sunt disponibile.
    // Astfel evitam flash-ul cu greeting-ul si lipsa fade-ului dupa refresh.
    useLayoutEffect(() => {
        if (!isChatMode) return;
        if (!conversationKey) return;
        if (messages.length === 0) return;
        if (pendingConversationEnterAnimationRef.current !== conversationKey) return;

        setIsConversationHidden(false);
        if (enterFadeTimeoutRef.current) clearTimeout(enterFadeTimeoutRef.current);
        setIsConversationEnterVisible(true);
        enterFadeTimeoutRef.current = setTimeout(() => {
            setIsConversationEnterVisible(false);
            enterFadeTimeoutRef.current = null;
        }, ENTER_FADE_DURATION_MS + 80);
        pendingConversationEnterAnimationRef.current = null;
    }, [conversationKey, isChatMode, messages.length]);

    useLayoutEffect(() => {
        const pendingConversationKey = pendingScrollRestoreConversationRef.current;
        if (!pendingConversationKey || !isChatMode) {
            return;
        }

        const hasConcreteConversation = conversationKey !== null && conversationKey !== undefined;
        if (hasConcreteConversation && messages.length === 0) {
            return;
        }

        const activeConversationKey = getConversationStorageKey(conversationKey);
        if (activeConversationKey !== pendingConversationKey) {
            return;
        }

        const container = scrollRef.current;
        if (!container) {
            return;
        }

        clearAnchorMode();
        const maxScrollTop = getMaxScrollTop(container);
        const savedScrollTop = scrollPositionsRef.current[activeConversationKey];
        const shouldRestoreBottom = (
            savedScrollTop === SCROLL_AT_BOTTOM_SENTINEL
            || !Number.isFinite(savedScrollTop)
        );
        const targetScrollTop = shouldRestoreBottom
            ? maxScrollTop
            : Math.min(Math.max(0, savedScrollTop), maxScrollTop);

        shouldAutoFollowRef.current = shouldRestoreBottom || targetScrollTop >= maxScrollTop - AUTO_SCROLL_SNAP_DISTANCE;
        isProgrammaticScrollRef.current = true;
        container.scrollTop = targetScrollTop;
        lastKnownScrollTopRef.current = targetScrollTop;
        refreshScrollButton(container);
        pendingScrollRestoreConversationRef.current = null;
        requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = false;
        });
    }, [conversationKey, isChatMode, messages.length, clearAnchorMode, refreshScrollButton]);

    useLayoutEffect(() => {
        if (previousChatModeRef.current && !isChatMode) {
            const snapshot = latestChatMessagesRef.current;
            if (snapshot.length > 0) {
                if (exitFadeTimeoutRef.current) clearTimeout(exitFadeTimeoutRef.current);

                exitSnapshotScrollTopRef.current = lastKnownScrollTopRef.current;
                setExitSnapshotMessages(snapshot);
                exitFadeTimeoutRef.current = setTimeout(() => {
                    setExitSnapshotMessages([]);
                }, EXIT_FADE_DURATION_MS + 40);
            }
        }

        if (isChatMode && exitSnapshotMessages.length > 0) {
            if (exitFadeTimeoutRef.current) {
                clearTimeout(exitFadeTimeoutRef.current);
                exitFadeTimeoutRef.current = null;
            }
            setExitSnapshotMessages([]);
        }

        previousChatModeRef.current = isChatMode;
    }, [isChatMode, exitSnapshotMessages.length, saveConversationScrollPosition]);

    useLayoutEffect(() => {
        const container = exitSnapshotRef.current;
        if (!container || exitSnapshotMessages.length === 0) return;
        container.scrollTop = exitSnapshotScrollTopRef.current;
    }, [exitSnapshotMessages.length]);

    useEffect(() => () => {
        if (enterFadeTimeoutRef.current) clearTimeout(enterFadeTimeoutRef.current);
        if (exitFadeTimeoutRef.current) clearTimeout(exitFadeTimeoutRef.current);
        if (panelLayoutFreezeTimeoutRef.current) clearTimeout(panelLayoutFreezeTimeoutRef.current);
        if (panelLayoutFreezeRafRef.current !== null) cancelAnimationFrame(panelLayoutFreezeRafRef.current);
        if (anchorLayoutRafRef.current !== null) cancelAnimationFrame(anchorLayoutRafRef.current);
        inputFlipAnimationRef.current?.cancel();
    }, []);

    useEffect(() => () => {
        const container = scrollRef.current;
        const maxScrollTop = getMaxScrollTop(container);
        const distanceToBottom = container
            ? Math.max(0, maxScrollTop - container.scrollTop)
            : 0;
        const shouldPersistBottom = shouldAutoFollowRef.current || distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE;
        const scrollTopToSave = shouldPersistBottom
            ? SCROLL_AT_BOTTOM_SENTINEL
            : Math.max(0, lastKnownScrollTopRef.current || container?.scrollTop || 0);
        saveConversationScrollPosition(
            previousConversationKeyRef.current,
            scrollTopToSave,
        );
    }, [saveConversationScrollPosition]);

    useEffect(() => {
        previousUserMessageCountRef.current = userMessageCount;
    }, [conversationKey, userMessageCount]);

    useEffect(() => {
        if (!isChatMode) {
            previousUserMessageCountRef.current = userMessageCount;
            return;
        }

        if (userMessageCount < previousUserMessageCountRef.current) {
            previousUserMessageCountRef.current = userMessageCount;
            return;
        }

        const hasNewUserMessage = userMessageCount > previousUserMessageCountRef.current;
        if (!hasNewUserMessage) {
            return;
        }

        previousUserMessageCountRef.current = userMessageCount;
        shouldAutoFollowRef.current = false;
        if (disableScrollAnchoring || !lastUserMsgId) {
            clearAnchorMode({ resetScrollPosition: true });
            return;
        }

        anchoredUserMessageIdRef.current = String(lastUserMsgId);
        shouldAutoFollowRef.current = false;
        if (anchorLayoutRafRef.current !== null) {
            cancelAnimationFrame(anchorLayoutRafRef.current);
        }
        anchorLayoutRafRef.current = requestAnimationFrame(() => {
            anchorLayoutRafRef.current = null;
            applyAnchorLayout({ behavior: 'auto' });
        });
    }, [
        userMessageCount,
        isChatMode,
        disableScrollAnchoring,
        lastUserMsgId,
        clearAnchorMode,
        applyAnchorLayout,
    ]);

    function handleScrollToBottom() {
        const container = scrollRef.current;
        if (!container) return;

        clearAnchorMode();
        shouldAutoFollowRef.current = true;
        isJumpingToBottomRef.current = true;
        setShowScrollToBottom(false);
        isProgrammaticScrollRef.current = true;

        container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth',
        });

        const startedAt = performance.now();
        const releaseProgrammaticMode = () => {
            const activeContainer = scrollRef.current;
            if (!activeContainer) {
                isProgrammaticScrollRef.current = false;
                isJumpingToBottomRef.current = false;
                return;
            }

            const distanceToBottom = getDistanceToBottom(activeContainer);
            const timedOut = performance.now() - startedAt > 1400;

            if (distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE || timedOut) {
                isProgrammaticScrollRef.current = false;
                if (timedOut) {
                    isJumpingToBottomRef.current = false;
                }
                lastKnownScrollTopRef.current = activeContainer.scrollTop;
                refreshScrollButton(activeContainer);
                saveActiveConversationScrollPosition(activeContainer);
                return;
            }

            requestAnimationFrame(releaseProgrammaticMode);
        };

        requestAnimationFrame(releaseProgrammaticMode);
    }

    useLayoutEffect(() => {
        if (!isChatMode) {
            return;
        }

        const container = scrollRef.current;
        if (!container) {
            return;
        }

        let firstFrame = null;
        let secondFrame = null;
        const syncLayout = () => {
            if (anchoredUserMessageIdRef.current) {
                applyAnchorLayout({ behavior: 'auto' });
                return;
            }

            setSpacerHeight(0);
            if (shouldAutoFollowRef.current) {
                isProgrammaticScrollRef.current = true;
                container.scrollTop = container.scrollHeight;
                lastKnownScrollTopRef.current = container.scrollTop;
                refreshScrollButton(container);
                saveActiveConversationScrollPosition(container);
                requestAnimationFrame(() => {
                    isProgrammaticScrollRef.current = false;
                });
                return;
            }

            lastKnownScrollTopRef.current = container.scrollTop;
            refreshScrollButton(container);
        };

        firstFrame = requestAnimationFrame(() => {
            syncLayout();
            secondFrame = requestAnimationFrame(syncLayout);
        });

        return () => {
            if (firstFrame !== null) cancelAnimationFrame(firstFrame);
            if (secondFrame !== null) cancelAnimationFrame(secondFrame);
        };
    }, [
        isChatMode,
        messages,
        isTyping,
        applyAnchorLayout,
        refreshScrollButton,
        saveActiveConversationScrollPosition,
        setSpacerHeight,
    ]);

    useEffect(() => {
        if (!isChatMode || typeof ResizeObserver === 'undefined') {
            return undefined;
        }

        const userEl = lastUserMsgRef.current;
        const aiEl = lastAiMsgRef.current;
        if (!userEl && !aiEl) {
            return undefined;
        }

        const observer = new ResizeObserver(() => {
            const container = scrollRef.current;
            if (!container) {
                return;
            }

            if (anchoredUserMessageIdRef.current) {
                applyAnchorLayout({ behavior: 'auto' });
                return;
            }

            if (shouldAutoFollowRef.current) {
                isProgrammaticScrollRef.current = true;
                container.scrollTop = container.scrollHeight;
                lastKnownScrollTopRef.current = container.scrollTop;
                refreshScrollButton(container);
                saveActiveConversationScrollPosition(container);
                requestAnimationFrame(() => {
                    isProgrammaticScrollRef.current = false;
                });
                return;
            }

            refreshScrollButton(container);
        });

        if (userEl) observer.observe(userEl);
        if (aiEl) observer.observe(aiEl);

        return () => observer.disconnect();
    }, [
        isChatMode,
        conversationKey,
        lastUserMsgId,
        lastAiMsgId,
        applyAnchorLayout,
        refreshScrollButton,
        saveActiveConversationScrollPosition,
    ]);

    useEffect(() => {
        const container = scrollRef.current;
        if (!isChatMode || !container) return;

        const handleManualScroll = () => {
            if (isProgrammaticScrollRef.current) return;
            if (pendingScrollRestoreConversationRef.current) return;

            lastKnownScrollTopRef.current = container.scrollTop;
            const distanceToBottom = refreshScrollButton(container);
            const isAtBottom = distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE;
            shouldAutoFollowRef.current = isAtBottom;
            if (!isAtBottom && anchoredUserMessageIdRef.current) {
                clearAnchorMode();
            }
            saveActiveConversationScrollPosition(container);
        };

        container.addEventListener('scroll', handleManualScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleManualScroll);
    }, [isChatMode, conversationKey, clearAnchorMode, refreshScrollButton, saveActiveConversationScrollPosition]);

    const lastMessage = messages[messages.length - 1];
    const shouldRenderTypingIndicator = isTyping && (!lastMessage || lastMessage.role !== 'ai');
    const activeAgentCallDetails = useMemo(() => {
        const callId = String(activeAgentCallSelection?.callId ?? '').trim();
        if (!callId) {
            return null;
        }

        const resolvedFromMessages = findAgentToolCallInMessages(messages, callId);
        if (resolvedFromMessages) {
            return resolvedFromMessages;
        }

        if (!activeAgentCallSelection) {
            return null;
        }

        return {
            callId,
            agentId: activeAgentCallSelection.agentId,
            agentName: activeAgentCallSelection.agentName,
            instanceId: activeAgentCallSelection.instanceId,
            instanceLabel: activeAgentCallSelection.instanceLabel,
            toolName: activeAgentCallSelection.toolName,
            sourceMessageId: '',
            context: activeAgentCallSelection.sourceContext ?? {
                text: '',
                thought: '',
                parts: [],
            },
            toolPart: activeAgentCallSelection.toolPart ?? {
                functionCall: null,
                functionResponse: null,
                isExecuting: false,
            },
        };
    }, [messages, activeAgentCallSelection]);
    const activeAgentPanelMessage = useMemo(() => {
        const callId = String(activeAgentCallSelection?.callId ?? '').trim();

        if (agentStreaming) {
            const streamData = callId ? agentStreaming[callId] : null;
            if (streamData) {
                return {
                    role: 'ai',
                    text: String(streamData.text ?? '').trim(),
                    thought: String(streamData.thought ?? '').trim(),
                    parts: Array.isArray(streamData.parts) ? streamData.parts : [],
                    steps: Array.isArray(streamData.steps) ? streamData.steps : [],
                    thinkingDurationMs: Number(streamData.thinkingDurationMs ?? 0) || 0,
                    isThinking: streamData.isThinking === true,
                };
            }
        }

        // Fall back to completed message data.
        return buildAgentPanelMessage(activeAgentCallDetails, messages);
    }, [activeAgentCallDetails, agentStreaming, activeAgentCallSelection, messages]);
    const activeAgentPanelPayload = useMemo(() => {
        const callId = String(activeAgentCallSelection?.callId ?? '').trim();
        if (callId && agentStreaming?.[callId]) {
            return agentStreaming[callId];
        }

        const responseObject = activeAgentCallDetails?.toolPart?.functionResponse?.response;
        return responseObject && typeof responseObject === 'object' ? responseObject : null;
    }, [activeAgentCallDetails, activeAgentCallSelection, agentStreaming]);
    const activeAgentPanelRenderKey = useMemo(() => {
        const callId = String(activeAgentCallSelection?.callId ?? '').trim();
        const instanceId = String(activeAgentCallSelection?.instanceId ?? '').trim();
        return [callId, instanceId, agentPanelStack.length].filter(Boolean).join(':') || 'agent-panel';
    }, [activeAgentCallSelection, agentPanelStack.length]);
    const activeAgentPanelScrollKey = useMemo(
        () => buildAgentPanelScrollKey(activeAgentCallSelection, agentPanelStack),
        [activeAgentCallSelection, agentPanelStack],
    );
    const latestBrowserAttentionCall = useMemo(() => {
        const streamingEntries = Object.entries(agentStreaming ?? {});
        for (let index = streamingEntries.length - 1; index >= 0; index -= 1) {
            const [callId, payload] = streamingEntries[index];
            const isBrowser = String(payload?.agentId ?? '').trim().toLowerCase() === 'browser';
            const questionType = String(payload?.questionType ?? '').trim().toLowerCase();
            const isWaiting = (
                questionType === 'captcha'
                && String(payload?.status ?? '').trim().toLowerCase() === 'awaiting_user'
            ) || String(payload?.controlMode ?? '').trim().toLowerCase() === 'user';
            if (!isBrowser || !isWaiting) {
                continue;
            }

            const resolved = findAgentToolCallInMessages(messages, callId);
            if (resolved) {
                return resolved;
            }
        }

        const latestBrowserCall = findLatestAgentToolCallInMessages(messages, 'call_browser_agent');
        const responseObject = latestBrowserCall?.toolPart?.functionResponse?.response;
        const responseStatus = String(responseObject?.status ?? '').trim().toLowerCase();
        const controlMode = String(responseObject?.controlMode ?? '').trim().toLowerCase();
        const questionType = String(responseObject?.questionType ?? '').trim().toLowerCase();
        if (latestBrowserCall && ((responseStatus === 'awaiting_user' && questionType === 'captcha') || controlMode === 'user')) {
            return latestBrowserCall;
        }

        return null;
    }, [agentStreaming, messages]);
    const isAgentPanelOpen = isChatMode && !!activeAgentPanelMessage && !!activeAgentCallSelection;
    const isToolPanelOpen = isChatMode && !!activeToolPanelSelection;
    const browserNeedsAttention = Boolean(
        latestBrowserAttentionCall
        && (
            activeAgentCallSelection?.callId !== latestBrowserAttentionCall.callId
            || !isAgentPanelOpen
        ),
    );

    useLayoutEffect(() => {
        const previousState = previousSidePanelStateRef.current;
        const hasLayoutChanged = (
            previousState.isAgentPanelOpen !== isAgentPanelOpen
            || previousState.isToolPanelOpen !== isToolPanelOpen
        );
        previousSidePanelStateRef.current = { isAgentPanelOpen, isToolPanelOpen };

        if (!hasLayoutChanged || !isChatMode) {
            return undefined;
        }

        const container = scrollRef.current;
        if (!container) {
            return undefined;
        }

        const freezeTop = Math.max(0, lastKnownScrollTopRef.current || container.scrollTop || 0);
        panelLayoutFreezeTopRef.current = freezeTop;

        const restoreScrollPosition = () => {
            const activeContainer = scrollRef.current;
            if (!activeContainer) {
                return;
            }

            const maxScrollTop = Math.max(0, activeContainer.scrollHeight - activeContainer.clientHeight);
            activeContainer.scrollTop = Math.min(freezeTop, maxScrollTop);
            lastKnownScrollTopRef.current = activeContainer.scrollTop;
            refreshScrollButton(activeContainer);
        };

        restoreScrollPosition();

        if (panelLayoutFreezeRafRef.current !== null) {
            cancelAnimationFrame(panelLayoutFreezeRafRef.current);
        }
        if (panelLayoutFreezeTimeoutRef.current !== null) {
            clearTimeout(panelLayoutFreezeTimeoutRef.current);
        }

        panelLayoutFreezeRafRef.current = requestAnimationFrame(() => {
            restoreScrollPosition();
            panelLayoutFreezeRafRef.current = requestAnimationFrame(() => {
                restoreScrollPosition();
            });
        });

        panelLayoutFreezeTimeoutRef.current = setTimeout(() => {
            panelLayoutFreezeTopRef.current = null;
            panelLayoutFreezeTimeoutRef.current = null;
        }, 380);

        return () => {
            if (panelLayoutFreezeRafRef.current !== null) {
                cancelAnimationFrame(panelLayoutFreezeRafRef.current);
                panelLayoutFreezeRafRef.current = null;
            }
            if (panelLayoutFreezeTimeoutRef.current !== null) {
                clearTimeout(panelLayoutFreezeTimeoutRef.current);
                panelLayoutFreezeTimeoutRef.current = null;
            }
        };
    }, [isAgentPanelOpen, isToolPanelOpen, isChatMode, refreshScrollButton]);

    useEffect(() => {
        if (!isAgentPanelOpen) {
            return undefined;
        }

        const container = agentPanelBodyRef.current;
        const conversationStorageKey = normalizeConversationKey(conversationKey);
        const panelKey = activeAgentPanelScrollKey;
        if (!container || !conversationStorageKey || !panelKey) {
            return undefined;
        }

        const isBrowserPanel = activeAgentCallSelection?.agentId === 'browser';
        const savedScrollTop = agentPanelScrollPositionsRef.current[conversationStorageKey]?.[panelKey];

        const restoreScroll = () => {
            const activeContainer = agentPanelBodyRef.current;
            if (!activeContainer) {
                return;
            }

            const maxScrollTop = Math.max(0, activeContainer.scrollHeight - activeContainer.clientHeight);
            const targetScrollTop = Number.isFinite(savedScrollTop)
                ? Math.min(Math.max(0, savedScrollTop), maxScrollTop)
                : 0;

            agentPanelProgrammaticScrollRef.current = true;
            activeContainer.scrollTop = targetScrollTop;
            requestAnimationFrame(() => {
                agentPanelProgrammaticScrollRef.current = false;
            });

            const distanceToBottom = maxScrollTop - targetScrollTop;
            agentPanelAutoFollowRef.current = !isBrowserPanel && distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE;
        };

        const restoreFrameId = requestAnimationFrame(restoreScroll);

        const handleScroll = () => {
            if (agentPanelProgrammaticScrollRef.current) {
                return;
            }

            const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            agentPanelAutoFollowRef.current = !isBrowserPanel && distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE;
            saveAgentPanelScrollPosition(conversationStorageKey, panelKey, container.scrollTop);
        };

        const observer = new ResizeObserver(() => {
            const activeContainer = agentPanelBodyRef.current;
            if (!activeContainer) {
                return;
            }

            if (agentPanelAutoFollowRef.current && !isBrowserPanel) {
                agentPanelProgrammaticScrollRef.current = true;
                activeContainer.scrollTop = activeContainer.scrollHeight;
                saveAgentPanelScrollPosition(conversationStorageKey, panelKey, activeContainer.scrollTop);
                requestAnimationFrame(() => {
                    agentPanelProgrammaticScrollRef.current = false;
                });
            }
        });

        observer.observe(container.firstElementChild ?? container);
        container.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            cancelAnimationFrame(restoreFrameId);
            observer.disconnect();
            container.removeEventListener('scroll', handleScroll);
            saveAgentPanelScrollPosition(conversationStorageKey, panelKey, container.scrollTop);
        };
    }, [
        isAgentPanelOpen,
        conversationKey,
        activeAgentPanelScrollKey,
        activeAgentCallSelection?.agentId,
        saveAgentPanelScrollPosition,
    ]);

    return (
        <main
            className={`main-content${isChatMode ? ' chat-active' : ''}${noSpacerAnim ? ' no-spacer-anim' : ''}${isAgentPanelOpen ? ' agent-panel-open' : ''}${isToolPanelOpen ? ' tool-panel-open' : ''}${disableScrollAnchoring ? ' disable-anchoring' : ''}`}
            id="mainContent"
        >
            <div className="chat-main-pane">
                <div className={`landing-spacer${isChatMode ? ' collapsed' : ''}`} />

                {!isChatMode && conversationKey === null && (
                    <div className="greeting-section">
                        <h1 className="greeting-text">{greeting}</h1>
                    </div>
                )}

                {isChatMode && (
                    <>
                        <div className={`chat-messages${isConversationEnterVisible ? ' chat-messages-enter' : ''}${isConversationHidden ? ' chat-messages-hidden' : ''}`} id="chatMessages" ref={scrollRef}>
                            {messages.length === 0 && emptyStateFallback}
                            {messages.map((msg) => {
                                return (
                                    <div
                                        key={msg.id}
                                        className="chat-message-row"
                                    >
                                        <Suspense fallback={<MessageFallback role={msg.role} />}>
                                            <Message
                                                role={msg.role}
                                                text={msg.text}
                                                thought={msg.thought}
                                                parts={msg.parts}
                                                steps={msg.steps}
                                                replyTo={msg.replyTo}
                                                isThinking={
                                                    isTyping
                                                    && msg.id === lastAiMsgId
                                                    && msg.role === 'ai'
                                                    && String(msg.text ?? '').trim().length === 0
                                                }
                                                showReplyAction={activeChatKind === 'inbox' && msg.role === 'ai' && !msg.isFakeNotice}
                                                onReply={activeChatKind === 'inbox' && typeof onReplyFromMessage === 'function' && !msg.isFakeNotice
                                                    ? () => onReplyFromMessage(msg)
                                                    : undefined}
                                                onAgentCallToggle={msg.role === 'ai' ? handleAgentCallToggle : undefined}
                                                onToolPanelToggle={msg.role === 'ai' ? handleToolPanelToggle : undefined}
                                                agentToggleSource="main"
                                                activeAgentCallId={activeAgentCallSelection?.callId ?? ''}
                                                commandChunks={commandChunks}
                                                ref={
                                                    msg.id === lastUserMsgId
                                                        ? lastUserMsgRef
                                                        : msg.id === lastAiMsgId
                                                            ? lastAiMsgRef
                                                            : null
                                                }
                                            />
                                        </Suspense>
                                    </div>
                                );
                            })}
                            {shouldRenderTypingIndicator && <TypingIndicator />}
                            <div ref={spacerRef} style={{ flexShrink: 0, width: '100%' }} />
                        </div>
                    </>
                )}

                {!isChatMode && exitSnapshotMessages.length > 0 && (
                    <div
                        className="chat-messages chat-messages-exit"
                        ref={exitSnapshotRef}
                        aria-hidden="true"
                    >
                        {exitSnapshotMessages.map((msg) => (
                            <Suspense key={`exit-${msg.id}`} fallback={<MessageFallback role={msg.role} />}>
                                <Message
                                    role={msg.role}
                                    text={msg.text}
                                    thought={msg.thought}
                                    parts={msg.parts}
                                    steps={msg.steps}
                                    replyTo={msg.replyTo}
                                />
                            </Suspense>
                        ))}
                    </div>
                )}

                {isChatMode && showScrollToBottom && messages.length > 0 && !messages[0]?.isFakeNotice && (
                    <button
                        className="scroll-to-bottom-btn"
                        type="button"
                        onClick={handleScrollToBottom}
                        title="Scroll to bottom"
                        aria-label="Scroll to bottom"
                    >
                        <IconArrowDown />
                    </button>
                )}

                <div className="chat-input-slot" ref={inputSlotRef}>
                    {browserNeedsAttention && (
                        <div className="chat-input-attention-wrap">
                            <div className="browser-attention-banner">
                                <div className="browser-attention-copy">
                                    <strong>Browser Agent needs you</strong>
                                    <span>
                                        {String(latestBrowserAttentionCall?.toolPart?.functionResponse?.response?.question ?? 'Open the browser panel to continue.').trim()
                                            || 'Open the browser panel to continue.'}
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setActiveAgentCallSelection(latestBrowserAttentionCall)}
                                >
                                    Open panel
                                </button>
                            </div>
                        </div>
                    )}
                    {children}
                </div>
            </div>

            {isToolPanelOpen && activeToolPanelSelection && (
                <Suspense fallback={null}>
                    <ToolDetailPanel
                        selection={activeToolPanelSelection}
                        onClose={() => setActiveToolPanelSelection(null)}
                    />
                </Suspense>
            )}

            {isAgentPanelOpen && activeAgentPanelMessage && (() => {
                const callArgs = activeAgentCallDetails?.toolPart?.functionCall?.args;
                const callSummary = callArgs
                    ? String(callArgs.task ?? callArgs.prompt ?? '').trim()
                    : '';
                const hasBackStack = agentPanelStack.length > 1;
                return (
                    <aside className="agent-side-panel" aria-label="Agent activity panel">
                        <header className="agent-side-header">
                            {hasBackStack && (
                                <button
                                    className="agent-side-back"
                                    onClick={handleAgentPanelBack}
                                    title="Back to parent agent"
                                    aria-label="Back to parent agent"
                                    type="button"
                                >
                                    <IconArrowLeft />
                                </button>
                            )}
                            <div className="agent-side-header-text">
                                <h2 className="agent-side-title">{activeAgentCallDetails?.agentName || 'Agent'}</h2>
                                <p className="agent-side-subtitle">
                                    {String(activeAgentCallDetails?.instanceLabel ?? '').trim()
                                        || String(activeAgentCallDetails?.toolName ?? '').trim()
                                        || 'Agent call'}
                                </p>
                            </div>
                            <button
                                className="agent-side-close"
                                onClick={() => applyAgentPanelStack([])}
                                title="Close panel"
                                aria-label="Close agent panel"
                                type="button"
                            >
                                <IconClose />
                            </button>
                        </header>
                        {callSummary && (
                            <div className="agent-side-call-summary">
                                <p className="agent-side-call-text">{callSummary}</p>
                            </div>
                        )}
                        <div
                            className={`agent-side-body${activeAgentCallDetails?.agentId === 'browser' ? ' browser-agent-body' : ''}`}
                            ref={agentPanelBodyRef}
                        >
                            <div className="agent-side-panel-frame" key={activeAgentPanelRenderKey}>
                                {activeAgentCallDetails?.agentId === 'browser' && activeAgentPanelPayload
                                    ? (
                                        <Suspense fallback={<div style={{ padding: '12px' }}>Loading browser panel…</div>}>
                                            <BrowserAgentPanel
                                                chatId={conversationKey}
                                                clientId={clientId}
                                                payload={activeAgentPanelPayload}
                                            />
                                        </Suspense>
                                    )
                                    : (
                                        <Suspense fallback={<MessageFallback role="ai" />}>
                                            <Message
                                                role="ai"
                                                text={activeAgentPanelMessage.text}
                                                thought={activeAgentPanelMessage.thought}
                                                parts={activeAgentPanelMessage.parts}
                                                steps={activeAgentPanelMessage.steps}
                                                thinkingDurationMs={activeAgentPanelMessage.thinkingDurationMs}
                                                isThinking={activeAgentPanelMessage.isThinking}
                                                onAgentCallToggle={handleAgentCallToggle}
                                                agentToggleSource="panel"
                                                showAllLiveToolCalls
                                                renderMode={activeAgentCallDetails?.agentId === 'browser' ? 'browser_log' : 'default'}
                                            />
                                        </Suspense>
                                    )}
                            </div>
                        </div>
                    </aside>
                );
            })()}
        </main>
    );
}
