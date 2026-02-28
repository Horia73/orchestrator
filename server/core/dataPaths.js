import os from 'node:os';
import path from 'node:path';

export const ORCHESTRATOR_HOME = path.join(os.homedir(), '.orchestrator');
export const CONFIG_PATH = path.join(ORCHESTRATOR_HOME, 'config.json');
export const DATA_ROOT_DIR = path.join(ORCHESTRATOR_HOME, 'data');

export const CHAT_DATA_DIR = path.join(DATA_ROOT_DIR, 'chats');
export const CHAT_MESSAGES_DIR = path.join(CHAT_DATA_DIR, 'messages');
export const CHAT_INDEX_PATH = path.join(CHAT_DATA_DIR, 'index.json');

export const SETTINGS_DATA_DIR = path.join(DATA_ROOT_DIR, 'settings');
export const SETTINGS_PATH = path.join(SETTINGS_DATA_DIR, 'settings.json');

export const USAGE_DATA_DIR = path.join(DATA_ROOT_DIR, 'usage');
export const USAGE_LOG_PATH = path.join(USAGE_DATA_DIR, 'requests.jsonl');

export const LOG_DATA_DIR = path.join(DATA_ROOT_DIR, 'logs');
export const LOGS_PATH = path.join(LOG_DATA_DIR, 'system.jsonl');
