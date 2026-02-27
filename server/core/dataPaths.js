import path from 'node:path';

export const DATA_ROOT_DIR = path.resolve(process.cwd(), 'server', 'data');

export const CHAT_DATA_DIR = path.join(DATA_ROOT_DIR, 'chats');
export const CHAT_MESSAGES_DIR = path.join(CHAT_DATA_DIR, 'messages');
export const CHAT_INDEX_PATH = path.join(CHAT_DATA_DIR, 'index.json');

export const SETTINGS_DATA_DIR = path.join(DATA_ROOT_DIR, 'settings');
export const SETTINGS_PATH = path.join(SETTINGS_DATA_DIR, 'settings.json');

export const USAGE_DATA_DIR = path.join(DATA_ROOT_DIR, 'usage');
export const USAGE_LOG_PATH = path.join(USAGE_DATA_DIR, 'requests.jsonl');

export const LOG_DATA_DIR = path.join(DATA_ROOT_DIR, 'logs');
export const LOGS_PATH = path.join(LOG_DATA_DIR, 'system.jsonl');

export const LEGACY_SETTINGS_PATH = path.join(DATA_ROOT_DIR, 'settings.json');
export const LEGACY_USAGE_LOG_PATH = path.join(DATA_ROOT_DIR, 'usage.jsonl');
export const LEGACY_LOGS_PATH = path.join(DATA_ROOT_DIR, 'logs.jsonl');
export const LEGACY_CHAT_INDEX_PATH = path.join(DATA_ROOT_DIR, 'index.json');
export const LEGACY_CHAT_FILES_DIR = path.join(DATA_ROOT_DIR, 'chats');
