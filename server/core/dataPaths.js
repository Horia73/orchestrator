import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ORCHESTRATOR_HOME = path.join(os.homedir(), '.orchestrator');

// Agent workspace — agents create and manage projects here.
export const PROJECTS_DIR = path.join(ORCHESTRATOR_HOME, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
export const CONFIG_PATH = path.join(ORCHESTRATOR_HOME, 'config.json');
export const MODELS_CONFIG_PATH = path.join(ORCHESTRATOR_HOME, 'models.json');
export const DATA_ROOT_DIR = path.join(ORCHESTRATOR_HOME, 'data');

export const CHAT_DATA_DIR = path.join(DATA_ROOT_DIR, 'chats');
export const CHAT_MESSAGES_DIR = path.join(CHAT_DATA_DIR, 'messages');
export const CHAT_INDEX_PATH = path.join(CHAT_DATA_DIR, 'index.json');

export const UPLOADS_DATA_DIR = path.join(DATA_ROOT_DIR, 'uploads');
export const UPLOADS_FILES_DIR = path.join(UPLOADS_DATA_DIR, 'files');
export const UPLOADS_METADATA_DIR = path.join(UPLOADS_DATA_DIR, 'metadata');

export const USAGE_DATA_DIR = path.join(DATA_ROOT_DIR, 'usage');
export const USAGE_LOG_PATH = path.join(USAGE_DATA_DIR, 'requests.jsonl');

export const LOG_DATA_DIR = path.join(DATA_ROOT_DIR, 'logs');
export const LOGS_PATH = path.join(LOG_DATA_DIR, 'system.jsonl');

export const MEMORY_DIR = path.join(DATA_ROOT_DIR, 'memory');
export const MEMORY_PATH = path.join(MEMORY_DIR, 'MEMORY.md');
export const USER_MEMORY_PATH = path.join(MEMORY_DIR, 'USER.md');
export const IDENTITY_MEMORY_PATH = path.join(MEMORY_DIR, 'IDENTITY.md');
export const SOUL_MEMORY_PATH = path.join(MEMORY_DIR, 'SOUL.md');
export const INTEGRATIONS_MEMORY_PATH = path.join(MEMORY_DIR, 'INTEGRATIONS.md');
export const DAILY_MEMORY_DIR = path.join(MEMORY_DIR, 'daily');

export const SKILLS_WORKSPACE_DIR = path.join(DATA_ROOT_DIR, 'skills');

export const CRON_DATA_DIR = path.join(DATA_ROOT_DIR, 'cron');
export const CRON_STORE_PATH = path.join(CRON_DATA_DIR, 'jobs.json');

export const SECRETS_DIR = path.join(DATA_ROOT_DIR, 'secrets');
export const SECRETS_ENV_PATH = path.join(SECRETS_DIR, 'SECRETS.env');
