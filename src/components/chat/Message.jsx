import { forwardRef, useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownContent } from './MarkdownContent.jsx';
import { ThoughtBlock } from './ThoughtBlock.jsx';
import { ToolBlock } from './ToolBlock.jsx';
import { FileManagementBlock } from './FileManagementBlock.jsx';
import { EditManagementBlock } from './EditManagementBlock.jsx';
import { getAgentToolMetadata, getToolCallId } from './agentCallUtils.js';
import { IconPlay, IconPause } from '../shared/icons.jsx';

const FILE_MANAGEMENT_TOOLS = new Set([
    'view_file',
    'list_dir',
    'find_by_name',
    'grep_search',
    'view_file_outline',
    'view_code_item',
    'view_content_chunk',
]);
const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const INLINE_IMAGE_MARKDOWN_REGEX = /!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INLINE_IMAGE_MARKDOWN_TEST_REGEX = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

function normalizeMimeType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || !normalized.includes('/')) {
        return 'application/octet-stream';
    }

    return normalized;
}

function getAttachmentKind(mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType === 'application/pdf') return 'pdf';
    return 'other';
}

function getDisplayNameFromUri(uri) {
    const normalized = String(uri ?? '').trim();
    if (!normalized) return '';

    try {
        const parsed = new URL(normalized);
        const path = String(parsed.pathname ?? '');
        const segment = path.split('/').filter(Boolean).pop() ?? '';
        return decodeURIComponent(segment);
    } catch {
        const segment = normalized.split('/').filter(Boolean).pop() ?? '';
        return segment;
    }
}

function sanitizeAttachmentName(value, fallback) {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function getMessageAttachments(parts) {
    if (!Array.isArray(parts)) {
        return [];
    }

    const attachments = [];
    const seen = new Set();

    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (!part || typeof part !== 'object') {
            continue;
        }

        const inlineData = part.inlineData;
        if (inlineData && typeof inlineData === 'object') {
            const mimeType = normalizeMimeType(inlineData.mimeType ?? inlineData.mime_type);
            const data = String(inlineData.data ?? '').trim();
            if (data) {
                const key = `inline:${mimeType}:${data.length}:${data.slice(0, 32)}:${data.slice(-32)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const displayName = sanitizeAttachmentName(
                        inlineData.displayName,
                        `attachment-${attachments.length + 1}`,
                    );
                    attachments.push({
                        id: `inline-${index}`,
                        source: 'inline',
                        mimeType,
                        kind: getAttachmentKind(mimeType),
                        displayName,
                        href: `data:${mimeType};base64,${data}`,
                    });
                }
            }
        }

        const fileData = part.fileData;
        if (fileData && typeof fileData === 'object') {
            const fileUri = String(fileData.fileUri ?? fileData.file_uri ?? '').trim();
            if (!fileUri) {
                continue;
            }

            const mimeType = normalizeMimeType(fileData.mimeType ?? fileData.mime_type);
            const key = `file:${fileUri}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);

            const displayName = sanitizeAttachmentName(
                fileData.displayName,
                getDisplayNameFromUri(fileUri) || `file-${attachments.length + 1}`,
            );
            attachments.push({
                id: `file-${index}`,
                source: 'file',
                mimeType,
                kind: getAttachmentKind(mimeType),
                displayName,
                href: fileUri,
            });
        }
    }

    return attachments;
}

function isFileManagementTool(part) {
    const name = typeof part?.functionCall?.name === 'string'
        ? part.functionCall.name
        : '';

    return FILE_MANAGEMENT_TOOLS.has(name);
}

function isEditTool(part) {
    const name = typeof part?.functionCall?.name === 'string'
        ? part.functionCall.name
        : '';

    return EDIT_TOOLS.has(name);
}

