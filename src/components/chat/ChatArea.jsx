import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './ChatArea.css';
import { Message } from './Message.jsx';
import { TypingIndicator } from './TypingIndicator.jsx';
import { IconArrowDown } from '../shared/icons.jsx';

const USER_TOP_OFFSET = 24;
const AI_BOTTOM_GAP = 36;
const AUTO_SCROLL_SNAP_DISTANCE = 24;
const INPUT_FLIP_DURATION_MS = 260;
const EXIT_FADE_DURATION_MS = INPUT_FLIP_DURATION_MS;
const ENTER_FADE_DURATION_MS = 340;

function getElementOffsets(container, element) {
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const top = elementRect.top - containerRect.top + container.scrollTop;
    const bottom = elementRect.bottom - containerRect.top + container.scrollTop;
    return { top, bottom };
}

export function ChatArea({ greeting, messages, isTyping, isChatMode, conversationKey, children }) {
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
    const pendingBottomRestoreConversationRef = useRef(null);
    const pendingConversationEnterAnimationRef = useRef(null);
    const exitSnapshotScrollTopRef = useRef(0);
    const latestChatMessagesRef = useRef(messages);
    const enterFadeTimeoutRef = useRef(null);
    const exitFadeTimeoutRef = useRef(null);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const [exitSnapshotMessages, setExitSnapshotMessages] = useState([]);
    const [isConversationEnterVisible, setIsConversationEnterVisible] = useState(false);
    const userMessageCount = useMemo(
        () => messages.reduce(
            (count, message) => (message.role === 'user' ? count + 1 : count),
            0,
        ),
        [messages],
    );

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

            previousConversationKeyRef.current = conversationKey;
            isJumpingToBottomRef.current = false;
            if (spacerRef.current) {
                spacerRef.current.style.height = '0px';
            }
            pendingBottomRestoreConversationRef.current = (hasConcreteConversation && !isTransitioningDraftToSaved)
                ? conversationKey
                : null;
            pendingConversationEnterAnimationRef.current = (hasConcreteConversation && !isTransitioningDraftToSaved)
                ? conversationKey
                : null;
            shouldAutoFollowRef.current = hasConcreteConversation && !isTransitioningDraftToSaved;
        }

        const pendingConversationKey = pendingBottomRestoreConversationRef.current;
        if (pendingConversationKey === null || pendingConversationKey === undefined) return;
        if (!isChatMode || messages.length === 0 || isTyping) return;
        if (conversationKey !== pendingConversationKey) return;

        const container = scrollRef.current;
        if (!container) return;

        // Reset spacer before measuring or scrolling to avoid carryover from previous chat
        if (spacerRef.current) {
            spacerRef.current.style.height = '0px';
        }

        isProgrammaticScrollRef.current = true;
        container.scrollTop = container.scrollHeight;
        refreshScrollButton(container);
        pendingBottomRestoreConversationRef.current = null;
        if (pendingConversationEnterAnimationRef.current === conversationKey) {
            if (enterFadeTimeoutRef.current) clearTimeout(enterFadeTimeoutRef.current);
            setIsConversationEnterVisible(true);
            enterFadeTimeoutRef.current = setTimeout(() => {
                setIsConversationEnterVisible(false);
                enterFadeTimeoutRef.current = null;
            }, ENTER_FADE_DURATION_MS + 80);
            pendingConversationEnterAnimationRef.current = null;
        }

        requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = false;
        });
    }, [conversationKey, isChatMode, isTyping, messages.length, userMessageCount]);

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

    // Scroll automat doar la Enter: ancoram ultimul mesaj user aproape de top.
    // Trigger-ul este cresterea numarului de mesaje user (nu "ultimul mesaj e user"),
    // pentru a evita race-ul in care placeholder-ul AI apare imediat.
    useEffect(() => {
        if (!isChatMode) {
            previousUserMessageCountRef.current = 0;
            shouldAutoFollowRef.current = false;
            return;
        }

        if (userMessageCount === 0) {
            previousUserMessageCountRef.current = 0;
            shouldAutoFollowRef.current = false;
            return;
        }

        if (userMessageCount < previousUserMessageCountRef.current) {
            previousUserMessageCountRef.current = userMessageCount;
        }

        const hasNewUserMessage = userMessageCount > previousUserMessageCountRef.current;
        previousUserMessageCountRef.current = userMessageCount;
        if (!hasNewUserMessage) return;

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
                const requiredSpacer = containerHeight - USER_TOP_OFFSET - contentBlockHeight - AI_BOTTOM_GAP;
                spacer.style.height = `${Math.max(0, requiredSpacer)}px`;

                container.scrollTo({
                    top: Math.max(0, userTop - USER_TOP_OFFSET),
                    behavior: 'smooth',
                });

                setTimeout(() => {
                    isProgrammaticScrollRef.current = false;
                    isAnimatingEnterRef.current = false;
                    refreshScrollButton(container);
                }, 600);
            });
        });
    }, [messages, userMessageCount, isChatMode]);

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
                refreshScrollButton(activeContainer);
                return;
            }

            requestAnimationFrame(releaseProgrammaticMode);
        };

        requestAnimationFrame(releaseProgrammaticMode);
    }

    // Spacer dinamic + follow in timpul stream-ului doar daca user a mers explicit la bottom.
    useEffect(() => {
        if (!isChatMode) return;
        const container = scrollRef.current;
        const userEl = lastUserMsgRef.current;
        const aiEl = lastAiMsgRef.current;
        const spacer = spacerRef.current;
        const shouldUseScrollRunway = isTyping || userMessageCount > 0;

        if (!container || !userEl || !spacer) return;

        const handleLayoutAndScroll = () => {
            const { top: userTop, bottom: userBottom } = getElementOffsets(container, userEl);
            const aiBottom = aiEl ? getElementOffsets(container, aiEl).bottom : userBottom;
            const contentBottom = Math.max(userBottom, aiBottom);
            const containerHeight = container.clientHeight;
            const contentBlockHeight = Math.max(0, contentBottom - userTop);

            const requiredSpacer = shouldUseScrollRunway
                ? Math.max(0, containerHeight - USER_TOP_OFFSET - contentBlockHeight - AI_BOTTOM_GAP)
                : 0;
            spacer.style.height = `${requiredSpacer}px`;

            // Keep bottom-follow only while the assistant is actively streaming.
            // During user interactions (e.g. expanding tool details), avoid forcing
            // scroll-to-bottom, otherwise expanded blocks appear to grow upward.
            if (isTyping && shouldAutoFollowRef.current && !isAnimatingEnterRef.current) {
                isProgrammaticScrollRef.current = true;
                container.scrollTop = container.scrollHeight;

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

    // Cand user da scroll manual, actualizam follow-ul si vizibilitatea butonului.
    useEffect(() => {
        const container = scrollRef.current;
        if (!isChatMode || !container) return;

        const handleManualScroll = () => {
            if (isProgrammaticScrollRef.current) return;

            const distanceToBottom = refreshScrollButton(container);
            shouldAutoFollowRef.current = distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE;
        };

        handleManualScroll();
        container.addEventListener('scroll', handleManualScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleManualScroll);
    }, [isChatMode, conversationKey]);

    const lastUserMsgId = [...messages].reverse().find((m) => m.role === 'user')?.id;
    const lastAiMsgId = [...messages].reverse().find((m) => m.role === 'ai')?.id;
    const lastMessage = messages[messages.length - 1];
    const shouldRenderTypingIndicator = isTyping && (!lastMessage || lastMessage.role !== 'ai');

    return (
        <main className={`main-content${isChatMode ? ' chat-active' : ''}`} id="mainContent">
            <div className={`landing-spacer${isChatMode ? ' collapsed' : ''}`} />

            {!isChatMode && (
                <div className="greeting-section">
                    <h1 className="greeting-text">{greeting}</h1>
                </div>
            )}

            {isChatMode && (
                <div className={`chat-messages${isConversationEnterVisible ? ' chat-messages-enter' : ''}`} id="chatMessages" ref={scrollRef}>
                    {messages.map((msg, index) => {
                        const enterMotionIndex = Math.min(messages.length - index - 1, 6);
                        return (
                            <div
                                key={msg.id}
                                className="chat-message-row"
                                style={isConversationEnterVisible ? { '--enter-index': enterMotionIndex } : undefined}
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
        </main>
    );
}
