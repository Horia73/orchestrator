import { useEffect, useRef, useCallback } from 'react';
import './ChatArea.css';
import { Message } from './Message.jsx';
import { TypingIndicator } from './TypingIndicator.jsx';

const USER_TOP_OFFSET = 24;
const AI_BOTTOM_GAP = 36;
const SCROLL_EPSILON = 1;
const AUTO_SCROLL_SNAP_DISTANCE = 24;

function getElementOffsets(container, el) {
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const top = elRect.top - containerRect.top + container.scrollTop;
    const bottom = elRect.bottom - containerRect.top + container.scrollTop;
    return { top, bottom };
}

export function ChatArea({ greeting, messages, isTyping, isChatMode, children }) {
    const scrollRef = useRef(null);
    const lastUserMsgRef = useRef(null);
    const lastAiMsgRef = useRef(null);
    const handledMessageKeyRef = useRef(null);
    const shouldAutoFollowRef = useRef(true);

    const getMaxAllowedScrollTop = useCallback(() => {
        const container = scrollRef.current;
        const userEl = lastUserMsgRef.current;
        if (!container) return 0;

        const nativeMax = Math.max(0, container.scrollHeight - container.clientHeight);
        if (!userEl) return nativeMax;

        const { top: userTop } = getElementOffsets(container, userEl);
        const userAnchorTop = Math.max(0, userTop - USER_TOP_OFFSET);

        const aiEl = lastAiMsgRef.current;
        if (!aiEl) {
            return Math.min(nativeMax, userAnchorTop);
        }

        const { bottom: aiBottom } = getElementOffsets(container, aiEl);
        const aiRequiredTop = Math.max(0, aiBottom - (container.clientHeight - AI_BOTTOM_GAP));

        return Math.min(nativeMax, Math.max(userAnchorTop, aiRequiredTop));
    }, []);

    const scrollToClampedTop = useCallback((requestedTop, behavior = 'smooth') => {
        const container = scrollRef.current;
        if (!container) return;

        const maxAllowed = getMaxAllowedScrollTop();
        const clampedTop = Math.min(Math.max(0, requestedTop), maxAllowed);
        container.scrollTo({ top: clampedTop, behavior });
    }, [getMaxAllowedScrollTop]);

    const enforceScrollBounds = useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;

        const maxAllowed = getMaxAllowedScrollTop();
        if (container.scrollTop <= maxAllowed + SCROLL_EPSILON) return;

        container.scrollTop = maxAllowed;
    }, [getMaxAllowedScrollTop]);

    const updateAutoFollowState = useCallback(() => {
        const container = scrollRef.current;
        if (!container) return;

        const maxAllowed = getMaxAllowedScrollTop();
        const distanceToBottom = maxAllowed - container.scrollTop;
        shouldAutoFollowRef.current = distanceToBottom <= AUTO_SCROLL_SNAP_DISTANCE;
    }, [getMaxAllowedScrollTop]);

    const scrollToUserMessage = useCallback(() => {
        const container = scrollRef.current;
        const el = lastUserMsgRef.current;
        if (!container || !el) return;

        const { top: elTop } = getElementOffsets(container, el);
        scrollToClampedTop(elTop - USER_TOP_OFFSET);
    }, [scrollToClampedTop]);

    const scrollToAiResponse = useCallback((behavior = 'smooth') => {
        const container = scrollRef.current;
        const el = lastAiMsgRef.current;
        if (!container || !el) return;

        // Scroll only when the AI answer goes too close to the input area.
        const { bottom: elBottom } = getElementOffsets(container, el);
        const visibleBottom = container.scrollTop + container.clientHeight - AI_BOTTOM_GAP;
        const overflow = elBottom - visibleBottom;
        if (overflow <= 0) return;

        scrollToClampedTop(container.scrollTop + overflow, behavior);
    }, [scrollToClampedTop]);

    // Scroll only once per newly appended message.
    useEffect(() => {
        if (!isChatMode || messages.length === 0) return;

        const lastMsg = messages[messages.length - 1];
        const key = `${lastMsg.role}:${lastMsg.id}`;
        if (handledMessageKeyRef.current === key) return;
        handledMessageKeyRef.current = key;
        shouldAutoFollowRef.current = true;

        if (lastMsg.role === 'user') {
            const userCount = messages.filter(m => m.role === 'user').length;
            if (userCount <= 1) return; // First message — already at top

            const t = setTimeout(scrollToUserMessage, 80);
            return () => clearTimeout(t);
        }

        if (lastMsg.role === 'ai') {
            const t = setTimeout(scrollToAiResponse, 80);
            return () => clearTimeout(t);
        }
    }, [isChatMode, messages, scrollToUserMessage, scrollToAiResponse]);

    useEffect(() => {
        if (!isChatMode) {
            handledMessageKeyRef.current = null;
            shouldAutoFollowRef.current = true;
        }
    }, [isChatMode]);

    useEffect(() => {
        if (!isChatMode) return;

        const container = scrollRef.current;
        if (!container) return;

        const onScroll = () => {
            enforceScrollBounds();
            updateAutoFollowState();
        };

        container.addEventListener('scroll', onScroll, { passive: true });
        return () => container.removeEventListener('scroll', onScroll);
    }, [isChatMode, enforceScrollBounds, updateAutoFollowState]);

    useEffect(() => {
        if (!isChatMode || !isTyping || !shouldAutoFollowRef.current) return;

        const lastMsg = messages[messages.length - 1];
        if (!lastMsg || lastMsg.role !== 'ai') return;

        const t = setTimeout(() => {
            if (!shouldAutoFollowRef.current) return;
            scrollToAiResponse('auto');
        }, 0);

        return () => clearTimeout(t);
    }, [isChatMode, messages, isTyping, scrollToAiResponse]);

    useEffect(() => {
        if (!isChatMode) return;

        const t = setTimeout(() => {
            enforceScrollBounds();
            updateAutoFollowState();
        }, 0);
        return () => clearTimeout(t);
    }, [isChatMode, messages, isTyping, enforceScrollBounds, updateAutoFollowState]);

    const lastUserMsgId = [...messages].reverse().find(m => m.role === 'user')?.id;
    const lastAiMsgId = [...messages].reverse().find(m => m.role === 'ai')?.id;
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
                <div className="chat-messages" id="chatMessages" ref={scrollRef}>
                    {messages.map((msg) => (
                        <Message
                            key={msg.id}
                            role={msg.role}
                            text={msg.text}
                            thought={msg.thought}
                            isThinking={
                                isTyping
                                && msg.id === lastAiMsgId
                                && msg.role === 'ai'
                                && String(msg.text ?? '').trim().length === 0
                            }
                            ref={
                                msg.id === lastUserMsgId ? lastUserMsgRef :
                                    msg.id === lastAiMsgId ? lastAiMsgRef :
                                        null
                            }
                        />
                    ))}
                    {shouldRenderTypingIndicator && <TypingIndicator />}
                </div>
            )}

            {children}

        </main>
    );
}