function buildToolBlocks(parts) {
    const callParts = (parts || []).filter((part) => part?.functionCall && !part?.thoughtSignature);
    const responseParts = (parts || [])
        .filter((part) => part?.functionResponse)
        .map((part) => part.functionResponse);

    const toolParts = callParts.map((part) => ({
        functionCall: part.functionCall,
        functionResponse: part.functionResponse,
        isExecuting: part.isExecuting === true,
    }));

    const callIndexById = new Map();
    const pendingIndexesByName = new Map();
    for (let index = 0; index < toolParts.length; index += 1) {
        const current = toolParts[index];
        if (current.functionResponse) continue;

        const call = current.functionCall ?? {};
        const callId = typeof call.id === 'string' ? call.id.trim() : '';
        const callName = typeof call.name === 'string' ? call.name : 'unknown_tool';

        if (callId) {
            callIndexById.set(callId, index);
        }

        const queue = pendingIndexesByName.get(callName) ?? [];
        queue.push(index);
        pendingIndexesByName.set(callName, queue);
    }

    for (const functionResponse of responseParts) {
        const responseId = typeof functionResponse?.id === 'string' ? functionResponse.id.trim() : '';
        const responseName = typeof functionResponse?.name === 'string' ? functionResponse.name : 'unknown_tool';
        let targetIndex;

        if (responseId && callIndexById.has(responseId)) {
            targetIndex = callIndexById.get(responseId);
        } else {
            const queue = pendingIndexesByName.get(responseName) ?? [];
            while (queue.length > 0) {
                const candidate = queue.shift();
                if (candidate !== undefined && !toolParts[candidate]?.functionResponse) {
                    targetIndex = candidate;
                    break;
                }
            }
            pendingIndexesByName.set(responseName, queue);
        }

        if (targetIndex === undefined) {
            continue;
        }

        toolParts[targetIndex] = {
            ...toolParts[targetIndex],
            functionResponse,
            isExecuting: false,
        };
    }

    const renderedBlocks = [];
    for (let index = 0; index < toolParts.length; index += 1) {
        const current = toolParts[index];
        const isFileGroup = isFileManagementTool(current);
        const isEditGroup = isEditTool(current);

        if (!isFileGroup && !isEditGroup) {
            renderedBlocks.push({
                type: 'single_tool',
                key: `tool-${index}`,
                toolPart: current,
            });
            continue;
        }

        if (isEditGroup) {
            renderedBlocks.push({
                type: 'edit_management',
                key: `edit-management-${index}`,
                entries: [current],
            });
            continue;
        }

        const groupedEntries = [current];
        const startIndex = index;

        while (
            index + 1 < toolParts.length
            && isFileGroup
            && isFileManagementTool(toolParts[index + 1])
        ) {
            index += 1;
            groupedEntries.push(toolParts[index]);
        }

        renderedBlocks.push({
            type: isFileGroup ? 'file_management' : 'edit_management',
            key: `${isFileGroup ? 'file-management' : 'edit-management'}-${startIndex}`,
            entries: groupedEntries,
        });
    }

    return renderedBlocks;
}

function formatAudioTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function AudioPlayer({ href }) {
    const audioRef = useRef(null);
    const progressRef = useRef(null);
    const seekingRef = useRef(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const onLoadedMetadata = () => {
            const d = audio.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
        };
        const onDurationChange = () => {
            const d = audio.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
        };
        const onTimeUpdate = () => {
            if (!seekingRef.current) setCurrentTime(audio.currentTime || 0);
        };
        const onEnded = () => { setIsPlaying(false); setCurrentTime(0); };
        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);

        audio.addEventListener('loadedmetadata', onLoadedMetadata);
        audio.addEventListener('durationchange', onDurationChange);
        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);

        return () => {
            audio.removeEventListener('loadedmetadata', onLoadedMetadata);
            audio.removeEventListener('durationchange', onDurationChange);
            audio.removeEventListener('timeupdate', onTimeUpdate);
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
        };
    }, []);

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (isPlaying) {
            audio.pause();
        } else {
            void audio.play().catch(() => { });
        }
    }, [isPlaying]);

    const seekToPosition = useCallback((clientX) => {
        const audio = audioRef.current;
        const bar = progressRef.current;
        if (!audio || !bar || !duration) return;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        audio.currentTime = ratio * duration;
        setCurrentTime(ratio * duration);
    }, [duration]);

    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        seekingRef.current = true;
        seekToPosition(e.clientX);

        const onMouseMove = (moveEvent) => {
            seekToPosition(moveEvent.clientX);
        };
        const onMouseUp = () => {
            seekingRef.current = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }, [seekToPosition]);

    const handleTouchStart = useCallback((e) => {
        seekingRef.current = true;
        if (e.touches.length > 0) {
            seekToPosition(e.touches[0].clientX);
        }

        const onTouchMove = (moveEvent) => {
            if (moveEvent.touches.length > 0) {
                seekToPosition(moveEvent.touches[0].clientX);
            }
        };
        const onTouchEnd = () => {
            seekingRef.current = false;
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
        };

        document.addEventListener('touchmove', onTouchMove);
        document.addEventListener('touchend', onTouchEnd);
    }, [seekToPosition]);

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <div className="audio-player">
            <audio ref={audioRef} src={href} preload="metadata" />
            <button type="button" className="audio-play-btn" onClick={togglePlay}>
                {isPlaying ? <IconPause /> : <IconPlay />}
            </button>
            <div
                className="audio-progress-wrap"
                ref={progressRef}
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
            >
                <div className="audio-progress-bar">
                    <div className="audio-progress-fill" style={{ width: `${progress}%` }} />
                    <div className="audio-progress-thumb" style={{ left: `${progress}%` }} />
                </div>
            </div>
            <span className="audio-time">
                {formatAudioTime(currentTime)}{duration > 0 ? ` / ${formatAudioTime(duration)}` : ''}
            </span>
        </div>
    );
}

function VideoAttachment({ attachment }) {
    const mediaRef = useRef(null);

    const playFromCurrent = () => {
        const media = mediaRef.current;
        if (!media) return;
        void media.play().catch(() => undefined);
    };

    const startFromBeginning = () => {
        const media = mediaRef.current;
        if (!media) return;
        try {
            media.currentTime = 0;
        } catch {
            // no-op
        }
        void media.play().catch(() => undefined);
    };

    const stopPlayback = () => {
        const media = mediaRef.current;
        if (!media) return;
        media.pause();
        try {
            media.currentTime = 0;
        } catch {
            // no-op
        }
    };

    return (
        <div className="message-media-preview">
            <video
                ref={mediaRef}
                className="message-attachment-video"
                src={attachment.href}
                preload="metadata"
                playsInline
            />
            <div className="message-media-controls">
                <button type="button" onClick={startFromBeginning}>Start</button>
                <button type="button" onClick={playFromCurrent}>Play</button>
                <button type="button" onClick={stopPlayback}>Stop</button>
            </div>
        </div>
    );
}

function MediaAttachment({ attachment }) {
    if (attachment.kind === 'video') {
        return <VideoAttachment attachment={attachment} />;
    }
    return (
        <div className="message-media-preview">
            <AudioPlayer href={attachment.href} />
        </div>
    );
}

