import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
} from 'react';
import './ChatInput.css';
import { IconPlus, IconMic, IconStop, IconArrowUp } from '../shared/icons.jsx';

/**
 * Chat input box.
 * - Auto-resizes the textarea.
 * - Enter = send, Shift+Enter = newline.
 * - Mic icon → orange Send button (animated) when textarea has content.
 */
export const ChatInput = forwardRef(function ChatInput({
    onSend,
    onStop,
    draftValue = '',
    onDraftChange,
    isChatMode,
    isSending,
}, ref) {
    const textareaRef = useRef(null);
    const wasSendingRef = useRef(false);
    const value = String(draftValue ?? '');
    const hasContent = value.trim().length > 0;

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

    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;

        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }, [value, isChatMode]);

    function handleKeyDown(e) {
        if (isSending) return;

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    }

    function handleInput(e) {
        onDraftChange?.(e.target.value);
    }

    function submit() {
        if (isSending) return;

        const text = value.trim();
        if (!text) return;
        onSend(text);
        onDraftChange?.('');
        focusTextarea();
    }

    return (
        <div className={`chat-input-container${isChatMode ? ' pinned' : ''}`}>
            <div className="chat-input-box">
                <div className="input-area">
                    <textarea
                        ref={textareaRef}
                        id="chatInput"
                        value={value}
                        placeholder={isSending ? 'Gemini is thinking…' : isChatMode ? 'Reply…' : 'How can I help you today?'}
                        rows={1}
                        autoFocus={!isSending}
                        onChange={handleInput}
                        onKeyDown={handleKeyDown}
                    />
                </div>
                <div className="input-footer">
                    <button className="attach-btn" title="Attach file">
                        <IconPlus />
                    </button>
                    <div className="input-right">
                        {isSending ? (
                            <button
                                className="voice-btn"
                                title="Stop response"
                                onClick={() => onStop?.()}
                            >
                                <IconStop />
                            </button>
                        ) : hasContent ? (
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
