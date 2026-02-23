import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });
import http from 'http';
import path from 'path';
import { loadConfig } from './config.js';
import { DailyLogger } from './daily-logger.js';
import { MediaStore } from './media-store.js';
import { Orchestrator } from './orchestrator.js';
import { RuntimeSettingsStore } from './runtime-settings-store.js';
import { UsageTracker } from './usage-tracker.js';

const config = loadConfig();

let orchestrator;

const settingsStore = new RuntimeSettingsStore({
  filePath: config.runtime.settingsFile,
  onChange: (updatedSettings) => {
    if (orchestrator) {
      orchestrator.updateRuntimeSettings(updatedSettings);

      fireAndForget(logger.log({
        level: 'info',
        component: 'orchestrator',
        event: 'settings_auto_reloaded',
        message: 'Runtime settings watched file changed, auto-updating orchestrator.',
        data: {
          orchestratorModel: updatedSettings.orchestrator.model,
          browserModel: updatedSettings.agents.browser.model,
          terminalEnabled: updatedSettings.tools?.terminal?.enabled ?? updatedSettings.agents?.terminal?.enabled,
        },
      }));
    }
  },
  defaults: {
    orchestrator: {
      model: config.llm.model,
      thinkingBudget: config.llm.thinkingBudget,
      webResearch: config.llm.webResearch,
      temperature: config.llm.temperature,
    },
    agents: {
      browser: {
        model: config.browserAgent.model,
        thinkingBudget: config.browserAgent.thinkingBudget,
      },
      image: {
        model: config.imageAgent.model,
      },
      tts: {
        model: config.ttsAgent.model,
        voice: config.ttsAgent.voice,
      },
    },
    tools: {
      terminal: {
        enabled: config.terminalTool.enabled,
        cwd: config.terminalTool.cwd,
        shell: config.terminalTool.shell,
        timeoutMs: config.terminalTool.timeoutMs,
        maxOutputChars: config.terminalTool.maxOutputChars,
      },
      fs: {
        enabled: config.fsTool.enabled,
      },
    },
    ui: {
      assistantProfile: {
        name: 'AI Chat',
        emoji: '🤖',
      },
    },
    pricing: config.pricing || {},
  },
});
await settingsStore.init();

const logger = new DailyLogger({
  dir: path.join(config.runtime.logDir, 'events'),
});
await logger.init();

const usageTracker = new UsageTracker({
  dir: path.join(config.runtime.logDir, 'usage'),
  getPricingMap: () => settingsStore.getPricingMap(),
});
await usageTracker.init();

function fireAndForget(promise) {
  Promise.resolve(promise).catch((error) => {
    console.error('Background task failed:', error);
  });
}

const currentSettings = settingsStore.get();
config.llm.model = currentSettings.orchestrator.model;
config.llm.thinkingBudget = currentSettings.orchestrator.thinkingBudget;
config.llm.webResearch = currentSettings.orchestrator.webResearch;
config.llm.temperature = currentSettings.orchestrator.temperature;
config.browserAgent.model = currentSettings.agents.browser.model;
config.browserAgent.thinkingBudget = currentSettings.agents.browser.thinkingBudget;
config.imageAgent.model = currentSettings.agents?.image?.model || config.imageAgent.model;
config.ttsAgent.model = currentSettings.agents?.tts?.model || config.ttsAgent.model;
config.ttsAgent.voice = currentSettings.agents?.tts?.voice || config.ttsAgent.voice;
const terminalSettings = currentSettings.tools?.terminal || currentSettings.agents?.terminal || {};
const fsSettings = currentSettings.tools?.fs || currentSettings.agents?.fs || {};
config.terminalTool.enabled = typeof terminalSettings.enabled === 'boolean'
  ? terminalSettings.enabled
  : config.terminalTool.enabled;
config.terminalTool.cwd = String(terminalSettings.cwd || config.terminalTool.cwd);
config.terminalTool.shell = String(terminalSettings.shell || config.terminalTool.shell);
config.terminalTool.timeoutMs = Number(terminalSettings.timeoutMs) > 0
  ? Number(terminalSettings.timeoutMs)
  : config.terminalTool.timeoutMs;
config.terminalTool.maxOutputChars = Number(terminalSettings.maxOutputChars) > 0
  ? Number(terminalSettings.maxOutputChars)
  : config.terminalTool.maxOutputChars;