function ImageLightbox({ src, alt, onClose }) {
    useEffect(() => {
        const handler = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    return createPortal(
        <div className="lightbox-overlay" onClick={onClose} role="dialog" aria-modal="true">
            <img
                className="lightbox-image"
                src={src}
                alt={alt}
                onClick={(e) => e.stopPropagation()}
            />
        </div>,
        document.body,
    );
}

function AttachmentCard({ attachment, index }) {
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const name = sanitizeAttachmentName(attachment.displayName, `attachment-${index + 1}`);
    const actionLabel = attachment.source === 'inline' ? 'Download' : 'Open';
    const actionProps = attachment.source === 'inline'
        ? { download: name }
        : { target: '_blank', rel: 'noreferrer' };

    if (attachment.kind === 'image') {
        return (
            <figure className="message-attachment-image-wrap" key={attachment.id}>
                <img
                    className="message-attachment-image"
                    src={attachment.href}
                    alt={name}
                    loading="lazy"
                    onClick={() => setLightboxOpen(true)}
                />
                {lightboxOpen && (
                    <ImageLightbox
                        src={attachment.href}
                        alt={name}
                        onClose={() => setLightboxOpen(false)}
                    />
                )}
            </figure>
        );
    }

    if (attachment.kind === 'audio' || attachment.kind === 'video') {
        return (
            <article className="message-attachment-card" key={attachment.id}>
                {attachment.kind === 'video' && (
                    <div className="message-attachment-header">{name}</div>
                )}
                <MediaAttachment attachment={attachment} />
            </article>
        );
    }

    if (attachment.kind === 'pdf') {
        return (
            <article className="message-attachment-card" key={attachment.id}>
                <div className="message-attachment-header">{name}</div>
                <iframe
                    className="message-attachment-pdf"
                    src={attachment.href}
                    title={name}
                    loading="lazy"
                />
                <a className="message-attachment-action" href={attachment.href} {...actionProps}>
                    {actionLabel}
                </a>
            </article>
        );
    }

    return (
        <article className="message-attachment-card" key={attachment.id}>
            <div className="message-attachment-header">{name}</div>
            <div className="message-attachment-meta">{attachment.mimeType}</div>
            <a className="message-attachment-action" href={attachment.href} {...actionProps}>
                {actionLabel}
            </a>
        </article>
    );
}

function AttachmentGallery({ parts }) {
    const attachments = getMessageAttachments(parts);
    if (attachments.length === 0) {
        return null;
    }

    return (
        <div className="message-attachments">
            {attachments.map((attachment, index) => (
                <AttachmentCard
                    key={`${attachment.id}-${index}`}
                    attachment={attachment}
                    index={index}
                />
            ))}
        </div>
    );
}

function AttachmentGalleryFromList({ attachments }) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
        return null;
    }

    return (
        <div className="message-attachments">
            {attachments.map((attachment, index) => (
                <AttachmentCard
                    key={`${attachment.id}-${index}`}
                    attachment={attachment}
                    index={index}
                />
            ))}
        </div>
    );
}

function safeDecodeUriComponent(value) {
    const normalized = String(value ?? '');
    if (!normalized) {
        return '';
    }

    try {
        return decodeURIComponent(normalized);
    } catch {
        return normalized;
    }
}

function getInlineTargetTokens(target) {
    const raw = String(target ?? '').trim();
    if (!raw) return [];

    const withoutAngles = raw.startsWith('<') && raw.endsWith('>')
        ? raw.slice(1, -1)
        : raw;
    const decoded = safeDecodeUriComponent(withoutAngles);
    const stripQueryAndHash = (value) => String(value ?? '').split('#')[0].split('?')[0];
    const baseRaw = stripQueryAndHash(withoutAngles).split('/').filter(Boolean).pop() ?? '';
    const baseDecoded = stripQueryAndHash(decoded).split('/').filter(Boolean).pop() ?? '';

    const candidates = [
        withoutAngles,
        decoded,
        baseRaw,
        baseDecoded,
    ];

    const normalized = new Set();
    for (const candidate of candidates) {
        const token = String(candidate ?? '').trim().toLowerCase();
        if (token) normalized.add(token);
    }

    return [...normalized];
}

function getAttachmentMatchTokens(attachment) {
    const name = String(attachment?.displayName ?? '').trim();
    const decodedName = safeDecodeUriComponent(name);
    const href = String(attachment?.href ?? '').trim();
    const isDataHref = href.startsWith('data:');
    const hrefFileName = isDataHref
        ? ''
        : (safeDecodeUriComponent(
            href.split('#')[0].split('?')[0].split('/').filter(Boolean).pop() ?? '',
        ));

    const candidates = [name, decodedName, hrefFileName];
    const tokens = new Set();
    for (const candidate of candidates) {
        const token = String(candidate ?? '').trim().toLowerCase();
        if (token) tokens.add(token);
    }

    return [...tokens];
}

function findAttachmentForInlineTarget(target, imageAttachments, usedAttachmentIds) {
    const targetTokens = getInlineTargetTokens(target);
    if (targetTokens.length === 0) {
        return null;
    }

    for (const attachment of imageAttachments) {
        if (usedAttachmentIds.has(attachment.id)) {
            continue;
        }

        const attachmentTokens = getAttachmentMatchTokens(attachment);
        if (attachmentTokens.some((token) => targetTokens.includes(token))) {
            return attachment;
        }
    }

    return null;
}

