import { randomUUID } from 'node:crypto';
import { ORCHESTRATOR_AGENT_ID } from '../../agents/orchestrator/index.js';
import { normalizeAgentId } from '../../storage/settings.js';
import {
    buildUploadPartDescriptor,
    createUploadFromBuffer,
    readUploadMetadata,
} from '../../storage/uploads.js';

const MAX_MESSAGE_ATTACHMENTS = 16;
const MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

function countImageAttachments(attachments) {
    if (!Array.isArray(attachments)) {
        return 0;
    }

    let count = 0;
    for (const attachment of attachments) {
        const mimeType = String(attachment?.mimeType ?? '').trim().toLowerCase();
        if (mimeType.startsWith('image/')) {
            count += 1;
        }
    }

    return count;
}

function detectOrchestratorRoute({ attachments }) {
    const imageAttachmentCount = countImageAttachments(attachments);

    return {
        agentId: ORCHESTRATOR_AGENT_ID,
        routed: false,
        reason: 'general_intent',
        imageAttachmentCount,
    };
}

function normalizeAttachmentMimeType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || !normalized.includes('/')) {
        return 'application/octet-stream';
    }

    return normalized;
}

function normalizeAttachmentName(value, index) {
    const fallback = `attachment-${index + 1}`;
    const normalized = String(value ?? '').trim();
    if (!normalized) return fallback;
    if (normalized.length <= 220) return normalized;
    return `${normalized.slice(0, 217)}...`;
}

export function createMessageId() {
    return `msg-${randomUUID()}`;
}

export function formatGeminiError(error) {
    if (error instanceof Error && error.message) {
        return `AI error: ${error.message}`;
    }

    return 'AI error: Request failed.';
}

export function normalizeMessageText(value) {
    return String(value ?? '').trim();
}

export function resolveRuntimeAgentForMessage({ chatAgentId, text, attachments }) {
    const normalizedChatAgentId = normalizeAgentId(chatAgentId);
    if (normalizedChatAgentId !== ORCHESTRATOR_AGENT_ID) {
        return {
            agentId: normalizedChatAgentId,
            routed: false,
            reason: 'fixed_chat_agent',
            imageAttachmentCount: countImageAttachments(attachments),
        };
    }

    return detectOrchestratorRoute({
        text,
        attachments,
    });
}

export async function normalizeIncomingAttachments(value) {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value)) {
        throw new Error('Attachments must be an array.');
    }

    if (value.length > MAX_MESSAGE_ATTACHMENTS) {
        throw new Error(`Too many attachments. Maximum is ${MAX_MESSAGE_ATTACHMENTS}.`);
    }

    const normalized = [];
    let totalBytes = 0;

    for (let index = 0; index < value.length; index += 1) {
        const rawAttachment = value[index];
        if (!rawAttachment || typeof rawAttachment !== 'object') {
            continue;
        }

        let uploadDescriptor = null;
        const uploadId = String(rawAttachment.uploadId ?? '').trim();
        if (uploadId) {
            const metadata = await readUploadMetadata(uploadId);
            if (!metadata) {
                throw new Error(`Attachment "${normalizeAttachmentName(rawAttachment.name, index)}" was not found.`);
            }
            const descriptor = buildUploadPartDescriptor(metadata);
            uploadDescriptor = {
                uploadId: descriptor.uploadId,
                name: descriptor.displayName,
                mimeType: descriptor.mimeType,
                sizeBytes: descriptor.sizeBytes,
                fileUri: descriptor.fileUri,
            };
        } else {
            const rawDataValue = String(rawAttachment.data ?? '').trim();
            if (!rawDataValue) {
                continue;
            }

            const data = rawDataValue.startsWith('data:')
                ? rawDataValue.slice(rawDataValue.indexOf(',') + 1).trim()
                : rawDataValue;

            const bytes = Buffer.from(data, 'base64');
            if (bytes.length === 0) {
                throw new Error(`Attachment ${index + 1} is empty or not valid base64.`);
            }

            const createdUpload = await createUploadFromBuffer({
                buffer: bytes,
                name: normalizeAttachmentName(rawAttachment.name, index),
                mimeType: normalizeAttachmentMimeType(rawAttachment.mimeType ?? rawAttachment.type),
            });

            const descriptor = buildUploadPartDescriptor(createdUpload.metadata);
            uploadDescriptor = {
                uploadId: descriptor.uploadId,
                name: descriptor.displayName,
                mimeType: descriptor.mimeType,
                sizeBytes: descriptor.sizeBytes,
                fileUri: descriptor.fileUri,
            };
        }

        if (uploadDescriptor.sizeBytes > MAX_ATTACHMENT_BYTES) {
            throw new Error(`Attachment "${uploadDescriptor.name}" is larger than 1 GB.`);
        }

        totalBytes += uploadDescriptor.sizeBytes;
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
            throw new Error('Total attachment size exceeds 2 GB.');
        }

        normalized.push(uploadDescriptor);
    }

    return normalized;
}

export function buildUserMessageParts({ text, attachments }) {
    const normalizedText = String(text ?? '').trim();
    const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
    const parts = normalizedAttachments.map((attachment) => ({
        fileData: {
            uploadId: attachment.uploadId,
            fileUri: attachment.fileUri,
            mimeType: attachment.mimeType,
            displayName: attachment.name,
            sizeBytes: attachment.sizeBytes,
        },
    }));

    if (normalizedText) {
        parts.push({ text: normalizedText });
    }

    return parts.length > 0 ? parts : undefined;
}

export function getFirstMessageSeed({ text, attachments }) {
    const normalizedText = String(text ?? '').trim();
    if (normalizedText) {
        return normalizedText;
    }

    const firstAttachmentName = String(attachments?.[0]?.name ?? '').trim();
    if (firstAttachmentName) {
        return `Attachment: ${firstAttachmentName}`;
    }

    return 'Attachment';
}

export function buildUsageInputText({ text, attachments }) {
    const normalizedText = String(text ?? '').trim();
    const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
    if (normalizedAttachments.length === 0) {
        return normalizedText;
    }

    const label = normalizedAttachments
        .map((attachment) => String(attachment?.name ?? '').trim())
        .filter(Boolean)
        .join(', ');

    if (!normalizedText) {
        return label ? `[attachments] ${label}` : '[attachments]';
    }

    if (!label) {
        return normalizedText;
    }

    return `${normalizedText}\n\n[attachments] ${label}`;
}

export function normalizeClientId(value) {
    const normalized = String(value ?? '').trim();
    return normalized || 'unknown-client';
}

export function normalizeReplyToPayload(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const chatId = String(value.chatId ?? '').trim();
    const messageId = String(value.messageId ?? '').trim();
    if (!chatId || !messageId) {
        return null;
    }

    const previewText = String(value.previewText ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
    const chatTitle = String(value.chatTitle ?? '').trim().slice(0, 80);
    const role = String(value.role ?? '').trim().toLowerCase() === 'user' ? 'user' : 'ai';

    return {
        chatId,
        messageId,
        role,
        previewText,
        ...(chatTitle ? { chatTitle } : {}),
    };
}
