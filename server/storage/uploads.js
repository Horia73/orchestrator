import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
    UPLOADS_DATA_DIR,
    UPLOADS_FILES_DIR,
    UPLOADS_METADATA_DIR,
} from '../core/dataPaths.js';

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

function sanitizeUploadId(value) {
    const normalized = String(value ?? '').trim();
    if (!normalized || !/^upload-[a-f0-9-]+$/i.test(normalized)) {
        const error = new Error('Invalid upload id.');
        error.code = 'UPLOAD_INVALID_ID';
        throw error;
    }
    return normalized;
}

function sanitizeUploadName(value, fallback = 'attachment') {
    const normalized = String(value ?? '').trim().replace(/[\\/]+/g, '_');
    if (!normalized) {
        return fallback;
    }
    if (normalized.length <= 220) {
        return normalized;
    }
    return `${normalized.slice(0, 217)}...`;
}

function normalizeMimeType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || !normalized.includes('/')) {
        return 'application/octet-stream';
    }
    return normalized;
}

function metadataPath(uploadId) {
    return path.join(UPLOADS_METADATA_DIR, `${uploadId}.json`);
}

function filePath(uploadId) {
    return path.join(UPLOADS_FILES_DIR, uploadId);
}

function buildPublicUploadDescriptor(metadata) {
    if (!metadata || typeof metadata !== 'object') {
        return null;
    }

    return {
        uploadId: metadata.id,
        name: metadata.name,
        mimeType: metadata.mimeType,
        sizeBytes: metadata.sizeBytes,
        fileUri: `/api/uploads/${encodeURIComponent(metadata.id)}/content`,
    };
}

async function writeMetadata(metadata) {
    const file = metadataPath(metadata.id);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(metadata, null, 2), 'utf8');
    await fsp.rename(tmp, file);
}

export async function initUploadStorage() {
    await fsp.mkdir(UPLOADS_DATA_DIR, { recursive: true });
    await fsp.mkdir(UPLOADS_FILES_DIR, { recursive: true });
    await fsp.mkdir(UPLOADS_METADATA_DIR, { recursive: true });
}

export async function readUploadMetadata(uploadId) {
    const normalizedUploadId = sanitizeUploadId(uploadId);
    try {
        const raw = await fsp.readFile(metadataPath(normalizedUploadId), 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

export async function resolveUpload(uploadId) {
    const metadata = await readUploadMetadata(uploadId);
    if (!metadata) {
        const error = new Error('Upload not found.');
        error.code = 'UPLOAD_NOT_FOUND';
        throw error;
    }

    return {
        metadata,
        public: buildPublicUploadDescriptor(metadata),
        absolutePath: filePath(metadata.id),
    };
}

export async function createUploadFromBuffer({
    buffer,
    name,
    mimeType,
} = {}) {
    await initUploadStorage();

    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    if (data.length === 0) {
        const error = new Error('Uploaded file is empty.');
        error.code = 'UPLOAD_EMPTY';
        throw error;
    }
    if (data.length > MAX_UPLOAD_BYTES) {
        const error = new Error('Upload exceeds the 1 GB limit.');
        error.code = 'UPLOAD_TOO_LARGE';
        throw error;
    }

    const id = `upload-${randomUUID()}`;
    const hash = createHash('sha256').update(data).digest('hex');
    const metadata = {
        id,
        name: sanitizeUploadName(name),
        mimeType: normalizeMimeType(mimeType),
        sizeBytes: data.length,
        sha256: hash,
        createdAt: Date.now(),
        committedAt: null,
    };

    await fsp.writeFile(filePath(id), data);
    await writeMetadata(metadata);

    return {
        metadata,
        public: buildPublicUploadDescriptor(metadata),
        absolutePath: filePath(id),
    };
}

export async function createUploadFromRequestStream({
    request,
    name,
    mimeType,
} = {}) {
    await initUploadStorage();

    const id = `upload-${randomUUID()}`;
    const destinationPath = filePath(id);
    const tempPath = `${destinationPath}.part`;
    const hash = createHash('sha256');
    let sizeBytes = 0;

    const meter = new Transform({
        transform(chunk, _encoding, callback) {
            sizeBytes += chunk.length;
            if (sizeBytes > MAX_UPLOAD_BYTES) {
                const error = new Error('Upload exceeds the 1 GB limit.');
                error.code = 'UPLOAD_TOO_LARGE';
                callback(error);
                return;
            }

            hash.update(chunk);
            callback(null, chunk);
        },
    });

    try {
        await pipeline(
            request,
            meter,
            fs.createWriteStream(tempPath, { flags: 'wx' }),
        );
        if (sizeBytes === 0) {
            const error = new Error('Uploaded file is empty.');
            error.code = 'UPLOAD_EMPTY';
            throw error;
        }

        await fsp.rename(tempPath, destinationPath);

        const metadata = {
            id,
            name: sanitizeUploadName(name),
            mimeType: normalizeMimeType(mimeType),
            sizeBytes,
            sha256: hash.digest('hex'),
            createdAt: Date.now(),
            committedAt: null,
        };

        await writeMetadata(metadata);

        return {
            metadata,
            public: buildPublicUploadDescriptor(metadata),
            absolutePath: destinationPath,
        };
    } catch (error) {
        await fsp.rm(tempPath, { force: true }).catch(() => undefined);
        await fsp.rm(destinationPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export async function markUploadsCommitted(uploadIds, details = {}) {
    const normalizedIds = [...new Set((Array.isArray(uploadIds) ? uploadIds : [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean))];

    for (const uploadId of normalizedIds) {
        const metadata = await readUploadMetadata(uploadId);
        if (!metadata) {
            continue;
        }

        if (metadata.committedAt) {
            continue;
        }

        metadata.committedAt = Date.now();
        if (details.chatId) {
            metadata.chatId = String(details.chatId);
        }
        if (details.messageId) {
            metadata.messageId = String(details.messageId);
        }
        await writeMetadata(metadata);
    }
}

export async function deleteUpload(uploadId, { allowCommitted = false } = {}) {
    const metadata = await readUploadMetadata(uploadId);
    if (!metadata) {
        return false;
    }

    if (!allowCommitted && metadata.committedAt) {
        const error = new Error('Committed uploads cannot be removed.');
        error.code = 'UPLOAD_ALREADY_COMMITTED';
        throw error;
    }

    await fsp.rm(filePath(metadata.id), { force: true });
    await fsp.rm(metadataPath(metadata.id), { force: true });
    return true;
}

export async function deleteUploads(uploadIds, options = {}) {
    for (const uploadId of uploadIds) {
        try {
            await deleteUpload(uploadId, options);
        } catch {
            // Ignore best-effort cleanup failures.
        }
    }
}

export function getUploadResponseHeaders(metadata) {
    const name = sanitizeUploadName(metadata?.name);
    return {
        'Content-Type': normalizeMimeType(metadata?.mimeType),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=31536000, immutable',
    };
}

export function buildUploadPartDescriptor(metadata) {
    const publicUpload = buildPublicUploadDescriptor(metadata);
    if (!publicUpload) {
        return null;
    }

    return {
        uploadId: publicUpload.uploadId,
        fileUri: publicUpload.fileUri,
        mimeType: publicUpload.mimeType,
        displayName: publicUpload.name,
        sizeBytes: publicUpload.sizeBytes,
    };
}