config.fsTool.enabled = typeof fsSettings.enabled === 'boolean'
  ? fsSettings.enabled
  : config.fsTool.enabled;

const mediaStore = new MediaStore(config.media);
await mediaStore.init();

orchestrator = new Orchestrator(config, {
  onUsage: (event) => fireAndForget(usageTracker.record(event)),
  onLog: (entry) => fireAndForget(logger.log(entry)),
  mediaStore,
});
await orchestrator.init();

await logger.log({
  level: 'info',
  component: 'orchestrator',
  event: 'startup',
  message: 'Orchestrator booted.',
  data: {
    model: config.llm.model,
    thinkingBudget: config.llm.thinkingBudget,
    browserModel: config.browserAgent.model,
    imageModel: config.imageAgent.model,
    ttsModel: config.ttsAgent.model,
    ttsVoice: config.ttsAgent.voice,
    terminalEnabled: config.terminalTool.enabled,
    terminalCwd: config.terminalTool.cwd,
    fsEnabled: config.fsTool.enabled,
  },
});

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function resolveCors(req, allowedOrigins = []) {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin) {
    return {
      allowed: true,
      allowOrigin: '',
    };
  }

  if (allowedOrigins.includes('*')) {
    return {
      allowed: true,
      allowOrigin: '*',
    };
  }

  if (allowedOrigins.includes(origin)) {
    return {
      allowed: true,
      allowOrigin: origin,
    };
  }

  return {
    allowed: false,
    allowOrigin: '',
  };
}

function setCorsHeaders(req, res) {
  const cors = resolveCors(req, config.server.allowedOrigins);
  if (cors.allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', cors.allowOrigin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key,x-file-name,x-conversation-id');
  return cors;
}

function ensureAuthorized(req, res) {
  if (!config.server.apiKey) {
    return true;
  }

  const headerApiKey = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;

  const provided = (Array.isArray(headerApiKey) ? headerApiKey[0] : headerApiKey) || bearerToken;
  if (provided !== config.server.apiKey) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized.' });
    return false;
  }

  return true;
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += piece.length;
    if (size > maxBytes) {
      throw new Error('Request body too large.');
    }
    chunks.push(piece);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

function getRequestUrl(rawUrl) {
  return new URL(rawUrl || '/', 'http://localhost');
}

