import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './ChatArea.css';
import { Message } from './Message.jsx';
import { TypingIndicator } from './TypingIndicator.jsx';
import { IconArrowDown, IconClose, IconArrowLeft } from '../shared/icons.jsx';
import { ToolDetailPanel } from './ToolDetailPanel.jsx';
import {
    buildAgentPanelMessage,
    findAgentToolCallInMessages,
} from './agentCallUtils.js';

const USER_TOP_OFFSET = 54;
const USER_SCROLL_FOCUS_OFFSET = 12;
const AUTO_SCROLL_SNAP_DISTANCE = 24;
const INPUT_FLIP_DURATION_MS = 260;
const EXIT_FADE_DURATION_MS = INPUT_FLIP_DURATION_MS;
const ENTER_FADE_DURATION_MS = 340;
const SCROLL_POSITIONS_STORAGE_KEY = 'orchestrator.chat.scroll_positions.v1';
const AGENT_PANEL_STACK_STORAGE_KEY = 'orchestrator.chat.agent_panel_stack.v1';

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

export function ChatArea({ greeting, messages, isTyping, isChatMode, conversationKey, agentStreaming, commandChunks, children }) {
    const scrollRef = useRef(null);
    const exitSnapshotRef = useRef(null);
    const lastUserMsgRef = useRef(null);
    const lastAiMsgRef = useRef(null);
    const shouldAutoFollowRef = useRef(false);
    const isProgrammaticScrollRef = useRef(false);
    const isJumpingToBottomRef = useRef(false);
    const isAnimatingEnterRef = useRef(false);
    const previousUserMessageCountRef = useRef(0);
    const spacerRef = useRef(null);
    const inputSlotRef = useRef(null);
    const inputFlipAnimationRef = useRef(null);
    const previousInputSlotRectRef = useRef(null);
    const previousRenderChatModeRef = useRef(isChatMode);
    const previousChatModeRef = useRef(isChatMode);
    const previousConversationKeyRef = useRef(conversationKey);
    const baselineConversationKeyRef = useRef(conversationKey);
    const enterAnchorConversationKeyRef = useRef(conversationKey);
    const pendingScrollRestoreConversationRef = useRef(normalizeConversationKey(conversationKey));
    const isInitialScrollRestoreRef = useRef(true);
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
    const agentPanelStacksRef = useRef(null);
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

    const saveConversationScrollPosition = useCallback((rawKey, scrollTop) => {
        const key = normalizeConversationKey(rawKey);
        if (!key || !Number.isFinite(scrollTop)) return;

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
        saveConversationScrollPosition(conversationKey, container.scrollTop);
    }, [conversationKey, saveConversationScrollPosition]);

    const handleAgentCallToggle = useCallback((payload) => {
        const callId = String(payload?.callId ?? '').trim();
        if (!callId) {
            return;
        }

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
            // If clicking the same call as the top of stack, pop it
            if (prev.length > 0 && prev[prev.length - 1].callId === callId) {
                return prev.slice(0, -1);
            }
            // If clicking from main chat (stack empty), start fresh
            if (prev.length === 0) {
                return [newEntry];
            }
            // Otherwise push onto stack (nested agent call from agent panel)
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

    function refreshScrollButton(container) {
        const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

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
    }

    useLayoutEffect(() => {
        const slot = inputSlotRef.current;
        if (!slot) return;

        const nextRect = slot.getBoundingClientRect();
        if (slot.parentElement) {
            slot.parentElement.style.setProperty('--input-slot-height', `${nextRect.height}px`);
        }

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

    useLayoutEffect(() => {
        if (isChatMode && messages.length > 0) {
            latestChatMessagesRef.current = messages;
        }
    }, [isChatMode, messages]);

    useLayoutEffect(() => {
        const previousConversationKey = previousConversationKeyRef.current;
        if (previousConversationKey !== conversationKey) {
            const hasConcreteConversation = conversationKey !== null && conversationKey !== undefined;
            const isTransitioningDraftToSaved = (
                (previousConversationKey === null || previousConversationKey === undefined)
                && hasConcreteConversation
                && previousChatModeRef.current
                && userMessageCount > 0
            );

            const previousKey = normalizeConversationKey(previousConversationKey);
            if (previousKey && scrollRef.current) {
                // Use lastKnownScrollTopRef instead of scrollRef.current.scrollTop.
                // When React clears the div content (switching to uncached conversation),
                // the browser clamps scrollTop to 0 — the cached ref keeps the real value.
                console.log('[SCROLL SAVE on switch]', { previousKey, scrollTop: lastKnownScrollTopRef.current });
                saveConversationScrollPosition(previousKey, lastKnownScrollTopRef.current);
            }
            lastKnownScrollTopRef.current = 0;

            previousConversationKeyRef.current = conversationKey;
            isJumpingToBottomRef.current = false;
            if (spacerRef.current) {
                spacerRef.current.style.height = '0px';
            }
            pendingScrollRestoreConversationRef.current = (hasConcreteConversation && !isTransitioningDraftToSaved)
                ? normalizeConversationKey(conversationKey)
                : null;
            pendingConversationEnterAnimationRef.current = (hasConcreteConversation && !isTransitioningDraftToSaved)
                ? conversationKey
                : null;
            shouldAutoFollowRef.current = false;
            if (!isTransitioningDraftToSaved) {
                applyAgentPanelStack(
                    hasConcreteConversation
                        ? (agentPanelStacksRef.current[normalizeConversationKey(conversationKey)] ?? [])
                        : [],
                    conversationKey,
                );
                setActiveToolPanelSelection(null);
            }

            // Suprima animatia spacerului (28vh→0) cand nu suntem pe new chat.
            // Pe new chat (null), lasam animatia sa se declanseze normal la primul mesaj.
            setNoSpacerAnim(conversationKey !== null && conversationKey !== undefined);

            // Ascunde div-ul de mesaje cand incarcam o conversatie existenta fara mesaje cached.
            // Se dezactiveaza cand animatia de enter porneste (dupa ce mesajele sosesc).
            if (hasConcreteConversation && !isTransitioningDraftToSaved) {
                setIsConversationHidden(messages.length === 0);
            }
        }
    }, [conversationKey, userMessageCount, saveConversationScrollPosition, messages.length, applyAgentPanelStack]);

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
        if (!pendingConversationKey) return;
        if (!isChatMode || messages.length === 0) return;

        const activeConversationKey = normalizeConversationKey(conversationKey);
        if (!activeConversationKey || activeConversationKey !== pendingConversationKey) return;

        const container = scrollRef.current;
        if (!container) return;

        const paddingBottom = parseFloat(window.getComputedStyle(container).paddingBottom) || 0;
        const requiredSpacer = Math.max(0, container.clientHeight - USER_TOP_OFFSET - paddingBottom);
        if (spacerRef.current) {
            spacerRef.current.style.height = `${requiredSpacer}px`;
        }

        const refreshedMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const isInitialRestore = isInitialScrollRestoreRef.current;
        isInitialScrollRestoreRef.current = false;

        const savedScrollTop = scrollPositionsRef.current[pendingConversationKey];
        const targetScrollTop = Number.isFinite(savedScrollTop)
            ? Math.min(Math.max(0, savedScrollTop), refreshedMaxScrollTop)
            : refreshedMaxScrollTop;
        shouldAutoFollowRef.current = targetScrollTop >= refreshedMaxScrollTop - AUTO_SCROLL_SNAP_DISTANCE;

        console.log('[SCROLL RESTORE]', {
            key: pendingConversationKey,
            isInitialRestore,
            savedScrollTop,
            refreshedMaxScrollTop,
            targetScrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
            allSavedPositions: { ...scrollPositionsRef.current },
        });

        isProgrammaticScrollRef.current = true;
        container.scrollTop = targetScrollTop;
        lastKnownScrollTopRef.current = targetScrollTop;
        refreshScrollButton(container);
        pendingScrollRestoreConversationRef.current = null;
        requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = false;
        });
    }, [conversationKey, isChatMode, messages.length, saveConversationScrollPosition]);

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
        inputFlipAnimationRef.current?.cancel();
    }, []);

    // Save scroll position on component unmount only.
    // Conversation switches are handled by the conv-key-change useLayoutEffect above.
    // We must NOT use [conversationKey] deps here because the cleanup fires AFTER
    // the layoutEffect has already reset lastKnownScrollTopRef, causing it to
    // overwrite the correctly saved position with 0.
    // Use lastKnownScrollTopRef instead of container.scrollTop — during page refresh
    // the DOM is torn down and the browser clamps scrollTop to 0.
    useEffect(() => () => {
        const key = normalizeConversationKey(previousConversationKeyRef.current);
        if (key) saveConversationScrollPosition(key, lastKnownScrollTopRef.current);
    }, [saveConversationScrollPosition]);

    // Sync baseline only when switching conversations.
    // If we sync on every count change, we suppress the Enter anchor trigger.
    useEffect(() => {
        if (baselineConversationKeyRef.current === conversationKey) {
            return;
        }

        baselineConversationKeyRef.current = conversationKey;
        previousUserMessageCountRef.current = userMessageCount;
    }, [conversationKey, userMessageCount]);

    // Scroll automat la Enter: ancoram ultimul mesaj user la top.
    // Trigger-ul este cresterea numarului de mesaje user.
    // Daca AI-ul inca nu a inceput sa scrie, asteptam pana cand isTyping devine true.
    useEffect(() => {
        // Conversatia s-a schimbat — sincronizam baseline fara animatie.
        if (enterAnchorConversationKeyRef.current !== conversationKey) {
            enterAnchorConversationKeyRef.current = conversationKey;
            previousUserMessageCountRef.current = userMessageCount;
            shouldAutoFollowRef.current = false;
            return;
        }

        if (!isChatMode || userMessageCount === 0) {
            previousUserMessageCountRef.current = userMessageCount;
            shouldAutoFollowRef.current = false;
            return;
        }

        const hasNewUserMessage = userMessageCount > previousUserMessageCountRef.current;

        // Daca avem mesaj nou dar AI inca nu raspunde, asteptam urmatorul render/update.
        if (hasNewUserMessage && !isTyping) {
            return;
        }

        // Daca numarul de mesaje a scazut (ex: stergere), actualizam fara sa ancoram.
        if (userMessageCount < previousUserMessageCountRef.current) {
            previousUserMessageCountRef.current = userMessageCount;
            return;
        }

        // Daca nu e un mesaj nou care sa necesite ancora, iesim.
        if (!hasNewUserMessage) {
            return;
        }

        // Inregistram faptul ca am procesat acest mesaj.
        previousUserMessageCountRef.current = userMessageCount;

        shouldAutoFollowRef.current = false;
        isProgrammaticScrollRef.current = true;
        isAnimatingEnterRef.current = true;

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = scrollRef.current;
                const userEl = lastUserMsgRef.current;
                const aiEl = lastAiMsgRef.current;
                const spacer = spacerRef.current;

                if (!container || !userEl || !spacer) {
                    isProgrammaticScrollRef.current = false;
                    isAnimatingEnterRef.current = false;
                    return;
                }

                const { top: userTop, bottom: userBottom } = getElementOffsets(container, userEl);
                const aiBottom = aiEl ? getElementOffsets(container, aiEl).bottom : userBottom;
                const contentBottom = Math.max(userBottom, aiBottom);
                const containerHeight = container.clientHeight;
                const contentBlockHeight = Math.max(0, contentBottom - userTop);
                const paddingBottom = parseFloat(window.getComputedStyle(container).paddingBottom) || 0;

                // Setam spacer-ul initial pentru a permite scroll-ul pana la pozitia dorita.
                const requiredSpacer = Math.max(0, containerHeight - USER_TOP_OFFSET - contentBlockHeight - paddingBottom);
                spacer.style.height = `${requiredSpacer}px`;

                container.scrollTo({
                    top: Math.max(0, userTop - USER_SCROLL_FOCUS_OFFSET),
                    behavior: 'smooth',
                });

                // Eliberam starea dupa terminarea animatiei.
                setTimeout(() => {
                    isProgrammaticScrollRef.current = false;
                    isAnimatingEnterRef.current = false;
                    lastKnownScrollTopRef.current = container.scrollTop;
                    refreshScrollButton(container);
                    saveActiveConversationScrollPosition(container);
                }, 500);
            });
        });
    }, [conversationKey, messages, userMessageCount, isChatMode, isTyping, saveActiveConversationScrollPosition]);

    function handleScrollToBottom() {
        const container = scrollRef.current;
        if (!container) return;

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

            const distanceToBottom = activeContainer.scrollHeight - activeContainer.scrollTop - activeContainer.clientHeight;
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

    // Spacer dinamic + follow in timpul stream-ului.
    useEffect(() => {
        if (!isChatMode) return;
        const container = scrollRef.current;
        const userEl = lastUserMsgRef.current;
        const aiEl = lastAiMsgRef.current;
        const spacer = spacerRef.current;

        if (!container || !userEl || !spacer) return;

        const handleLayoutAndScroll = () => {
            const { top: userTop, bottom: userBottom } = getElementOffsets(container, userEl);
            const aiBottom = aiEl ? getElementOffsets(container, aiEl).bottom : userBottom;
            const contentBottom = Math.max(userBottom, aiBottom);
            const containerHeight = container.clientHeight;
            const contentBlockHeight = Math.max(0, contentBottom - userTop);
            const paddingBottom = parseFloat(window.getComputedStyle(container).paddingBottom) || 0;

            // Pastram runway-ul daca:
            // 1. AI-ul scrie (isTyping).
            // 2. Suntem in curs de ancorare (isAnimatingEnter).
            // 3. Suntem in modul "Anchor at Top" (nu facem auto-follow la bottom) 
            //    si ne uitam la ultimul mesaj (mesajul e scurt, avem nevoie de spacer).
            const isAnchoredMode = !shouldAutoFollowRef.current;
            const isViewingLastTurn = container.scrollTop > 0 || contentBlockHeight < containerHeight;

            const shouldUseRunway = isTyping || isAnimatingEnterRef.current || shouldAutoFollowRef.current || (isAnchoredMode && isViewingLastTurn);

            const requiredSpacer = shouldUseRunway
                ? Math.max(0, containerHeight - USER_TOP_OFFSET - contentBlockHeight - paddingBottom)
                : 0;

            // Evitam flickers: daca noul spacer e mult mai mic dar nu suntem la bottom, 
            // incercam sa nu il eliminam brutal daca suntem inca ancorati.
            spacer.style.height = `${requiredSpacer}px`;

            if (shouldAutoFollowRef.current && !isAnimatingEnterRef.current) {
                isProgrammaticScrollRef.current = true;
                container.scrollTop = container.scrollHeight;
                lastKnownScrollTopRef.current = container.scrollTop;

                requestAnimationFrame(() => {
                    isProgrammaticScrollRef.current = false;
                    refreshScrollButton(container);
                });
                return;
            }

            refreshScrollButton(container);
        };

        const observer = new ResizeObserver(handleLayoutAndScroll);
        observer.observe(userEl);
        if (aiEl) observer.observe(aiEl);

        handleLayoutAndScroll();
        return () => observer.disconnect();
    }, [conversationKey, isChatMode, isTyping, messages.length, userMessageCount]);

    // Cand user da scroll manual, actualizam follow-ul.
    useEffect(() => {
        const container = scrollRef.current;
        if (!isChatMode || !container) return;

        const handleManualScroll = () => {
            if (isProgrammaticScrollRef.current) return;
            // Don't save during conversation transition — the spacer reset triggers
            // a scroll event with scrollTop=0 that would overwrite the saved position.
            if (pendingScrollRestoreConversationRef.current) return;

            lastKnownScrollTopRef.current = container.scrollTop;
            const distanceToBottom = refreshScrollButton(container);
            // Daca userul a urcat manual mai mult de 24px de bottom, oprim auto-follow-ul.
            if (distanceToBottom > AUTO_SCROLL_SNAP_DISTANCE) {
                shouldAutoFollowRef.current = false;
            }
            saveActiveConversationScrollPosition(container);
        };

        container.addEventListener('scroll', handleManualScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleManualScroll);
    }, [isChatMode, conversationKey, saveActiveConversationScrollPosition]);

    // Auto-scroll for agent side panel.
    useEffect(() => {
        const container = agentPanelBodyRef.current;
        if (!container) return;

        // Reset auto-follow when the agent panel selection changes.
        agentPanelAutoFollowRef.current = true;
        container.scrollTop = 0;

        const handleScroll = () => {
            const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            agentPanelAutoFollowRef.current = distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE;
        };

        const observer = new ResizeObserver(() => {
            if (agentPanelAutoFollowRef.current) {
                container.scrollTop = container.scrollHeight;
            }
        });

        // Observe the first child (the Message component wrapper) for size changes.
        if (container.firstElementChild) {
            observer.observe(container.firstElementChild);
        } else {
            observer.observe(container);
        }

        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            observer.disconnect();
            container.removeEventListener('scroll', handleScroll);
        };
    }, [activeAgentCallSelection]);

    const lastUserMsgId = [...messages].reverse().find((m) => m.role === 'user')?.id;
    const lastAiMsgId = [...messages].reverse().find((m) => m.role === 'ai')?.id;
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
                    isThinking: streamData.isThinking === true,
                };
            }
        }

        // Fall back to completed message data.
        return buildAgentPanelMessage(activeAgentCallDetails, messages);
    }, [activeAgentCallDetails, agentStreaming, activeAgentCallSelection, messages]);
    const activeAgentPanelRenderKey = useMemo(() => {
        const callId = String(activeAgentCallSelection?.callId ?? '').trim();
        const instanceId = String(activeAgentCallSelection?.instanceId ?? '').trim();
        return [callId, instanceId, agentPanelStack.length].filter(Boolean).join(':') || 'agent-panel';
    }, [activeAgentCallSelection, agentPanelStack.length]);
    const isAgentPanelOpen = isChatMode && !!activeAgentPanelMessage && !!activeAgentCallSelection;
    const isToolPanelOpen = isChatMode && !!activeToolPanelSelection;

    return (
        <main
            className={`main-content${isChatMode ? ' chat-active' : ''}${noSpacerAnim ? ' no-spacer-anim' : ''}${isAgentPanelOpen ? ' agent-panel-open' : ''}${isToolPanelOpen ? ' tool-panel-open' : ''}`}
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
                    <div className={`chat-messages${isConversationEnterVisible ? ' chat-messages-enter' : ''}${isConversationHidden ? ' chat-messages-hidden' : ''}`} id="chatMessages" ref={scrollRef}>
                        {messages.map((msg) => {
                            return (
                                <div
                                    key={msg.id}
                                    className="chat-message-row"
                                >
                                    <Message
                                        role={msg.role}
                                        text={msg.text}
                                        thought={msg.thought}
                                        parts={msg.parts}
                                        steps={msg.steps}
                                        isThinking={
                                            isTyping
                                            && msg.id === lastAiMsgId
                                            && msg.role === 'ai'
                                            && String(msg.text ?? '').trim().length === 0
                                        }
                                        onAgentCallToggle={msg.role === 'ai' ? handleAgentCallToggle : undefined}
                                        onToolPanelToggle={msg.role === 'ai' ? handleToolPanelToggle : undefined}
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
                                </div>
                            );
                        })}
                        {shouldRenderTypingIndicator && <TypingIndicator />}
                        <div ref={spacerRef} style={{ flexShrink: 0, width: '100%' }} />
                    </div>
                )}

                {!isChatMode && exitSnapshotMessages.length > 0 && (
                    <div
                        className="chat-messages chat-messages-exit"
                        ref={exitSnapshotRef}
                        aria-hidden="true"
                    >
                        {exitSnapshotMessages.map((msg) => (
                            <Message
                                key={`exit-${msg.id}`}
                                role={msg.role}
                                text={msg.text}
                                thought={msg.thought}
                                parts={msg.parts}
                                steps={msg.steps}
                            />
                        ))}
                    </div>
                )}

                {isChatMode && showScrollToBottom && (
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
                    {children}
                </div>
            </div>

            {isToolPanelOpen && activeToolPanelSelection && (
                <ToolDetailPanel
                    selection={activeToolPanelSelection}
                    onClose={() => setActiveToolPanelSelection(null)}
                />
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
                        <div className="agent-side-body" ref={agentPanelBodyRef}>
                            <Message
                                key={activeAgentPanelRenderKey}
                                role="ai"
                                text={activeAgentPanelMessage.text}
                                thought={activeAgentPanelMessage.thought}
                                parts={activeAgentPanelMessage.parts}
                                steps={activeAgentPanelMessage.steps}
                                isThinking={activeAgentPanelMessage.isThinking}
                                onAgentCallToggle={handleAgentCallToggle}
                                showAllLiveToolCalls
                            />
                        </div>
                    </aside>
                );
            })()}
        </main>
    );
}
