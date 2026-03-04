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
    onClear,
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

    const hasMessages = displayMessages.length > 0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, position: 'relative' }}>
            {hasMessages && (
                <div style={{ position: 'absolute', top: 12, right: 32, zIndex: 10 }}>
                    <button
                        type="button"
                        onClick={onClear}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-tertiary)',
                            fontSize: '13px',
                            fontWeight: '500',
                            cursor: 'pointer',
                            padding: '6px 10px',
                            borderRadius: '8px',
                            transition: 'background 0.2s, color 0.2s'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.04)';
                            e.currentTarget.style.color = 'var(--text-primary)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.color = 'var(--text-tertiary)';
                        }}
                        title="Clear inbox"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        Clear
                    </button>
                </div>
            )}
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
