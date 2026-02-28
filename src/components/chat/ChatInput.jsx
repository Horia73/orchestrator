import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import './ChatInput.css';
import { IconPlus, IconMic, IconStop, IconArrowUp, IconClose, IconTrash, IconPause } from '../shared/icons.jsx';
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder.js';

/* ---- constants ---- */
const MAX_BARS = 120;
const SAMPLE_MS = 100;

/* ---- helpers ---- */

function createAttachmentId(file) {
    const base = `${String(file?.name ?? '').trim()}-${Number(file?.size ?? 0)}-${Number(file?.lastModified ?? 0)}`;
    return base || `file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatFileSize(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
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

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result ?? '');
            const separator = result.indexOf(',');
            if (separator < 0 || separator === result.length - 1) {
                reject(new Error('Failed to encode voice message.'));
                return;
            }
            resolve(result.slice(separator + 1));
        };
        reader.onerror = () => {
            reject(new Error('Failed to encode voice message.'));
        };
        reader.readAsDataURL(blob);
    });
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Chat input box.
 * - Auto-resizes the textarea.
 * - Enter = send, Shift+Enter = newline.
 * - Mic icon → recording overlay with waveform.
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

    /* ---- Voice recording ---- */
    const {
        state: recorderState,
        error: recorderError,
        getAmplitude,
        getDuration,
        startRecording,
        stopRecording,
        cancelRecording,
        pauseRecording,
        resumeRecording,
    } = useVoiceRecorder();

    const [isRecording, setIsRecording] = useState(false);
    const [waveformBars, setWaveformBars] = useState([]);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const waveformHistoryRef = useRef([]);
    const getAmplitudeRef = useRef(getAmplitude);
    const getDurationRef = useRef(getDuration);

    useEffect(() => { getAmplitudeRef.current = getAmplitude; }, [getAmplitude]);
    useEffect(() => { getDurationRef.current = getDuration; }, [getDuration]);

    // Waveform sampling + duration tick — only while recording
    useEffect(() => {
        if (recorderState !== 'recording') return;

        const id = setInterval(() => {
            const amp = getAmplitudeRef.current();
            const height = Math.min(100, Math.max(8, amp * 500));
            const history = waveformHistoryRef.current;
            history.push(height);
            if (history.length > MAX_BARS) history.shift();
            setWaveformBars([...history]);
            setRecordingDuration(getDurationRef.current());
        }, SAMPLE_MS);

        return () => clearInterval(id);
    }, [recorderState]);

    // Keep duration ticking while paused (frozen value)
    useEffect(() => {
        if (recorderState === 'paused') {
            setRecordingDuration(getDurationRef.current());
        }
    }, [recorderState]);

    // Auto-cancel on error
    useEffect(() => {
        if (isRecording && recorderState === 'error') {
            const timer = setTimeout(() => {
                setIsRecording(false);
            }, 2000);
            return () => clearTimeout(timer);
        }
    }, [isRecording, recorderState]);

    /* ---- Focus helpers ---- */
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

    /* ---- Text input handlers ---- */
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
        if (selectedFiles.length === 0) return;

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
        const next = attachmentList.filter((a) => String(a?.id) !== String(attachmentId));
        onAttachmentsChange?.(next);
        setAttachmentError('');
    }

    function submit() {
        if (isSending || !canSubmit) return;
        onSend({ text: value, attachments: attachmentList });
        onDraftChange?.('');
        onAttachmentsChange?.([]);
        setAttachmentError('');
        focusTextarea();
    }

    /* ---- Voice handlers ---- */
    function handleMicClick() {
        if (isSending) return;
        waveformHistoryRef.current = [];
        setWaveformBars([]);
        setRecordingDuration(0);
        setIsRecording(true);
        startRecording();
    }

    async function handleVoiceSend() {
        const result = await stopRecording();
        setIsRecording(false);
        if (result) {
            try {
                const base64 = await blobToBase64(result.blob);
                const extension = result.mimeType.includes('mp4') ? 'm4a' : 'webm';
                onSend({
                    text: '',
                    attachments: [{
                        id: `voice-${Date.now()}`,
                        name: `voice-message.${extension}`,
                        mimeType: result.mimeType,
                        size: result.blob.size,
                        data: base64,
                    }],
                });
            } catch {
                // encoding failed
            }
        }
        focusTextarea();
    }

    function handleVoiceCancel() {
        cancelRecording();
        setIsRecording(false);
        focusTextarea();
    }

    function handleTogglePause() {
        if (recorderState === 'recording') {
            pauseRecording();
        } else if (recorderState === 'paused') {
            resumeRecording();
        }
    }

    /* ---- Render ---- */
    const showRecordingUI = isRecording && (recorderState === 'recording' || recorderState === 'paused');
    const showRecordingStatus = isRecording && (recorderState === 'requesting' || recorderState === 'error');

    return (
        <div className={`chat-input-container${isChatMode ? ' pinned' : ''}`}>
            <div className="chat-input-box">
                {/* ---- Input area: stacked to preserve exact height during voice recording ---- */}
                <div className="input-area" style={{ display: 'grid' }}>
                    <textarea
                        ref={textareaRef}
                        id="chatInput"
                        value={value}
                        placeholder={isSending ? 'Gemini is thinking…' : isChatMode ? 'Reply…' : 'How can I help you today?'}
                        rows={1}
                        autoFocus={!isSending}
                        onChange={handleInput}
                        onKeyDown={handleKeyDown}
                        style={{
                            gridArea: '1 / 1',
                            opacity: (showRecordingUI || showRecordingStatus) ? 0 : 1,
                            pointerEvents: (showRecordingUI || showRecordingStatus) ? 'none' : 'auto',
                            resize: 'none',
                            background: 'transparent'
                        }}
                    />

                    {showRecordingUI && (
                        <div className="voice-waveform-row" style={{ gridArea: '1 / 1', zIndex: 1 }}>
                            <div className={`voice-rec-dot${recorderState === 'paused' ? ' paused' : ''}`} />
                            <div className="voice-waveform">
                                {waveformBars.map((height, i) => (
                                    <div
                                        key={i}
                                        className="voice-bar"
                                        style={{
                                            height: `${height > 0 ? Math.max(8, height) : 0}%`,
                                            opacity: height > 0 ? 1 : 0,
                                        }}
                                    />
                                ))}
                            </div>
                            <span className="voice-timer">{formatDuration(recordingDuration)}</span>
                        </div>
                    )}

                    {showRecordingStatus && (
                        <div className={`voice-status-text${recorderState === 'error' ? ' voice-error-text' : ''}`} style={{ gridArea: '1 / 1', zIndex: 1 }}>
                            {recorderState === 'error'
                                ? (recorderError || 'Could not access microphone.')
                                : 'Requesting microphone access…'}
                        </div>
                    )}
                </div>

                {/* ---- Hidden file input ---- */}
                <input
                    ref={fileInputRef}
                    className="attach-input"
                    type="file"
                    multiple
                    onChange={handleFileSelection}
                />

                {/* ---- Attachment chips (hidden when recording) ---- */}
                {!isRecording && attachmentList.length > 0 && (
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
                {!isRecording && attachmentError && (
                    <div className="input-attachments-error">{attachmentError}</div>
                )}

                {/* ---- Footer: always present, buttons swap ---- */}
                <div className="input-footer">
                    <div className="input-left">
                        {isRecording ? (
                            <button
                                type="button"
                                className="attach-btn voice-cancel"
                                title="Cancel recording"
                                onClick={handleVoiceCancel}
                            >
                                <IconTrash />
                            </button>
                        ) : (
                            <button
                                type="button"
                                className={`attach-btn${hasAttachments ? ' has-attachments' : ''}`}
                                title="Attach file"
                                onClick={openAttachmentDialog}
                                disabled={isSending}
                            >
                                <IconPlus />
                            </button>
                        )}
                    </div>
                    <div className="input-right">
                        {isRecording ? (
                            <>
                                {(recorderState === 'recording' || recorderState === 'paused') && (
                                    <button
                                        type="button"
                                        className="voice-btn"
                                        title={recorderState === 'paused' ? 'Resume' : 'Pause'}
                                        onClick={handleTogglePause}
                                    >
                                        {recorderState === 'paused' ? <IconMic /> : <IconPause />}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="send-btn"
                                    title="Send voice message"
                                    onClick={handleVoiceSend}
                                >
                                    <IconArrowUp />
                                </button>
                            </>
                        ) : isSending ? (
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
                            <button
                                type="button"
                                className="voice-btn"
                                title="Voice input"
                                onClick={handleMicClick}
                                disabled={isSending}
                            >
                                <IconMic />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});
