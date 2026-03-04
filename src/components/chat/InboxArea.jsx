import { ChatArea } from './ChatArea.jsx';
import './InboxArea.css';

function IconInbox() {
    return (
        <svg fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 12.839a2.25 2.25 0 0 0-.1.661Z" />
        </svg>
    );
}

export function InboxArea({
    messages,
    conversationKey,
    clientId,
    agentStreaming,
    commandChunks,
    uiSettings,
    isTyping,
    onReplyFromMessage,
}) {
    const displayMessages = Array.isArray(messages) ? messages : [];

    const emptyStateFallback = (
        <div className="inbox-empty-screen">
            <div className="inbox-empty-inner">
                <div className="inbox-empty-icon-wrap">
                    <IconInbox />
                </div>
                <h2 className="inbox-empty-title">Your inbox is empty</h2>
                <p className="inbox-empty-text">
                    When an AI runs in the background or sends a scheduled reminder, it will show up here. Use Reply on any incoming message to continue in a new chat.
                </p>
            </div>
        </div>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, position: 'relative' }}>
            <ChatArea
                greeting=""
                messages={displayMessages}
                conversationKey={conversationKey}
                clientId={clientId}
                isTyping={isTyping}
                isChatMode={true}
                activeChatKind="inbox"
                onReplyFromMessage={onReplyFromMessage}
                agentStreaming={agentStreaming}
                commandChunks={commandChunks}
                uiSettings={uiSettings}
                disableScrollAnchoring={true}
                emptyStateFallback={emptyStateFallback}
            />
        </div>
    );
}