function buildInlineImageRenderPlan(text, attachments) {
    const raw = String(text ?? '');
    if (!raw) {
        return null;
    }

    const imageAttachments = (Array.isArray(attachments) ? attachments : [])
        .filter((attachment) => attachment?.kind === 'image');
    if (imageAttachments.length === 0 || !INLINE_IMAGE_MARKDOWN_TEST_REGEX.test(raw)) {
        return null;
    }

    INLINE_IMAGE_MARKDOWN_REGEX.lastIndex = 0;
    const segments = [];
    const consumedAttachmentIds = new Set();
    let cursor = 0;
    let match = INLINE_IMAGE_MARKDOWN_REGEX.exec(raw);
    while (match) {
        const [fullMatch, altText, target] = match;
        const start = match.index;

        if (start > cursor) {
            segments.push({
                type: 'text',
                value: raw.slice(cursor, start),
            });
        }

        const matchedAttachment = findAttachmentForInlineTarget(
            target,
            imageAttachments,
            consumedAttachmentIds,
        );
        if (matchedAttachment) {
            consumedAttachmentIds.add(matchedAttachment.id);
            segments.push({
                type: 'image',
                attachment: matchedAttachment,
            });
        } else if (String(altText ?? '').trim()) {
            segments.push({
                type: 'text',
                value: String(altText),
            });
        }

        cursor = start + fullMatch.length;
        match = INLINE_IMAGE_MARKDOWN_REGEX.exec(raw);
    }

    if (cursor < raw.length) {
        segments.push({
            type: 'text',
            value: raw.slice(cursor),
        });
    }

    const hasRenderableSegment = segments.some((segment) => (
        segment.type === 'image'
        || String(segment.value ?? '').trim().length > 0
    ));
    if (!hasRenderableSegment) {
        return null;
    }

    return {
        segments,
        consumedAttachmentIds,
    };
}

function hasInlineImageMarkdown(value) {
    return INLINE_IMAGE_MARKDOWN_TEST_REGEX.test(String(value ?? ''));
}

// Detect when the model outputs a structured JSON response like
// {"content": "...", "attachments": [...]} and extract just the text content.
function unwrapStructuredText(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed.length < 3 || trimmed[0] !== '{') return text;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
            return parsed.content;
        }
    } catch {
        // not JSON
    }
    return text;
}

function doesImagePrecedeText(parts) {
    if (!Array.isArray(parts)) return false;
    let firstImageIndex = -1;
    let firstTextIndex = -1;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (firstImageIndex === -1) {
            const mimeInline = String(part?.inlineData?.mimeType ?? '').trim().toLowerCase();
            const mimeFile = String(part?.fileData?.mimeType ?? '').trim().toLowerCase();
            if (
                (mimeInline.startsWith('image/') && String(part.inlineData?.data ?? '').trim())
                || (mimeFile.startsWith('image/') && String(part.fileData?.fileUri ?? part.fileData?.file_uri ?? '').trim())
            ) {
                firstImageIndex = i;
            }
        }
        if (
            firstTextIndex === -1
            && typeof part?.text === 'string'
            && part?.thought !== true
            && part.text.trim()
        ) {
            firstTextIndex = i;
        }
    }

    if (firstImageIndex === -1) return false;
    if (firstTextIndex === -1) return true;
    return firstImageIndex < firstTextIndex;
}

function hasRenderedAttachments(parts) {
    if (!Array.isArray(parts)) {
        return false;
    }

    for (const part of parts) {
        if (!part || typeof part !== 'object') {
            continue;
        }

        const inlineData = part.inlineData;
        if (inlineData && typeof inlineData === 'object') {
            const data = String(inlineData.data ?? '').trim();
            if (data) {
                return true;
            }
        }

        const fileData = part.fileData;
        if (fileData && typeof fileData === 'object') {
            const fileUri = String(fileData.fileUri ?? fileData.file_uri ?? '').trim();
            if (fileUri) {
                return true;
            }
        }
    }

    return false;
}