function safeDecodeURIComponent(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isHealthPath(pathname) {
  return pathname === '/health' || pathname === '/api/health';
}

function isChatPath(pathname) {
  return pathname === '/chat' || pathname === '/api/chat';
}

function isChatStreamPath(pathname) {
  return pathname === '/chat/stream' || pathname === '/api/chat/stream';
}

function isMediaUploadPath(pathname) {
  return pathname === '/media/upload' || pathname === '/api/media/upload';
}

function isMediaUploadBinaryPath(pathname) {
  return pathname === '/media/upload/binary' || pathname === '/api/media/upload/binary';
}

function isSettingsPath(pathname) {
  return pathname === '/settings' || pathname === '/api/settings';
}

function isModelsPath(pathname) {
  return pathname === '/models' || pathname === '/api/models';
}

function isUsagePath(pathname) {
  return pathname === '/usage' || pathname === '/api/usage';
}

function isUsageEventsPath(pathname) {
  return pathname === '/usage/events' || pathname === '/api/usage/events';
}

function isLogsPath(pathname) {
  return pathname === '/logs' || pathname === '/api/logs';
}

function isContextStatusPath(pathname) {
  return pathname === '/context/status' || pathname === '/api/context/status';
}

function isBrowserOpenPath(pathname) {
  return pathname === '/browser/open' || pathname === '/api/browser/open';
}

function isBrowserStatusPath(pathname) {
  return pathname === '/browser/status' || pathname === '/api/browser/status';
}

function isBrowserFramePath(pathname) {
  return pathname === '/browser/frame' || pathname === '/api/browser/frame';
}

function isBrowserHistoryPath(pathname) {
  return pathname === '/browser/history' || pathname === '/api/browser/history';
}

function isBrowserManualControlPath(pathname) {
  return pathname === '/browser/manual-control' || pathname === '/api/browser/manual-control';
}

function isBrowserControlPath(pathname) {
  return pathname === '/browser/control' || pathname === '/api/browser/control';
}

function isBrowserTaskPath(pathname) {
  return pathname === '/browser/task' || pathname === '/api/browser/task';
}

function isBrowserStreamPath(pathname) {
  return pathname === '/browser/stream' || pathname === '/api/browser/stream';
}

function mediaFileKeyFromPath(pathname) {
  const prefixes = ['/media/files/', '/api/media/files/'];
  for (const prefix of prefixes) {
    if (pathname.startsWith(prefix)) {
      return pathname.slice(prefix.length);
    }
  }
  return '';
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function bindAbortOnDisconnect(req, res, abortController) {
  const abortIfNeeded = () => {
    if (res.writableEnded) return;
    if (abortController.signal.aborted) return;
    abortController.abort();
  };

  req.on('aborted', abortIfNeeded);
  res.on('close', abortIfNeeded);
}

function parseQueryBoolean(raw, fallback = false) {
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseQueryPositiveInt(raw, fallback, min = 1, max = 60) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));

    const onAbort = () => {
      cleanup();
      reject(new Error('Aborted'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveComponent(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'orchestrator' || value === 'orch') return 'orchestrator';
  if (value === 'browser' || value === 'browser-agent' || value === 'agent' || value === 'browser_agent') {
    return 'browser-agent';
  }
  if (value === 'image' || value === 'image-agent' || value === 'image_agent' || value === 'img') {
    return 'image-agent';
  }
  if (value === 'tts' || value === 'tts-agent' || value === 'voice' || value === 'speech') {
    return 'tts-agent';
  }
  if (value === 'terminal' || value === 'terminal-tool' || value === 'terminal-agent' || value === 'shell' || value === 'cmd') {
    return 'terminal-tool';
  }
  if (value === 'fs' || value === 'fs-tool' || value === 'fs-agent' || value === 'filesystem' || value === 'file') {
    return 'fs-tool';
  }
  return 'orchestrator';
}

function buildBrowserAgentHeaders(extra = {}) {
  const headers = {
    Accept: 'application/json',
    ...extra,
  };

  if (config.browserAgent.apiKey) {
    headers['x-api-key'] = config.browserAgent.apiKey;
  }

  return headers;
}

async function proxyBrowserAgentRequest(pathname, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`${config.browserAgent.baseUrl}${pathname}`, {
    method,
    headers: buildBrowserAgentHeaders(body !== undefined
      ? { 'Content-Type': 'application/json' }
      : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  const rawText = await response.text();
  let payload = {};

  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {
      ok: false,
      error: rawText || `Invalid JSON from browser agent (${pathname}).`,
    };
  }

  if (!response.ok || payload?.ok === false) {
    const message = payload?.error
      ? String(payload.error)
      : `Browser agent request failed (${pathname}) with HTTP ${response.status}`;
    const statusCode = Number(response.status) >= 400 ? Number(response.status) : 502;
    const error = new Error(message);
    error.statusCode = statusCode;
    throw error;
  }

  return payload;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = getRequestUrl(req.url);
  const pathname = requestUrl.pathname;
  const mediaKey = mediaFileKeyFromPath(pathname);
  const cors = setCorsHeaders(req, res);

  if (!cors.allowed) {
    sendJson(res, 403, { ok: false, error: 'CORS origin not allowed.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const isPublicRequest = req.method === 'GET' && (isHealthPath(pathname) || Boolean(mediaKey));
  if (!isPublicRequest && !ensureAuthorized(req, res)) {
    return;
  }

  if (req.method === 'GET' && mediaKey) {
    try {
      const decodedKey = decodeURIComponent(mediaKey);
      const file = mediaStore.createReadStream(decodedKey);
      if (!file) {
        sendJson(res, 404, { ok: false, error: 'File not found.' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': file.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });

      file.stream.on('error', () => {
        if (!res.writableEnded) {
          res.destroy();
        }
      });
      file.stream.pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isHealthPath(pathname)) {
    const runtime = orchestrator.getRuntimeSettings();
    sendJson(res, 200, {
      ok: true,
      service: 'orchestrator',
      orchestrator: {
        model: runtime.orchestrator.model,
        thinkingBudget: runtime.orchestrator.thinkingBudget,
        webResearch: runtime.orchestrator.webResearch,
      },
      agents: runtime.agents,
      date: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'GET' && isSettingsPath(pathname)) {
    sendJson(res, 200, {
      ok: true,
      settings: settingsStore.get(),
    });
    return;
  }

  if (req.method === 'PUT' && isSettingsPath(pathname)) {
    try {
      const body = await readJsonBody(req, 512 * 1024);
      const updatedSettings = await settingsStore.update(body);
      orchestrator.updateRuntimeSettings(updatedSettings);

      fireAndForget(logger.log({
        level: 'info',
        component: 'orchestrator',
        event: 'settings_updated',
        message: 'Runtime settings updated from API.',
        data: {
          orchestratorModel: updatedSettings.orchestrator.model,
          browserModel: updatedSettings.agents.browser.model,
          imageModel: updatedSettings.agents?.image?.model || '',
          ttsModel: updatedSettings.agents?.tts?.model || '',
          ttsVoice: updatedSettings.agents?.tts?.voice || '',
          terminalEnabled: updatedSettings.tools?.terminal?.enabled ?? updatedSettings.agents?.terminal?.enabled,
          terminalTimeoutMs: updatedSettings.tools?.terminal?.timeoutMs ?? updatedSettings.agents?.terminal?.timeoutMs,
          fsEnabled: updatedSettings.tools?.fs?.enabled ?? updatedSettings.agents?.fs?.enabled,
        },
      }));

      sendJson(res, 200, {
        ok: true,
        settings: updatedSettings,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isModelsPath(pathname)) {
    try {
      const search = requestUrl.searchParams.get('q') || '';
      const actionRaw = String(requestUrl.searchParams.get('action') || '').trim();
      const action = !actionRaw || actionRaw.toLowerCase() === 'all' ? '' : actionRaw;
      const models = await orchestrator.listAvailableModels({ search, action });
      const pricing = settingsStore.getPricingMap();
      const withPricing = models.map((model) => {
        const pricingEntry = pricing[model.id] || pricing[model.name] || null;
        return {
          ...model,
          pricing: pricingEntry,
        };
      });

      sendJson(res, 200, {
        ok: true,
        models: withPricing,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isUsagePath(pathname)) {
    try {
      const days = Number(requestUrl.searchParams.get('days') || 7);
      const summary = await usageTracker.getSummary({ days });
      sendJson(res, 200, {
        ok: true,
        usage: summary,
        note: 'Costs are estimated from your local pricing map, not returned directly by Google API.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isUsageEventsPath(pathname)) {
    try {
      const date = requestUrl.searchParams.get('date') || undefined;
      const limit = Number(requestUrl.searchParams.get('limit') || 500);
      const events = await usageTracker.getEvents({ date, limit });
      sendJson(res, 200, {
        ok: true,
        date: date || new Date().toISOString().slice(0, 10),
        events,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isLogsPath(pathname)) {
    try {
      const component = resolveComponent(requestUrl.searchParams.get('component'));
      const date = requestUrl.searchParams.get('date') || undefined;
      const limit = Number(requestUrl.searchParams.get('limit') || 200);

      const logs = await logger.read({ component, date, limit });
      sendJson(res, 200, {
        ok: true,
        component,
        date: date || new Date().toISOString().slice(0, 10),
        logs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'POST' && isContextStatusPath(pathname)) {
    try {
      const body = await readJsonBody(req, 512 * 1024);
      const conversationId = String(body.conversationId || '').trim();
      const message = String(body.message || '');
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      const context = await orchestrator.getContextUsage({
        conversationId,
        message,
        attachments,
      });

      sendJson(res, 200, {
        ok: true,
        context,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'POST' && isBrowserOpenPath(pathname)) {
    try {
      const payload = await proxyBrowserAgentRequest('/open', { method: 'POST' });
      sendJson(res, 200, {
        ok: true,
        status: payload.status || null,
        frame: payload.frame || null,
        history: Array.isArray(payload.history) ? payload.history : [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 502;
      sendJson(res, statusCode, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isBrowserStatusPath(pathname)) {
    try {
      const payload = await proxyBrowserAgentRequest('/status', { method: 'GET' });
      sendJson(res, 200, {
        ok: true,
        status: payload.status || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 502;
      sendJson(res, statusCode, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isBrowserFramePath(pathname)) {
    try {
      const live = requestUrl.searchParams.get('live') || '';
      const suffix = live ? `?live=${encodeURIComponent(live)}` : '';
      const payload = await proxyBrowserAgentRequest(`/frame${suffix}`, { method: 'GET' });
      sendJson(res, 200, {
        ok: true,
        frame: payload.frame || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 502;
      sendJson(res, statusCode, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isBrowserHistoryPath(pathname)) {
    try {
      const limit = requestUrl.searchParams.get('limit') || '';
      const suffix = limit ? `?limit=${encodeURIComponent(limit)}` : '';
      const payload = await proxyBrowserAgentRequest(`/history${suffix}`, { method: 'GET' });
      sendJson(res, 200, {
        ok: true,
        history: Array.isArray(payload.history) ? payload.history : [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 502;
      sendJson(res, statusCode, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'POST' && isBrowserManualControlPath(pathname)) {
    try {
      const body = await readJsonBody(req);
      const payload = await proxyBrowserAgentRequest('/manual-control', {
        method: 'POST',
        body: {
          enabled: body?.enabled,
        },
      });
      sendJson(res, 200, {
        ok: true,
        status: payload.status || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 502;
      sendJson(res, statusCode, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'POST' && isBrowserControlPath(pathname)) {
    try {
      const body = await readJsonBody(req);
      const payload = await proxyBrowserAgentRequest('/control', {
        method: 'POST',
        body,
      });
      sendJson(res, 200, {
        ok: true,
        result: payload.result || null,
        frame: payload.frame || null,
        status: payload.status || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 502;
      sendJson(res, statusCode, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'POST' && isBrowserTaskPath(pathname)) {
    try {
      const body = await readJsonBody(req);
      const goal = String(body?.goal || '').trim();
      if (!goal) {
        sendJson(res, 400, { ok: false, error: 'Missing non-empty string field: goal' });
        return;
      }

      const taskBody = {
        goal,
        cleanContext: typeof body?.cleanContext === 'boolean' ? body.cleanContext : undefined,
        preserveContext: typeof body?.preserveContext === 'boolean' ? body.preserveContext : undefined,
        model: typeof body?.model === 'string' ? body.model : undefined,
        thinkingBudget: Number.isFinite(Number(body?.thinkingBudget))
          ? Number(body.thinkingBudget)
          : undefined,
      };

      const payload = await proxyBrowserAgentRequest('/task', {
        method: 'POST',
        body: taskBody,
      });

      sendJson(res, 200, {
        ok: true,
        status: payload.status || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 502;
      sendJson(res, statusCode, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'GET' && isBrowserStreamPath(pathname)) {
    const live = parseQueryBoolean(requestUrl.searchParams.get('live'), true);
    const fps = parseQueryPositiveInt(requestUrl.searchParams.get('fps'), live ? 8 : 2, 1, 16);
    const includeStatus = parseQueryBoolean(requestUrl.searchParams.get('status'), true);
    const statusIntervalMs = 1200;
    const frameIntervalMs = Math.max(50, Math.floor(1000 / fps));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abortController = new AbortController();
    bindAbortOnDisconnect(req, res, abortController);

    writeSse(res, {
      type: 'start',
      live,
      fps,
      intervalMs: frameIntervalMs,
      status: includeStatus,
    });

    let statusCountdown = 0;

    while (!abortController.signal.aborted) {
      try {
        const frameSuffix = live ? '?live=1' : '';
        const payload = await proxyBrowserAgentRequest(`/frame${frameSuffix}`, {
          method: 'GET',
          signal: abortController.signal,
        });

        if (payload?.frame) {
          writeSse(res, { type: 'frame', frame: payload.frame });
        }

        if (includeStatus) {
          statusCountdown += frameIntervalMs;
          if (statusCountdown >= statusIntervalMs) {
            statusCountdown = 0;
            const statusPayload = await proxyBrowserAgentRequest('/status', {
              method: 'GET',
              signal: abortController.signal,
            });
            writeSse(res, { type: 'status', status: statusPayload.status || null });
          }
        }

        await waitFor(frameIntervalMs, abortController.signal);
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        writeSse(res, { type: 'error', error: message });
        await waitFor(Math.max(frameIntervalMs, 400), abortController.signal).catch(() => { });
      }
    }

    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  if (req.method === 'POST' && isMediaUploadPath(pathname)) {
    try {
      const maxLegacyJsonBytes = Math.min(
        Math.max(config.media.maxFileBytes * 2, 2 * 1024 * 1024),
        64 * 1024 * 1024
      );
      const body = await readJsonBody(req, maxLegacyJsonBytes);
      const uploaded = await mediaStore.saveBase64({
        fileName: body.fileName,
        mimeType: body.mimeType,
        dataBase64: body.dataBase64,
        conversationId: body.conversationId,
      });

      sendJson(res, 200, {
        ok: true,
        attachment: {
          name: uploaded.name,
          type: uploaded.mimeType,
          size: uploaded.size,
          url: uploaded.urlPath,
          stored: true,
          storageKey: uploaded.storageKey,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'POST' && isMediaUploadBinaryPath(pathname)) {
    try {
      const headerFileName = Array.isArray(req.headers['x-file-name'])
        ? req.headers['x-file-name'][0]
        : req.headers['x-file-name'];
      const headerConversationId = Array.isArray(req.headers['x-conversation-id'])
        ? req.headers['x-conversation-id'][0]
        : req.headers['x-conversation-id'];
      const queryFileName = requestUrl.searchParams.get('fileName') || '';
      const rawName = String(headerFileName || queryFileName || 'attachment').trim();
      const fileName = safeDecodeURIComponent(rawName);
      const contentTypeHeader = Array.isArray(req.headers['content-type'])
        ? req.headers['content-type'][0]
        : req.headers['content-type'];
      const mimeType = String(contentTypeHeader || requestUrl.searchParams.get('mimeType') || 'application/octet-stream')
        .split(';', 1)[0]
        .trim();
      const conversationId = String(
        headerConversationId
        || requestUrl.searchParams.get('conversationId')
        || ''
      ).trim();

      const uploaded = await mediaStore.saveStream({
        fileName,
        mimeType,
        stream: req,
        conversationId,
      });

      sendJson(res, 200, {
        ok: true,
        attachment: {
          name: uploaded.name,
          type: uploaded.mimeType,
          size: uploaded.size,
          url: uploaded.urlPath,
          stored: true,
          storageKey: uploaded.storageKey,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { ok: false, error: message });
    }
    return;
  }

  if (req.method === 'POST' && isChatPath(pathname)) {
    const abortController = new AbortController();
    bindAbortOnDisconnect(req, res, abortController);

    try {
      const body = await readJsonBody(req);
      const message = String(body.message || '').trim();
      const conversationId = body.conversationId;
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];

      if (!message && attachments.length === 0) {
        sendJson(res, 400, { ok: false, error: 'Missing message or attachments.' });
        return;
      }

      fireAndForget(logger.log({
        level: 'info',
        component: 'orchestrator',
        event: 'chat_request',
        message: 'Received chat request.',
        data: {
          conversationId: conversationId || null,
          messageLength: message.length,
          attachmentCount: attachments.length,
          streaming: false,
        },
      }));

      const result = await orchestrator.handleMessage({
        message,
        conversationId,
        attachments,
        signal: abortController.signal,
      });

      fireAndForget(logger.log({
        level: 'info',
        component: 'orchestrator',
        event: 'chat_response',
        message: 'Chat response generated.',
        data: {
          conversationId: result.conversationId,
          route: result.meta?.route,
          execution: result.meta?.execution,
          agentCalls: Array.isArray(result.meta?.agentCalls) ? result.meta.agentCalls.length : 0,
        },
      }));

      sendJson(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fireAndForget(logger.log({
        level: 'error',
        component: 'orchestrator',
        event: 'chat_error',
        message,
      }));
      sendJson(res, 500, { ok: false, error: message });
    }

    return;
  }

  if (req.method === 'POST' && isChatStreamPath(pathname)) {
    const abortController = new AbortController();
    bindAbortOnDisconnect(req, res, abortController);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      const body = await readJsonBody(req);
      const message = String(body.message || '').trim();
      const conversationId = body.conversationId;
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];

      if (!message && attachments.length === 0) {
        writeSse(res, { type: 'error', error: 'Missing message or attachments.' });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      fireAndForget(logger.log({
        level: 'info',
        component: 'orchestrator',
        event: 'chat_request',
        message: 'Received chat stream request.',
        data: {
          conversationId: conversationId || null,
          messageLength: message.length,
          attachmentCount: attachments.length,
          streaming: true,
        },
      }));

      writeSse(res, { type: 'start' });

      const result = await orchestrator.handleMessage({
        message,
        conversationId,
        attachments,
        signal: abortController.signal,
        onChunk: async (text) => {
          writeSse(res, { type: 'chunk', text });
        },
        onAgentStart: async (callInfo) => {
          writeSse(res, { type: 'agent_start', call: callInfo });
        },
        onAgentResult: async (callInfo, resultPayload) => {
          writeSse(res, { type: 'agent_result', call: callInfo, result: resultPayload });
        },
      });

      fireAndForget(logger.log({
        level: 'info',
        component: 'orchestrator',
        event: 'chat_response',
        message: 'Chat stream response completed.',
        data: {
          conversationId: result.conversationId,
          route: result.meta?.route,
          execution: result.meta?.execution,
          agentCalls: Array.isArray(result.meta?.agentCalls) ? result.meta.agentCalls.length : 0,
          streaming: true,
        },
      }));

      writeSse(res, {
        type: 'done',
        conversationId: result.conversationId,
        content: result.content,
        attachments: Array.isArray(result.attachments) ? result.attachments : [],
        meta: result.meta,
      });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      fireAndForget(logger.log({
        level: 'error',
        component: 'orchestrator',
        event: 'chat_error',
        message,
      }));
      writeSse(res, { type: 'error', error: message });
      res.write('data: [DONE]\n\n');
      res.end();
    }

    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(
      `Port ${config.server.host}:${config.server.port} is already in use. `
      + 'Stop the running process or run `npm run dev:ports:free` from the workspace root.'
    );
    process.exit(1);
    return;
  }

  console.error('Server error:', error);
  process.exit(1);
});

server.listen(config.server.port, config.server.host, () => {
  const runtime = orchestrator.getRuntimeSettings();

  const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    yellow: '\x1b[33m',
  };

  const termOn = runtime.tools.terminal.enabled ? `${c.green}ON${c.reset}` : `${c.dim}OFF${c.reset}`;
  const fsOn = runtime.tools.fs.enabled ? `${c.green}ON${c.reset}` : `${c.dim}OFF${c.reset}`;

  console.log('\n' + c.dim + '─'.repeat(60) + c.reset + '\n');
  console.log(`${c.bold}${c.green}🚀 Orchestrator Booted Successfully${c.reset}`);
  console.log(`${c.bold}${c.blue}🔌 Listening on:${c.reset}  http://${config.server.host}:${config.server.port}`);

  console.log(`\n${c.bold}${c.cyan}🤖 AI Models & Agents${c.reset}`);
  console.log(`  ${c.magenta}Orchestrator:${c.reset}  ${runtime.orchestrator.model} ${c.dim}(think: ${runtime.orchestrator.thinkingBudget}, web: ${runtime.orchestrator.webResearch})${c.reset}`);
  console.log(`  ${c.magenta}Browser:${c.reset}       ${runtime.agents.browser.model} ${c.dim}(think: ${runtime.agents.browser.thinkingBudget})${c.reset}`);
  console.log(`  ${c.magenta}Image:${c.reset}         ${runtime.agents.image.model}`);
  console.log(`  ${c.magenta}TTS:${c.reset}           ${runtime.agents.tts.model} ${c.dim}(voice: ${runtime.agents.tts.voice})${c.reset}`);

  console.log(`\n${c.bold}${c.yellow}🛠️  Tools & Capabilities${c.reset}`);
  console.log(`  ${c.bold}Terminal:${c.reset}      ${termOn} ${c.dim}[${runtime.tools.terminal.shell} | ${runtime.tools.terminal.cwd} | ${runtime.tools.terminal.timeoutMs}ms]${c.reset}`);
  console.log(`  ${c.bold}FileSystem:${c.reset}    ${fsOn}`);

  console.log(`\n  ${c.dim}Runtime & Tools${c.reset}`);
  console.log('\n' + c.dim + '─'.repeat(60) + c.reset + '\n');
});
