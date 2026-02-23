import path from 'path';

export const GEMINI_SUPPORTED_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/x-javascript',
  'application/x-python',
  'audio/aac',
  'audio/aiff',
  'audio/flac',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'image/bmp',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/css',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/md',
  'text/plain',
  'text/rtf',
  'text/x-python',
  'text/xml',
  'video/3gpp',
  'video/avi',
  'video/mp4',
  'video/mov',
  'video/mpeg',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/x-flv',
]);

const MIME_ALIASES = new Map([
  ['application/csv', 'text/csv'],
  ['application/ecmascript', 'text/javascript'],
  ['application/javascript', 'text/javascript'],
  ['application/ld+json', 'application/json'],
  ['application/markdown', 'text/md'],
  ['application/rtf', 'text/rtf'],
  ['application/x-json', 'application/json'],
  ['application/xml', 'text/xml'],
  ['application/x-python-code', 'text/x-python'],
  ['audio/mpeg', 'audio/mp3'],
  ['audio/x-aiff', 'audio/aiff'],
  ['audio/x-flac', 'audio/flac'],
  ['audio/x-wav', 'audio/wav'],
  ['image/x-ms-bmp', 'image/bmp'],
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['text/markdown', 'text/md'],
  ['text/scv', 'text/csv'],
  ['text/x-markdown', 'text/md'],
  ['video/3gp', 'video/3gpp'],
  ['video/quicktime', 'video/mov'],
  ['video/x-msvideo', 'video/avi'],
  ['video/x-ms-wmv', 'video/wmv'],
]);

const MIME_BY_EXTENSION = new Map([
  ['.3gp', 'video/3gpp'],
  ['.3gpp', 'video/3gpp'],
  ['.aac', 'audio/aac'],
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
  ['.avi', 'video/avi'],
  ['.bmp', 'image/bmp'],
  ['.cjs', 'text/javascript'],
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.flac', 'audio/flac'],
  ['.flv', 'video/x-flv'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript'],
  ['.json', 'application/json'],
  ['.markdown', 'text/md'],
  ['.md', 'text/md'],
  ['.mjs', 'text/javascript'],
  ['.mov', 'video/mov'],
  ['.mp3', 'audio/mp3'],
  ['.mp4', 'video/mp4'],
  ['.mpeg', 'video/mpeg'],
  ['.mpg', 'video/mpg'],
  ['.ogg', 'audio/ogg'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.py', 'text/x-python'],
  ['.rtf', 'text/rtf'],
  ['.txt', 'text/plain'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.wmv', 'video/wmv'],
  ['.xml', 'text/xml'],
]);

const EXTENSION_BY_MIME = new Map([
  ['application/json', '.json'],
  ['application/pdf', '.pdf'],
  ['application/x-javascript', '.js'],
  ['application/x-python', '.py'],
  ['audio/aac', '.aac'],
  ['audio/aiff', '.aiff'],
  ['audio/flac', '.flac'],
  ['audio/mp3', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['image/bmp', '.bmp'],
  ['image/gif', '.gif'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['text/css', '.css'],
  ['text/csv', '.csv'],
  ['text/html', '.html'],
  ['text/javascript', '.js'],
  ['text/md', '.md'],
  ['text/plain', '.txt'],
  ['text/rtf', '.rtf'],
  ['text/x-python', '.py'],
  ['text/xml', '.xml'],
  ['video/3gpp', '.3gpp'],
  ['video/avi', '.avi'],
  ['video/mp4', '.mp4'],
  ['video/mov', '.mov'],
  ['video/mpeg', '.mpeg'],
  ['video/mpg', '.mpg'],
  ['video/webm', '.webm'],
  ['video/wmv', '.wmv'],
  ['video/x-flv', '.flv'],
]);

function normalizeRawMimeType(mimeType) {
  const raw = String(mimeType || '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  return raw.split(';', 1)[0].trim();
}

function inferMimeTypeFromFileName(fileName) {
  const ext = path.extname(String(fileName || '').trim().toLowerCase());
  if (!ext) return '';
  return MIME_BY_EXTENSION.get(ext) || '';
}

export function normalizeGeminiMimeType(mimeType, fileName = '') {
  let normalized = normalizeRawMimeType(mimeType);
  if (!normalized && fileName) {
    normalized = inferMimeTypeFromFileName(fileName);
  }
  if (!normalized) return '';
  return MIME_ALIASES.get(normalized) || normalized;
}

export function isGeminiSupportedMimeType(mimeType, fileName = '') {
  const normalized = normalizeGeminiMimeType(mimeType, fileName);
  if (!normalized) return false;
  return GEMINI_SUPPORTED_MIME_TYPES.has(normalized);
}

export function inferGeminiMimeTypeFromFileName(fileName) {
  const inferred = inferMimeTypeFromFileName(fileName);
  if (!inferred) return '';
  return normalizeGeminiMimeType(inferred, fileName);
}

export function extensionFromGeminiMimeType(mimeType) {
  const normalized = normalizeGeminiMimeType(mimeType);
  if (!normalized) return '';
  return EXTENSION_BY_MIME.get(normalized) || '';
}

export function mimeTypeFromFileExtension(fileNameOrExtension) {
  const value = String(fileNameOrExtension || '').trim().toLowerCase();
  if (!value) return '';
  const ext = value.startsWith('.') ? value : path.extname(value);
  if (!ext) return '';
  return MIME_BY_EXTENSION.get(ext) || '';
}
