import { ThoughtBlock } from './ThoughtBlock.jsx';

export function TypingIndicator() {
    return (
        <div className="message-ai">
            <div className="typing-indicator">
                <ThoughtBlock thought="" isThinking defaultOpen />
            </div>
        </div>
    );
}