export const Message = forwardRef(function Message({
    role,
    text,
    thought,
    parts,
    steps,
    isThinking = false,
    onAgentCallToggle,
    activeAgentCallId = '',
}, ref) {
    if (role === 'user') {
        const hasText = String(text ?? '').trim().length > 0;
        return (
            <div className="message-user" ref={ref}>
                <div className="message-user-stack">
                    {hasText && (
                        <div className="message-user-bubble">
                            <MarkdownContent text={text} variant="user" />
                        </div>
                    )}
                    <AttachmentGallery parts={parts} />
                </div>
            </div>
        );
    }

    const renderAiContent = ({
        text: bodyText,
        thought: bodyThought,
        parts: bodyParts,
        fallbackParts,
        bodyIsThinking,
        textFirst = false,
        showWorkedWhenNoThought = false,
    }) => {
        const normalizedBodyParts = Array.isArray(bodyParts) ? bodyParts : [];
        const normalizedFallbackParts = Array.isArray(fallbackParts) ? fallbackParts : [];
        const toolRenderParts = normalizedBodyParts;
        const attachmentSourceParts = hasRenderedAttachments(normalizedBodyParts)
            ? normalizedBodyParts
            : normalizedFallbackParts;
        const imageBeforeText = doesImagePrecedeText(attachmentSourceParts);
        const renderedBlocks = buildToolBlocks(toolRenderParts);
        const attachments = getMessageAttachments(attachmentSourceParts);
        const inlineRenderPlan = buildInlineImageRenderPlan(bodyText, attachments);
        const consumedAttachmentIds = inlineRenderPlan?.consumedAttachmentIds ?? new Set();
        const remainingAttachments = attachments.filter(
            (attachment) => !consumedAttachmentIds.has(attachment.id),
        );
        const normalizedBodyText = unwrapStructuredText(String(bodyText ?? ''));
        const hasText = normalizedBodyText.trim().length > 0;
        const hasThought = String(bodyThought ?? '').trim().length > 0;
        const shouldRenderThoughtBlock = bodyIsThinking || hasThought || showWorkedWhenNoThought;
        const textNode = inlineRenderPlan
            ? (
                <div className="message-inline-content">
                    {inlineRenderPlan.segments.map((segment, index) => {
                        if (segment.type === 'image') {
                            return (
                                <AttachmentGalleryFromList
                                    key={`inline-image-${index}`}
                                    attachments={[segment.attachment]}
                                />
                            );
                        }

                        const segmentText = String(segment.value ?? '');
                        if (!segmentText.trim()) {
                            return null;
                        }

                        return (
                            <MarkdownContent
                                key={`inline-text-${index}`}
                                text={segmentText}
                                variant="ai"
                            />
                        );
                    })}
                </div>
            )
            : hasText
                ? <MarkdownContent text={normalizedBodyText} variant="ai" />
                : null;

        return (
            <>
                {shouldRenderThoughtBlock && (
                    <ThoughtBlock
                        thought={bodyThought}
                        isThinking={bodyIsThinking}
                        showWorkedWhenIdle={showWorkedWhenNoThought}
                    />
                )}

                {textFirst && textNode}

                {renderedBlocks.map((block) => {
                    if (block.type === 'file_management') {
                        return (
                            <FileManagementBlock
                                key={block.key}
                                entries={block.entries}
                            />
                        );
                    }

                    if (block.type === 'edit_management') {
                        return (
                            <EditManagementBlock
                                key={block.key}
                                entries={block.entries}
                            />
                        );
                    }

                    const toolPart = block.toolPart;
                    const toolName = String(toolPart?.functionCall?.name ?? '').trim();
                    const agentMeta = getAgentToolMetadata(toolName);
                    const toolCallId = getToolCallId(toolPart?.functionCall);
                    const isAgentCallOpen = !!agentMeta && toolCallId === String(activeAgentCallId ?? '').trim();
                    const handleAgentCallToggle = (agentMeta && onAgentCallToggle)
                        ? () => {
                            onAgentCallToggle({
                                callId: toolCallId,
                                agentId: agentMeta.agentId,
                                agentName: agentMeta.agentName,
                                toolName,
                                sourceContext: {
                                    text: bodyText,
                                    thought: bodyThought,
                                    parts: Array.isArray(parts) && parts.length > 0 ? parts : toolRenderParts,
                                },
                                toolPart: {
                                    functionCall: toolPart.functionCall,
                                    functionResponse: toolPart.functionResponse,
                                    isExecuting: toolPart.isExecuting === true,
                                },
                            });
                        }
                        : undefined;
                    return (
                        <ToolBlock
                            key={block.key}
                            functionCall={toolPart.functionCall}
                            functionResponse={toolPart.functionResponse}
                            isExecuting={toolPart.isExecuting}
                            onAgentCallToggle={handleAgentCallToggle}
                            isAgentCallOpen={isAgentCallOpen}
                        />
                    );
                })}

                {!textFirst && imageBeforeText && (
                    <AttachmentGalleryFromList attachments={remainingAttachments} />
                )}
                {!textFirst && textNode}
                {(!imageBeforeText || textFirst) && (
                    <AttachmentGalleryFromList attachments={remainingAttachments} />
                )}
            </>
        );
    };

    const normalizedSteps = Array.isArray(steps)
        ? steps.filter((step) => {
            const hasText = String(step?.text ?? '').trim().length > 0;
            const hasThought = String(step?.thought ?? '').trim().length > 0;
            const hasParts = Array.isArray(step?.parts) && step.parts.length > 0;
            const isThinkingStep = step?.isThinking === true;
            const isWorkedStep = step?.isWorked === true;
            return hasText || hasThought || hasParts || isThinkingStep || isWorkedStep;
        })
        : [];
    const shouldRenderSteps = normalizedSteps.length > 1;
    const messageHasAttachments = hasRenderedAttachments(parts);
    const stepUsesMessageAttachmentFallback = shouldRenderSteps
        ? normalizedSteps.map((step) => {
            const stepParts = Array.isArray(step?.parts) ? step.parts : [];
            const hasToolCall = stepParts.some((p) => p?.functionCall || p?.functionResponse);
            const hasStepText = String(step?.text ?? '').trim().length > 0;
            // A pure text step (no tool calls) with text content should inherit message
            // attachments so that doesImagePrecedeText can position them correctly.
            if (!hasToolCall && hasStepText && !hasRenderedAttachments(stepParts) && messageHasAttachments) {
                return true;
            }
            // Legacy: step text references inline images via markdown.
            return hasInlineImageMarkdown(step?.text) && !hasRenderedAttachments(stepParts) && messageHasAttachments;
        })
        : [];
    const hasStepUsingMessageAttachmentFallback = stepUsesMessageAttachmentFallback.some(Boolean);
    const shouldRenderMessageAttachmentsAfterSteps = shouldRenderSteps
        && messageHasAttachments
        && !normalizedSteps.some((step) => hasRenderedAttachments(step?.parts))
        && !hasStepUsingMessageAttachmentFallback;

    return (
        <div className="message-ai" ref={ref}>
            <div className="message-ai-content">
                {shouldRenderSteps
                    ? normalizedSteps.map((step, index) => (
                        <section
                            key={`step-${step.index ?? index + 1}`}
                            className="message-ai-step"
                        >
                            {renderAiContent({
                                text: step.text,
                                thought: step.thought,
                                parts: step.parts,
                                fallbackParts: stepUsesMessageAttachmentFallback[index] ? parts : [],
                                bodyIsThinking: step?.isThinking === true,
                                textFirst: step?.textFirst === true,
                                showWorkedWhenNoThought: step?.isWorked === true,
                            })}
                        </section>
                    ))
                    : renderAiContent({
                        text,
                        thought,
                        parts,
                        fallbackParts: [],
                        bodyIsThinking: isThinking,
                        showWorkedWhenNoThought: true,
                    })}
                {shouldRenderMessageAttachmentsAfterSteps && <AttachmentGallery parts={parts} />}
            </div>
        </div>
    );
});
