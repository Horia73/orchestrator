import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import {
  extensionFromGeminiMimeType,
  mimeTypeFromFileExtension,
  normalizeGeminiMimeType,
} from './gemini-file-support.js';

function sanitizeSegment(value, fallback = 'file') {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function safeBaseName(name) {
  const raw = path.basename(String(name || 'file'));
  return sanitizeSegment(raw.replace(/\.[a-z0-9]+$/i, ''), 'file');
}

function pickExtension(fileName, mimeType) {
  const byName = path.extname(String(fileName || '')).toLowerCase();
  if (/^\.[a-z0-9]+$/.test(byName)) return byName;
  const byMime = extensionFromGeminiMimeType(mimeType);
  return byMime || '';
}

function sanitizeMimeType(mimeType, fileName) {
  const normalized = normalizeGeminiMimeType(mimeType, fileName);
  if (normalized) return normalized;

  const raw = String(mimeType || '')
    .trim()
    .toLowerCase()
    .split(';', 1)[0]
    .trim();
  return raw || 'application/octet-stream';
}

function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

export class MediaStore {
  constructor(config) {
    this.config = config;
  }

  async init() {
    if (!this.config.enabled) return;
    await fsp.mkdir(this.config.storageDir, { recursive: true });
  }

  prepareStorageTarget({ fileName, mimeType, conversationId }) {
    const normalizedMime = sanitizeMimeType(mimeType, fileName);
    const convSegment = sanitizeSegment(conversationId || 'general', 'general');
    const base = safeBaseName(fileName);
    const ext = pickExtension(fileName, normalizedMime);
    const storageKey = `${Date.now()}_${randomToken()}_${convSegment}_${base}${ext}`;
    const absolutePath = path.join(this.config.storageDir, storageKey);

    return {
      storageKey,
      absolutePath,
      normalizedMime,
      normalizedName: fileName || `${base}${ext}`,
      urlPath: `/api/media/files/${encodeURIComponent(storageKey)}`,
    };
  }

  async saveBase64({ fileName, mimeType, dataBase64, conversationId }) {
    if (!this.config.enabled) {
      throw new Error('Media storage is disabled.');
    }

    const target = this.prepareStorageTarget({ fileName, mimeType, conversationId });
    const payload = String(dataBase64 || '').trim();
    if (!payload) {
      throw new Error('Missing file payload.');
    }

    const buffer = Buffer.from(payload, 'base64');
    if (!buffer || buffer.length === 0) {
      throw new Error('Invalid base64 payload.');
    }
    if (buffer.length > this.config.maxFileBytes) {
      throw new Error(`File too large. Max ${this.config.maxFileBytes} bytes.`);
    }
    await fsp.writeFile(target.absolutePath, buffer);

    return {
      storageKey: target.storageKey,
      size: buffer.length,
      mimeType: target.normalizedMime,
      name: target.normalizedName,
      urlPath: target.urlPath,
    };
  }

  async saveStream({ fileName, mimeType, stream, conversationId }) {
    if (!this.config.enabled) {
      throw new Error('Media storage is disabled.');
    }

    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('Invalid upload stream.');
    }

    const target = this.prepareStorageTarget({ fileName, mimeType, conversationId });
    let writtenBytes = 0;
    const limiter = new Transform({
      transform: (chunk, _encoding, callback) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        writtenBytes += buffer.length;
        if (writtenBytes > this.config.maxFileBytes) {
          callback(new Error(`File too large. Max ${this.config.maxFileBytes} bytes.`));
          return;
        }
        callback(null, buffer);
      },
    });

    try {
      await pipeline(
        stream,
        limiter,
        fs.createWriteStream(target.absolutePath, { flags: 'w' }),
      );
    } catch (error) {
      await fsp.unlink(target.absolutePath).catch(() => {});
      throw error;
    }

    if (writtenBytes <= 0) {
      await fsp.unlink(target.absolutePath).catch(() => {});
      throw new Error('Uploaded file is empty.');
    }

    return {
      storageKey: target.storageKey,
      size: writtenBytes,
      mimeType: target.normalizedMime,
      name: target.normalizedName,
      urlPath: target.urlPath,
    };
  }

  resolveFile(storageKey) {
    const key = String(storageKey || '').trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
      throw new Error('Invalid file key.');
    }

    const absolutePath = path.join(this.config.storageDir, key);
    const normalizedRoot = path.resolve(this.config.storageDir);
    const normalizedFile = path.resolve(absolutePath);
    if (!normalizedFile.startsWith(normalizedRoot + path.sep) && normalizedFile !== normalizedRoot) {
      throw new Error('Invalid file path.');
    }

    const ext = path.extname(key).toLowerCase();
    const contentType = mimeTypeFromFileExtension(ext) || 'application/octet-stream';
    return {
      absolutePath: normalizedFile,
      contentType,
      filename: key,
    };
  }

  createReadStream(storageKey) {
    const fileInfo = this.resolveFile(storageKey);
    if (!fs.existsSync(fileInfo.absolutePath)) {
      return null;
    }
    return {
      ...fileInfo,
      stream: fs.createReadStream(fileInfo.absolutePath),
    };
  }
}
