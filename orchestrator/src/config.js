import process from 'process';
import path from 'path';

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function parseNonNegativeInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseJsonObject(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '*') return '*';

  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function parseOriginList(raw, fallback = []) {
  if (raw === undefined || raw === null || raw === '') {
    return [...fallback];
  }

  return String(raw)
    .split(',')
    .map((part) => normalizeOrigin(part))
    .filter(Boolean);
}

function mapThinkingLevelToBudget(level) {
  const normalized = String(level || '').trim().toLowerCase();
  if (normalized === 'none' || normalized === 'off') return 0;
  if (normalized === 'minimal') return 256;
  if (normalized === 'low') return 512;
  if (normalized === 'medium') return 1024;
  if (normalized === 'high') return 2048;
  if (normalized === 'max') return 4096;
  return 256;
}

export function loadConfig() {
  const defaultAllowedOrigins = [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:4173',
    'http://localhost:4173',
  ];
  const allowedOrigins = parseOriginList(process.env.ORCHESTRATOR_ALLOWED_ORIGINS, defaultAllowedOrigins);

  const mediaStorageDir = process.env.MEDIA_STORAGE_DIR
    ? path.resolve(process.cwd(), process.env.MEDIA_STORAGE_DIR)
    : path.resolve(process.cwd(), 'uploads');
  const llmThinkingBudget = parseNonNegativeInt(
    process.env.ORCHESTRATOR_THINKING_BUDGET,
    mapThinkingLevelToBudget(process.env.ORCHESTRATOR_THINKING_LEVEL || 'minimal')
  );
  const browserThinkingBudget = parseNonNegativeInt(process.env.BROWSER_AGENT_THINKING_BUDGET, 0);
  const ttsAgentApiKey = process.env.TTS_AGENT_API_KEY || process.env.GEMINI_API_KEY || '';
  const ttsAgentModel = process.env.TTS_AGENT_MODEL || 'gemini-2.5-flash-preview-tts';
  const ttsAgentVoice = process.env.TTS_AGENT_VOICE || 'Kore';
  const imageDefaultCount = parsePositiveInt(process.env.IMAGE_AGENT_DEFAULT_IMAGE_COUNT, 1);
  const logDir = process.env.ORCHESTRATOR_LOG_DIR
    ? path.resolve(process.cwd(), process.env.ORCHESTRATOR_LOG_DIR)
    : path.resolve(process.cwd(), 'logs');
  const settingsFile = process.env.ORCHESTRATOR_SETTINGS_FILE
    ? path.resolve(process.cwd(), process.env.ORCHESTRATOR_SETTINGS_FILE)
    : path.resolve(process.cwd(), 'runtime-settings.json');
  const pricingOverrides = parseJsonObject(process.env.ORCHESTRATOR_MODEL_PRICING_JSON, {});
  const terminalToolCwdRaw = process.env.TERMINAL_TOOL_CWD || process.env.TERMINAL_AGENT_CWD;
  const terminalToolCwd = terminalToolCwdRaw
    ? path.resolve(process.cwd(), terminalToolCwdRaw)
    : process.cwd();

  return {
    server: {
      host: process.env.ORCHESTRATOR_HOST || '127.0.0.1',
      port: parsePositiveInt(process.env.ORCHESTRATOR_PORT, 3030),
      apiKey: process.env.ORCHESTRATOR_API_KEY || '',
      allowedOrigins,
    },
    llm: {
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.ORCHESTRATOR_MODEL || 'gemini-3-flash-preview-02-05',
      thinkingBudget: llmThinkingBudget,
      temperature: Number.parseFloat(process.env.ORCHESTRATOR_TEMPERATURE || '0.2'),
      webResearch: parseBoolean(process.env.ORCHESTRATOR_WEB_RESEARCH, false),
    },
    conversations: {
      maxMessagesPerConversation: parseNonNegativeInt(process.env.ORCHESTRATOR_MAX_MESSAGES, 0),
    },
    browserAgent: {
      enabled: parseBoolean(process.env.BROWSER_AGENT_ENABLED, true),
      baseUrl: process.env.BROWSER_AGENT_URL || 'http://127.0.0.1:3020',
      apiKey: process.env.BROWSER_AGENT_API_KEY || '',
      pollIntervalMs: parsePositiveInt(process.env.BROWSER_AGENT_POLL_INTERVAL_MS, 1400),
      timeoutMs: parsePositiveInt(process.env.BROWSER_AGENT_TIMEOUT_MS, 90000),
      model: process.env.BROWSER_AGENT_MODEL || 'gemini-2.0-flash',
      thinkingBudget: browserThinkingBudget,
    },
    codingAgent: {
      enabled: parseBoolean(process.env.CODING_AGENT_ENABLED, true),
      model: process.env.CODING_AGENT_MODEL || 'gemini-2.5-pro',
    },
    imageAgent: {
      enabled: parseBoolean(process.env.IMAGE_AGENT_ENABLED, true),
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.IMAGE_AGENT_MODEL || 'gemini-3-pro-image-preview',
      timeoutMs: parsePositiveInt(process.env.IMAGE_AGENT_TIMEOUT_MS, 120000),
      defaultAspectRatio: process.env.IMAGE_AGENT_DEFAULT_ASPECT_RATIO || '1:1',
      defaultNumberOfImages: Math.max(1, Math.min(imageDefaultCount, 4)),
      outputMimeType: process.env.IMAGE_AGENT_OUTPUT_MIME_TYPE || 'image/png',
    },
    ttsAgent: {
      enabled: parseBoolean(process.env.TTS_AGENT_ENABLED, true),
      apiKey: ttsAgentApiKey,
      model: ttsAgentModel,
      voice: ttsAgentVoice,
      outputMimeType: process.env.TTS_AGENT_OUTPUT_MIME || 'audio/wav',
      timeoutMs: parsePositiveInt(process.env.TTS_AGENT_TIMEOUT_MS, 120000),
      maxPromptChars: parsePositiveInt(process.env.TTS_AGENT_MAX_PROMPT_CHARS, 6000),
    },
    terminalTool: {
      enabled: parseBoolean(
        process.env.TERMINAL_TOOL_ENABLED,
        parseBoolean(process.env.TERMINAL_AGENT_ENABLED, true)
      ),
      cwd: terminalToolCwd,
      shell: process.env.TERMINAL_TOOL_SHELL || process.env.TERMINAL_AGENT_SHELL || process.env.SHELL || '/bin/zsh',
      timeoutMs: parsePositiveInt(
        process.env.TERMINAL_TOOL_TIMEOUT_MS,
        parsePositiveInt(process.env.TERMINAL_AGENT_TIMEOUT_MS, 20000)
      ),
      maxOutputChars: parsePositiveInt(
        process.env.TERMINAL_TOOL_MAX_OUTPUT_CHARS,
        parsePositiveInt(process.env.TERMINAL_AGENT_MAX_OUTPUT_CHARS, 6000)
      ),
    },
    ptyTerminalTool: {
      enabled: parseBoolean(process.env.PTY_TERMINAL_TOOL_ENABLED, true),
    },
    fsTool: {
      enabled: parseBoolean(
        process.env.FS_TOOL_ENABLED,
        parseBoolean(process.env.FS_AGENT_ENABLED, true)
      ),
    },
    readUrlTool: {
      enabled: parseBoolean(process.env.READ_URL_TOOL_ENABLED, true),
    },
    codeExecuteTool: {
      enabled: parseBoolean(process.env.CODE_EXECUTE_TOOL_ENABLED, true),
    },
    media: {
      enabled: parseBoolean(process.env.MEDIA_ENABLED, true),
      storageDir: mediaStorageDir,
      maxFileBytes: parsePositiveInt(process.env.MEDIA_MAX_FILE_BYTES, 2 * 1024 * 1024 * 1024),
    },

    runtime: {
      logDir,
      settingsFile,
    },
    pricing: pricingOverrides,
  };
}
