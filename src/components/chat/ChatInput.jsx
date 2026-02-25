import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import './ChatInput.css';
import { IconPlus, IconMic, IconArrowUp } from '../shared/icons.jsx';

/**
 * Chat input box.
 * - Auto-resizes the textarea.
 * - Enter = send, Shift+Enter = newline.
 * - Mic icon → orange Send button (animated) when textarea has content.
 */
export const ChatInput = forwardRef(function ChatInput({ onSend, isChatMode, isSending }, ref) {
    const textareaRef = useRef(null);
    const [hasContent, setHasContent] = useState(false);
    const wasSendingRef = useRef(false);

    const focusTextarea = useCallback(() => {
        const el = textareaRef.current;
        if (!el || el.disabled) return;

        el.focus();
        const cursor = el.value.length;
        el.setSelectionRange(cursor, cursor);
    }, []);

    useImperativeHandle(ref, () => ({
        focus: focusTextarea,
    }), [focusTextarea]);

    useEffect(() => {
        if (!wasSendingRef.current && isSending) {
            wasSendingRef.current = true;
            return;
        }

        if (wasSendingRef.current && !isSending) {
            wasSendingRef.current = false;
            const timer = setTimeout(focusTextarea, 0);
            return () => clearTimeout(timer);
        }
    }, [focusTextarea, isSending]);

    function handleKeyDown(e) {
        if (isSending) return;

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    }

    function handleInput() {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 180) + 'px';
        setHasContent(el.value.trim().length > 0);
    }

    function submit() {
        if (isSending) return;

        const el = textareaRef.current;
        if (!el) return;
        const text = el.value.trim();
        if (!text) return;
        onSend(text);
        el.value = '';
        el.style.height = 'auto';
        setHasContent(false);
    }

    return (
        <div className={`chat-input-container${isChatMode ? ' pinned' : ''}`}>
            <div className="chat-input-box">
                <div className="input-area">
                    <textarea
                        ref={textareaRef}
                        id="chatInput"
                        placeholder={isSending ? 'Gemini is thinking…' : isChatMode ? 'Reply…' : 'How can I help you today?'}
                        rows={1}
                        autoFocus={!isSending}
                        disabled={isSending}
                        onInput={handleInput}
                        onKeyDown={handleKeyDown}
                    />
                </div>
                <div className="input-footer">
                    <button className="attach-btn" title="Attach file">
                        <IconPlus />
                    </button>
                    <div className="input-right">
                        {hasContent ? (
                            <button
                                className="send-btn"
                                title="Send message"
                                onClick={submit}
                                disabled={isSending}
                            >
                                <IconArrowUp />
                            </button>
                        ) : (
                            <button className="voice-btn" title="Voice input" disabled={isSending}>
                                <IconMic />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});
