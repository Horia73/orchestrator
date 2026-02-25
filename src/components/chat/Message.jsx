import { forwardRef } from 'react';
import { MarkdownContent } from './MarkdownContent.jsx';
import { ThoughtBlock } from './ThoughtBlock.jsx';

/**
 * Individual message bubble.
 * Accepts a forwarded ref so ChatArea can scroll specific messages into view.
 */
export const Message = forwardRef(function Message({
    role,
    text,
    thought,
    isThinking = false,
}, ref) {
    if (role === 'user') {
        return (
            <div className="message-user" ref={ref}>
                <div className="message-user-bubble">
                    <MarkdownContent text={text} variant="user" />
                </div>
            </div>
        );
    }

    return (
        <div className="message-ai" ref={ref}>
            <div className="message-ai-content">
                {(isThinking || thought !== undefined) && (
                    <ThoughtBlock thought={thought} isThinking={isThinking} />
                )}
                {String(text ?? '').trim().length > 0 && (
                    <MarkdownContent text={text} variant="ai" />
                )}
            </div>
        </div>
    );
});
