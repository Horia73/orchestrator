import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import './ChatInput.css';
import { IconPlus, IconMic, IconStop, IconArrowUp, IconClose } from '../shared/icons.jsx';

function createAttachmentId(file) {
    const base = `${String(file?.name ?? '').trim()}-${Number(file?.size ?? 0)}-${Number(file?.lastModified ?? 0)}`;
    return base || `file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatFileSize(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[unitIndex]}`;
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result ?? '');
            const separator = result.indexOf(',');
            if (separator < 0 || separator === result.length - 1) {
                reject(new Error(`Failed to encode ${file?.name || 'file'}.`));
                return;
            }

            resolve(result.slice(separator + 1));
        };
        reader.onerror = () => {
            reject(new Error(`Failed to read ${file?.name || 'file'}.`));
        };
        reader.readAsDataURL(file);
    });
}

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
    attachments = [],
    onAttachmentsChange,
    isChatMode,
    isSending,
}, ref) {
    const textareaRef = useRef(null);
    const fileInputRef = useRef(null);
    const wasSendingRef = useRef(false);
    const [attachmentError, setAttachmentError] = useState('');
    const value = String(draftValue ?? '');
    const hasContent = value.trim().length > 0;
    const attachmentList = Array.isArray(attachments) ? attachments : [];
    const hasAttachments = attachmentList.length > 0;
    const canSubmit = hasContent || hasAttachments;

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

    async function handleFileSelection(event) {
        const selectedFiles = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (selectedFiles.length === 0) {
            return;
        }

        setAttachmentError('');
        try {
            const converted = await Promise.all(
                selectedFiles.map(async (file, index) => ({
                    id: createAttachmentId(file),
                    name: String(file?.name ?? `attachment-${index + 1}`).trim() || `attachment-${index + 1}`,
                    mimeType: String(file?.type ?? '').trim() || 'application/octet-stream',
                    size: Number(file?.size ?? 0),
                    data: await fileToBase64(file),
                })),
            );

            const merged = new Map(
                attachmentList.map((attachment, index) => [
                    String(attachment?.id ?? `att-${index}`),
                    attachment,
                ]),
            );
            for (const attachment of converted) {
                merged.set(String(attachment.id), attachment);
            }

            onAttachmentsChange?.([...merged.values()]);
        } catch (error) {
            const message = error instanceof Error && error.message
                ? error.message
                : 'Unable to attach files.';
            setAttachmentError(message);
        }
    }

    function openAttachmentDialog() {
        if (isSending) return;
        fileInputRef.current?.click();
    }

    function removeAttachment(attachmentId) {
        const next = attachmentList.filter((attachment) => String(attachment?.id) !== String(attachmentId));
        onAttachmentsChange?.(next);
        setAttachmentError('');
    }

    function submit() {
        if (isSending) return;

        if (!canSubmit) return;

        onSend({
            text: value,
            attachments: attachmentList,
        });
        onDraftChange?.('');
        onAttachmentsChange?.([]);
        setAttachmentError('');
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
                <input
                    ref={fileInputRef}
                    className="attach-input"
                    type="file"
                    multiple
                    onChange={handleFileSelection}
                />
                {attachmentList.length > 0 && (
                    <div className="input-attachments">
                        {attachmentList.map((attachment, index) => {
                            const attachmentId = String(attachment?.id ?? `att-${index}`);
                            const attachmentName = String(attachment?.name ?? `attachment-${index + 1}`);
                            return (
                                <div className="input-attachment-chip" key={attachmentId}>
                                    <div className="input-attachment-chip-text" title={attachmentName}>
                                        <span className="input-attachment-name">{attachmentName}</span>
                                        <span className="input-attachment-size">{formatFileSize(attachment?.size)}</span>
                                    </div>
                                    <button
                                        type="button"
                                        className="input-attachment-remove"
                                        title={`Remove ${attachmentName}`}
                                        onClick={() => removeAttachment(attachmentId)}
                                    >
                                        <IconClose />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
                {attachmentError && (
                    <div className="input-attachments-error">
                        {attachmentError}
                    </div>
                )}
                <div className="input-footer">
                    <div className="input-left">
                        <button
                            type="button"
                            className={`attach-btn${hasAttachments ? ' has-attachments' : ''}`}
                            title="Attach file"
                            onClick={openAttachmentDialog}
                            disabled={isSending}
                        >
                            <IconPlus />
                        </button>
                    </div>
                    <div className="input-right">
                        {isSending ? (
                            <button
                                type="button"
                                className="voice-btn stop-btn"
                                title="Stop response"
                                onClick={() => onStop?.()}
                            >
                                <IconStop />
                            </button>
                        ) : canSubmit ? (
                            <button
                                type="button"
                                className="send-btn"
                                title="Send message"
                                onClick={submit}
                                disabled={isSending}
                            >
                                <IconArrowUp />
                            </button>
                        ) : (
                            <button type="button" className="voice-btn" title="Voice input" disabled={isSending}>
                                <IconMic />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});
