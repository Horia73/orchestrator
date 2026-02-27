import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './ChatArea.css';
import { Message } from './Message.jsx';
import { TypingIndicator } from './TypingIndicator.jsx';
import { IconArrowDown, IconClose } from '../shared/icons.jsx';
import {
    buildAgentPanelMessage,
    findAgentToolCallInMessages,
    findLatestAgentToolCallInMessages,
} from './agentCallUtils.js';

const USER_TOP_OFFSET = 24;
const AI_BOTTOM_GAP = 36;
const AUTO_SCROLL_SNAP_DISTANCE = 24;
const INPUT_FLIP_DURATION_MS = 260;
const EXIT_FADE_DURATION_MS = INPUT_FLIP_DURATION_MS;
const ENTER_FADE_DURATION_MS = 340;
const SCROLL_POSITIONS_STORAGE_KEY = 'orchestrator.chat.scroll_positions.v1';

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

export function ChatArea({ greeting, messages, isTyping, isChatMode, conversationKey, agentStreaming, children }) {
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
    const [activeAgentCallSelection, setActiveAgentCallSelection] = useState(null);
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

        setActiveAgentCallSelection((previous) => {
            if (previous?.callId === callId) {
                return null;
            }

            return {
                callId,
                agentId: String(payload?.agentId ?? '').trim(),
                agentName: String(payload?.agentName ?? '').trim() || 'Agent',
                toolName: String(payload?.toolName ?? '').trim(),
                sourceContext: payload?.sourceContext ?? null,
                toolPart: payload?.toolPart ?? null,
            };
        });
    }, []);

    function refreshScrollButton(container) {
        const spacerHeight = spacerRef.current ? spacerRef.current.offsetHeight : 0;
        const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight - spacerHeight;

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
                setActiveAgentCallSelection(null);
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
    }, [conversationKey, userMessageCount, saveConversationScrollPosition, messages.length]);

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
        if (!isChatMode || isTyping || messages.length === 0) return;

        const activeConversationKey = normalizeConversationKey(conversationKey);
        if (!activeConversationKey || activeConversationKey !== pendingConversationKey) return;

        const container = scrollRef.current;
        if (!container) return;

        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const savedScrollTop = scrollPositionsRef.current[pendingConversationKey];
        const targetScrollTop = Number.isFinite(savedScrollTop)
            ? Math.min(Math.max(0, savedScrollTop), maxScrollTop)
            : maxScrollTop;

        if (spacerRef.current) {
            spacerRef.current.style.height = '0px';
        }

        isProgrammaticScrollRef.current = true;
        container.scrollTop = targetScrollTop;
        lastKnownScrollTopRef.current = targetScrollTop;
        // Persist so that default-to-bottom (maxScrollTop) is also remembered.
        saveConversationScrollPosition(conversationKey, targetScrollTop);
        refreshScrollButton(container);
        pendingScrollRestoreConversationRef.current = null;
        requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = false;
        });
    }, [conversationKey, isChatMode, isTyping, messages.length]);

    useLayoutEffect(() => {
        if (previousChatModeRef.current && !isChatMode) {
            const snapshot = latestChatMessagesRef.current;
            if (snapshot.length > 0) {
                if (exitFadeTimeoutRef.current) clearTimeout(exitFadeTimeoutRef.current);

                exitSnapshotScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
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
    }, [isChatMode, exitSnapshotMessages.length]);

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
    useEffect(() => () => {
        const container = scrollRef.current;
        if (!container) return;
        const key = normalizeConversationKey(previousConversationKeyRef.current);
        if (key) saveConversationScrollPosition(key, container.scrollTop);
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

                // Setam spacer-ul initial pentru a permite scroll-ul pana la pozitia dorita.
                const requiredSpacer = Math.max(0, containerHeight - USER_TOP_OFFSET - contentBlockHeight - AI_BOTTOM_GAP);
                spacer.style.height = `${requiredSpacer}px`;

                container.scrollTo({
                    top: Math.max(0, userTop - USER_TOP_OFFSET),
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

            // Pastram runway-ul daca:
            // 1. AI-ul scrie (isTyping).
            // 2. Suntem in curs de ancorare (isAnimatingEnter).
            // 3. Suntem in modul "Anchor at Top" (nu facem auto-follow la bottom) 
            //    si ne uitam la ultimul mesaj (mesajul e scurt, avem nevoie de spacer).
            const isAnchoredMode = !shouldAutoFollowRef.current;
            const isViewingLastTurn = container.scrollTop > 0 || contentBlockHeight < containerHeight;

            const shouldUseRunway = isTyping || isAnimatingEnterRef.current || shouldAutoFollowRef.current || (isAnchoredMode && isViewingLastTurn);

            const requiredSpacer = shouldUseRunway
                ? Math.max(0, containerHeight - USER_TOP_OFFSET - contentBlockHeight - AI_BOTTOM_GAP)
                : 0;

            // Evitam flickers: daca noul spacer e mult mai mic dar nu suntem la bottom, 
            // incercam sa nu il eliminam brutal daca suntem inca ancorati.
            spacer.style.height = `${requiredSpacer}px`;

            if (isTyping && shouldAutoFollowRef.current && !isAnimatingEnterRef.current) {
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

        const resolvedFromToolName = findLatestAgentToolCallInMessages(
            messages,
            activeAgentCallSelection?.toolName,
        );
        if (resolvedFromToolName) {
            return resolvedFromToolName;
        }

        if (!activeAgentCallSelection) {
            return null;
        }

        return {
            callId,
            agentId: activeAgentCallSelection.agentId,
            agentName: activeAgentCallSelection.agentName,
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
        const toolName = String(activeAgentCallSelection?.toolName ?? '').trim();

        // Use live agent streaming data keyed by toolName.
        if (toolName && agentStreaming) {
            const streamData = agentStreaming[toolName];
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
        return buildAgentPanelMessage(activeAgentCallDetails);
    }, [activeAgentCallDetails, agentStreaming, activeAgentCallSelection]);
    const isAgentPanelOpen = isChatMode && !!activeAgentPanelMessage && !!activeAgentCallSelection;

    return (
        <main
            className={`main-content${isChatMode ? ' chat-active' : ''}${noSpacerAnim ? ' no-spacer-anim' : ''}${isAgentPanelOpen ? ' agent-panel-open' : ''}`}
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
                                        activeAgentCallId={activeAgentCallSelection?.callId ?? ''}
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

            {isAgentPanelOpen && activeAgentPanelMessage && (() => {
                const callArgs = activeAgentCallDetails?.toolPart?.functionCall?.args;
                const callSummary = callArgs
                    ? String(callArgs.task ?? callArgs.prompt ?? '').trim()
                    : '';
                return (
                    <aside className="agent-side-panel" aria-label="Agent activity panel">
                        <header className="agent-side-header">
                            <div className="agent-side-header-text">
                                <h2 className="agent-side-title">{activeAgentCallDetails?.agentName || 'Agent'}</h2>
                                <p className="agent-side-subtitle">
                                    {String(activeAgentCallDetails?.toolName ?? '').trim() || 'Agent call'}
                                </p>
                            </div>
                            <button
                                className="agent-side-close"
                                onClick={() => setActiveAgentCallSelection(null)}
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
                        <div className="agent-side-body">
                            <Message
                                role="ai"
                                text={activeAgentPanelMessage.text}
                                thought={activeAgentPanelMessage.thought}
                                parts={activeAgentPanelMessage.parts}
                                steps={activeAgentPanelMessage.steps}
                                isThinking={activeAgentPanelMessage.isThinking}
                            />
                        </div>
                    </aside>
                );
            })()}
        </main>
    );
}
