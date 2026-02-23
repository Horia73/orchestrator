import {
  loadAvailableModels,
  loadLogs,
  loadRuntimeSettings,
  loadUsageSummary,
  loadUsageEvents,
  saveRuntimeSettings,
} from '../services/api.js';

const THINKING_LEVEL_PRESETS = [
  {
    label: 'Minimal',
    level: 'minimal',
    description: 'Fastest responses with light reasoning.',
  },
  {
    label: 'Low',
    level: 'low',
    description: 'Balanced speed and depth.',
  },
  {
    label: 'Medium',
    level: 'medium',
    description: 'Stronger reasoning for harder prompts.',
  },
  {
    label: 'High',
    level: 'high',
    description: 'Deepest reasoning, slowest option.',
  },
];

const MODEL_SEARCH_DEBOUNCE_MS = 260;
const GEMINI_PRICING_SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing';

const GEMINI_3_PRICING_RULES = [
  {
    key: 'gemini-3.1-pro-preview-customtools',
    label: 'Gemini 3.1 Pro Preview (custom tools)',
    inputPer1M: 2.0,
    outputPer1M: 12.0,
    note: 'For prompts over 200K input tokens: input 4.00 and output 18.00 USD / 1M tokens.',
    match: (id) => id.startsWith('gemini-3.1-pro-preview-customtools'),
  },
  {
    key: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    inputPer1M: 2.0,
    outputPer1M: 12.0,
    note: 'For prompts over 200K input tokens: input 4.00 and output 18.00 USD / 1M tokens.',
    match: (id) => id.startsWith('gemini-3.1-pro-preview'),
  },
  {
    key: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro Preview',
    inputPer1M: 2.0,
    outputPer1M: 12.0,
    note: 'For prompts over 200K input tokens: input 4.00 and output 18.00 USD / 1M tokens.',
    match: (id) => id.startsWith('gemini-3-pro-preview'),
  },
  {
    key: 'gemini-3-pro-image-preview',
    label: 'Gemini 3 Pro Image Preview',
    inputPer1M: 2.0,
    outputPer1M: 12.0,
    note: 'Image output has separate pricing on the official page.',
    match: (id) => id.startsWith('gemini-3-pro-image-preview'),
  },
  {
    key: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash Preview',
    inputPer1M: 0.5,
    outputPer1M: 3.0,
    note: '',
    match: (id) => id.startsWith('gemini-3-flash-preview'),
  },
];

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeModelId(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

function normalizeModelEntry(model) {
  if (!model || typeof model !== 'object') return null;
  const id = normalizeModelId(model.id || model.name || '');
  if (!id) return null;
  return {
    ...model,
    id,
    name: model.name || id,
    displayName: model.displayName || id,
    description: model.description || '',
  };
}

function parseModelDateHint(modelId) {
  const id = normalizeModelId(modelId).toLowerCase();
  const fullDate = id.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (fullDate) {
    return Number(`${fullDate[1]}${fullDate[2]}${fullDate[3]}`);
  }

  const shortDate = id.match(/(?:^|[^\d])(\d{2})-(\d{2})(?:$|[^\d])/);
  if (!shortDate) return 0;

  const month = Number(shortDate[1]);
  const day = Number(shortDate[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return 0;
  }

  const now = new Date();
  let year = now.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const nowMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (candidate - nowMs > 35 * 24 * 60 * 60 * 1000) {
    year -= 1;
  }

  return Number(`${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`);
}

function parseModelVersionHint(modelId) {
  const id = normalizeModelId(modelId).toLowerCase();
  const match = id.match(/gemini-(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  const major = Number(match[1]) || 0;
  const minor = Number(match[2]) || 0;
  return major * 100 + minor;
}

function compareModelsByRecency(a, b) {
  const aId = normalizeModelId(a?.id || a?.name || '');
  const bId = normalizeModelId(b?.id || b?.name || '');

  const versionDelta = parseModelVersionHint(bId) - parseModelVersionHint(aId);
  if (versionDelta !== 0) return versionDelta;

  const dateDelta = parseModelDateHint(bId) - parseModelDateHint(aId);
  if (dateDelta !== 0) return dateDelta;

  return bId.localeCompare(aId);
}

function mergeModelLists(baseModels = [], patchModels = []) {
  const map = new Map();

  for (const source of [baseModels, patchModels]) {
    for (const model of source) {
      const normalized = normalizeModelEntry(model);
      if (!normalized) continue;
      map.set(normalized.id, normalized);
    }
  }

  return Array.from(map.values()).sort(compareModelsByRecency);
}

function filterModelsByAction(models = [], action = '') {
  const normalizedAction = String(action || '').trim();
  if (!normalizedAction || normalizedAction.toLowerCase() === 'all') return mergeModelLists(models);

  return mergeModelLists(models).filter((model) => {
    const actions = Array.isArray(model?.supportedActions) ? model.supportedActions : [];
    if (actions.length === 0) return true;
    return actions.includes(normalizedAction);
  });
}

function toModelOptions(models, selectedModel) {
  const selected = normalizeModelId(selectedModel);
  const normalized = mergeModelLists(models);
  const map = new Map(normalized.map((model) => [model.id, model]));

  if (selected && !map.has(selected)) {
    map.set(selected, {
      id: selected,
      name: selected,
      displayName: selected,
      description: '',
      inputTokenLimit: null,
      outputTokenLimit: null,
      thinking: null,
    });
  }

  const options = Array.from(map.values()).sort(compareModelsByRecency);

  return options;
}

function findModelMeta(models, modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return null;
  return (models || []).find((model) => normalizeModelId(model.id) === normalized) || null;
}

function resolveGemini3Pricing(modelId) {
  const normalized = normalizeModelId(modelId).toLowerCase();
  if (!normalized.startsWith('gemini-3')) return null;

  const match = GEMINI_3_PRICING_RULES.find((rule) => rule.match(normalized));
  if (!match) return null;

  return {
    ...match,
    modelId: normalizeModelId(modelId),
    sourceUrl: GEMINI_PRICING_SOURCE_URL,
  };
}

function collectGemini3PricingRows(models = [], selectedModels = []) {
  const catalog = new Map();

  for (const model of models) {
    const normalized = normalizeModelEntry(model);
    if (!normalized) continue;

    const pricing = resolveGemini3Pricing(normalized.id);
    if (!pricing) continue;

    catalog.set(normalized.id, {
      id: normalized.id,
      displayName: normalized.displayName || normalized.id,
      inputPer1M: pricing.inputPer1M,
      outputPer1M: pricing.outputPer1M,
      note: pricing.note,
      sourceUrl: pricing.sourceUrl,
      ruleLabel: pricing.label,
    });
  }

  for (const rawSelected of selectedModels) {
    const selected = normalizeModelId(rawSelected);
    if (!selected || catalog.has(selected)) continue;

    const pricing = resolveGemini3Pricing(selected);
    if (!pricing) continue;

    catalog.set(selected, {
      id: selected,
      displayName: selected,
      inputPer1M: pricing.inputPer1M,
      outputPer1M: pricing.outputPer1M,
      note: pricing.note,
      sourceUrl: pricing.sourceUrl,
      ruleLabel: pricing.label,
    });
  }

  return Array.from(catalog.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function buildGemini3PricingPatch(models = [], selectedModels = []) {
  const rows = collectGemini3PricingRows(models, selectedModels);
  const patch = {};

  for (const row of rows) {
    patch[row.id] = {
      inputPer1M: row.inputPer1M,
      outputPer1M: row.outputPer1M,
      currency: 'USD',
    };
  }

  return patch;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function formatUsd(value) {
  const numeric = Number(value) || 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6,
  }).format(numeric);
}

function normalizeThinkingLevel(rawLevel, fallback = 'minimal') {
  const normalized = String(rawLevel || '').trim().toLowerCase();
  if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return fallback;
}

function getThinkingLevelPreset(level) {
  const normalizedLevel = normalizeThinkingLevel(level, 'minimal');
  return THINKING_LEVEL_PRESETS.find((preset) => preset.level === normalizedLevel) || THINKING_LEVEL_PRESETS[0];
}

function emptyDraft() {
  return {
    orchestratorModel: '',
    orchestratorThinkingLevel: THINKING_LEVEL_PRESETS[0].level,
    codingModel: '',
    browserModel: '',
    browserThinkingLevel: THINKING_LEVEL_PRESETS[0].level,
    imageModel: '',
    ttsModel: '',
  };
}

function createModelLookupState(action = 'generateContent') {
  return {
    action,
    query: '',
    options: [],
    loading: false,
    requestSeq: 0,
    timerId: null,
  };
}

export function createSettingsPanel() {
  const container = document.createElement('div');
  container.className = 'settings-layer';

  const state = {
    open: false,
    activeTab: 'models',
    loading: false,
    saving: false,
    error: '',
    statusText: '',
    settings: null,
    draft: emptyDraft(),
    models: [],
    modelLookups: {
      orchestrator: createModelLookupState('all'),
      coding: createModelLookupState('all'),
      browser: createModelLookupState('all'),
      image: createModelLookupState('all'),
      tts: createModelLookupState('all'),
    },
    usage: null,
    usageLoading: false,
    usageComponentFilter: 'all',
    logs: [],
    logsLoading: false,
    logComponent: 'orchestrator',
    logDate: todayDate(),
    logLimit: 200,
    logSubTab: 'events',
    usageEvents: [],
    usageEventsLoading: false,
    expandedLogIds: new Set(),
    initialized: false,
    openModelDropdown: null,
    autoSaveTimerId: null,
    lastSavedDraftKey: '',
    lastSavedAt: '',
  };

  function clearModelLookupTimers() {
    Object.values(state.modelLookups).forEach((lookup) => {
      if (lookup.timerId) {
        window.clearTimeout(lookup.timerId);
        lookup.timerId = null;
      }
    });
  }

  function clearAutoSaveTimer() {
    if (state.autoSaveTimerId) {
      window.clearTimeout(state.autoSaveTimerId);
      state.autoSaveTimerId = null;
    }
  }

  function currentDraftKey() {
    return JSON.stringify({
      orchestratorModel: normalizeModelId(state.draft.orchestratorModel),
      orchestratorThinkingLevel: normalizeThinkingLevel(state.draft.orchestratorThinkingLevel, THINKING_LEVEL_PRESETS[0].level),
      codingModel: normalizeModelId(state.draft.codingModel),
      browserModel: normalizeModelId(state.draft.browserModel),
      browserThinkingLevel: normalizeThinkingLevel(state.draft.browserThinkingLevel, THINKING_LEVEL_PRESETS[0].level),
      imageModel: normalizeModelId(state.draft.imageModel),
      ttsModel: normalizeModelId(state.draft.ttsModel),
    });
  }

  function scheduleAutoSave() {
    if (!state.initialized || state.loading) return;

    const nextKey = currentDraftKey();
    if (nextKey === state.lastSavedDraftKey) return;

    clearAutoSaveTimer();
    state.autoSaveTimerId = window.setTimeout(() => {
      state.autoSaveTimerId = null;
      void saveDraft();
    }, 460);
  }

  function applySettingsToDraft(settings) {
    const draft = emptyDraft();
    draft.orchestratorModel = normalizeModelId(settings?.orchestrator?.model || '');
    draft.orchestratorThinkingLevel = normalizeThinkingLevel(
      settings?.orchestrator?.thinkingLevel,
      THINKING_LEVEL_PRESETS[0].level
    );
    draft.codingModel = normalizeModelId(settings?.codingAgent?.model || '');
    draft.browserModel = normalizeModelId(settings?.agents?.browser?.model || '');
    draft.browserThinkingLevel = normalizeThinkingLevel(
      settings?.agents?.browser?.thinkingLevel,
      THINKING_LEVEL_PRESETS[0].level
    );
    draft.imageModel = normalizeModelId(settings?.agents?.image?.model || '');
    draft.ttsModel = normalizeModelId(settings?.agents?.tts?.model || '');

    state.draft = draft;
    state.lastSavedDraftKey = currentDraftKey();
  }

  function seedModelLookups() {
    const baseOptions = state.models;

    const orchestratorLookup = state.modelLookups.orchestrator;
    orchestratorLookup.query = '';
    orchestratorLookup.options = toModelOptions(
      filterModelsByAction(baseOptions, orchestratorLookup.action),
      state.draft.orchestratorModel
    );

    const codingLookup = state.modelLookups.coding;
    codingLookup.query = '';
    codingLookup.options = toModelOptions(
      filterModelsByAction(baseOptions, codingLookup.action),
      state.draft.codingModel
    );

    const browserLookup = state.modelLookups.browser;
    browserLookup.query = '';
    browserLookup.options = toModelOptions(
      filterModelsByAction(baseOptions, browserLookup.action),
      state.draft.browserModel
    );

    const imageLookup = state.modelLookups.image;
    imageLookup.query = '';
    imageLookup.options = toModelOptions(
      filterModelsByAction(baseOptions, imageLookup.action),
      state.draft.imageModel
    );

    const ttsLookup = state.modelLookups.tts;
    ttsLookup.query = '';
    ttsLookup.options = toModelOptions(
      filterModelsByAction(baseOptions, ttsLookup.action),
      state.draft.ttsModel
    );
  }

  async function refreshSettingsAndModels() {
    state.loading = true;
    state.error = '';
    render();

    try {
      const [settings, models] = await Promise.all([
        loadRuntimeSettings(),
        loadAvailableModels('', 'all'),
      ]);

      state.settings = settings;
      state.models = mergeModelLists([], Array.isArray(models) ? models : []);
      applySettingsToDraft(settings || {});
      seedModelLookups();
      state.initialized = true;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function refreshUsage() {
    state.usageLoading = true;
    state.error = '';
    render();

    try {
      state.usage = await loadUsageSummary(7);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.usageLoading = false;
      render();
    }
  }

  async function refreshLogs() {
    state.logsLoading = true;
    state.error = '';
    render();

    try {
      const payload = await loadLogs(state.logComponent, state.logDate, state.logLimit);
      state.logs = (payload.logs || []).reverse();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.logsLoading = false;
      render();
    }
  }

  async function refreshUsageEvents() {
    state.usageEventsLoading = true;
    state.error = '';
    render();

    try {
      const payload = await loadUsageEvents(state.logDate, state.logLimit);
      state.usageEvents = (payload.events || []).reverse();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.usageEventsLoading = false;
      render();
    }
  }

  async function refreshLookupOptions(field, query = '') {
    const lookup = state.modelLookups[field];
    if (!lookup) return;

    lookup.loading = true;
    lookup.requestSeq += 1;
    const currentSeq = lookup.requestSeq;
    state.error = '';
    render();

    try {
      const models = await loadAvailableModels(query, lookup.action || 'generateContent');
      if (lookup.requestSeq !== currentSeq) return;

      const normalizedModels = Array.isArray(models) ? models : [];
      state.models = mergeModelLists(state.models, normalizedModels);

      const selectedModel = field === 'orchestrator'
        ? state.draft.orchestratorModel
        : field === 'coding'
          ? state.draft.codingModel
          : field === 'browser'
            ? state.draft.browserModel
            : field === 'image'
              ? state.draft.imageModel
              : state.draft.ttsModel;
      lookup.options = toModelOptions(normalizedModels, selectedModel);
    } catch (error) {
      if (lookup.requestSeq === currentSeq) {
        state.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (lookup.requestSeq === currentSeq) {
        lookup.loading = false;
        render();
      }
    }
  }

  function scheduleLookupSearch(field, query) {
    const lookup = state.modelLookups[field];
    if (!lookup) return;

    lookup.query = String(query || '');
    if (lookup.timerId) {
      window.clearTimeout(lookup.timerId);
      lookup.timerId = null;
    }

    lookup.timerId = window.setTimeout(() => {
      lookup.timerId = null;
      void refreshLookupOptions(field, lookup.query.trim());
    }, MODEL_SEARCH_DEBOUNCE_MS);
  }

  async function initializeOpenPanel() {
    if (!state.initialized) {
      await refreshSettingsAndModels();
    }
    await Promise.all([refreshUsage(), refreshLogs(), refreshUsageEvents()]);
  }

  function openPanel() {
    state.open = true;
    state.statusText = 'Auto-save enabled.';
    state.error = '';
    state.loading = !state.initialized;
    window.location.hash = 'settings';
    render();
    void initializeOpenPanel();
  }

  function closePanel() {
    clearModelLookupTimers();
    if (state.autoSaveTimerId) {
      clearAutoSaveTimer();
      void saveDraft();
    }
    state.open = false;
    state.openModelDropdown = null;
    state.statusText = '';
    state.error = '';
    if (window.location.hash === '#settings') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    render();
  }

  async function saveDraft() {
    if (state.saving) return;
    const draftKey = currentDraftKey();
    if (draftKey === state.lastSavedDraftKey) return;

    state.saving = true;
    state.error = '';
    state.statusText = 'Saving...';
    render();

    const pricingPatch = buildGemini3PricingPatch(state.models, [
      state.draft.orchestratorModel,
      state.draft.codingModel,
      state.draft.browserModel,
      state.draft.imageModel,
      state.draft.ttsModel,
    ]);

    const patch = {
      orchestrator: {
        model: normalizeModelId(state.draft.orchestratorModel),
        thinkingLevel: normalizeThinkingLevel(state.draft.orchestratorThinkingLevel, THINKING_LEVEL_PRESETS[0].level),
      },
      codingAgent: {
        model: normalizeModelId(state.draft.codingModel),
      },
      agents: {
        browser: {
          model: normalizeModelId(state.draft.browserModel),
          thinkingLevel: normalizeThinkingLevel(state.draft.browserThinkingLevel, THINKING_LEVEL_PRESETS[0].level),
        },
        image: {
          model: normalizeModelId(state.draft.imageModel),
        },
        tts: {
          model: normalizeModelId(state.draft.ttsModel),
        },
      },
      ...(Object.keys(pricingPatch).length > 0 ? { pricing: pricingPatch } : {}),
    };

    try {
      const updated = await saveRuntimeSettings(patch);
      state.settings = updated;
      applySettingsToDraft(updated || {});
      seedModelLookups();
      state.lastSavedDraftKey = currentDraftKey();
      state.lastSavedAt = new Date().toISOString();
      const savedTime = new Date(state.lastSavedAt).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
      });
      state.statusText = `Saved at ${savedTime}`;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.statusText = '';
    } finally {
      state.saving = false;
      render();
    }
  }

  function renderUsageTab() {
    if (state.usageLoading) {
      return '<div class="settings-loading">Loading usage...</div>';
    }

    const usage = state.usage;
    if (!usage) {
      return '<div class="settings-empty">No usage data yet.</div>';
    }

    const components = Array.isArray(usage.byComponent) ? usage.byComponent : [];
    const visibleComponents = state.usageComponentFilter === 'all'
      ? components
      : components.filter((component) => component.component === state.usageComponentFilter);

    return `
      <div class="settings-actions-row">
        <div class="settings-toggle-group">
          <button class="settings-toggle-btn ${state.usageComponentFilter === 'all' ? 'active' : ''}" data-usage-component="all">All</button>
          <button class="settings-toggle-btn ${state.usageComponentFilter === 'orchestrator' ? 'active' : ''}" data-usage-component="orchestrator">Orchestrator</button>
          <button class="settings-toggle-btn ${state.usageComponentFilter === 'coding-agent' ? 'active' : ''}" data-usage-component="coding-agent">Coding Agent</button>
          <button class="settings-toggle-btn ${state.usageComponentFilter === 'browser-agent' ? 'active' : ''}" data-usage-component="browser-agent">Browser Agent</button>
          <button class="settings-toggle-btn ${state.usageComponentFilter === 'terminal-agent' ? 'active' : ''}" data-usage-component="terminal-agent">Terminal Agent</button>
          <button class="settings-toggle-btn ${state.usageComponentFilter === 'image-agent' ? 'active' : ''}" data-usage-component="image-agent">Image Agent</button>
          <button class="settings-toggle-btn ${state.usageComponentFilter === 'tts-agent' ? 'active' : ''}" data-usage-component="tts-agent">TTS Agent</button>
        </div>
        <button class="settings-secondary-btn" id="settings-refresh-usage">Refresh</button>
        <div class="settings-meta">Last 7 days</div>
      </div>
      <div class="usage-summary-grid">
        <div class="usage-card">
          <div class="usage-card-title">Total Tokens</div>
          <div class="usage-card-value">${formatNumber(usage.totals?.totalTokens)}</div>
          <div class="usage-card-sub">Prompt ${formatNumber(usage.totals?.promptTokens)} / Output ${formatNumber((usage.totals?.outputTokens || 0) + (usage.totals?.thoughtsTokens || 0))}</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-title">Estimated Cost</div>
          <div class="usage-card-value">${formatUsd(usage.totals?.estimatedCostUsd)}</div>
          <div class="usage-card-sub">Priced requests: ${formatNumber(usage.totals?.pricedRequests || 0)}</div>
        </div>
      </div>
      <div class="usage-component-list">
        ${visibleComponents.map((component) => `
          <div class="usage-component-card">
            <div class="usage-component-head">
              <strong>${escapeHtml(component.component)}</strong>
              <span>${formatUsd(component.totals?.estimatedCostUsd)}</span>
            </div>
            <div class="usage-component-meta">
              ${formatNumber(component.totals?.totalTokens)} tokens • ${formatNumber(component.totals?.requests)} req
            </div>
            <div class="usage-model-list">
              ${(component.byModel || []).slice(0, 8).map((entry) => `
                <div class="usage-model-item">
                  <span>${escapeHtml(entry.model)}</span>
                  <span>${formatNumber(entry.totals?.totalTokens)} tk</span>
                </div>
              `).join('') || '<div class="settings-empty-inline">No model breakdown yet.</div>'}
            </div>
          </div>
        `).join('') || '<div class="settings-empty">No usage for selected component.</div>'}
      </div>
    `;
  }

  function formatLocalTime(isoTimestamp) {
    if (!isoTimestamp) return '';
    try {
      const d = new Date(isoTimestamp);
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return isoTimestamp;
    }
  }

  function formatLocalDateTime(isoTimestamp) {
    if (!isoTimestamp) return '';
    try {
      const d = new Date(isoTimestamp);
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      return isoTimestamp;
    }
  }

  function levelBadgeClass(level) {
    if (level === 'error') return 'log-badge-error';
    if (level === 'warn') return 'log-badge-warn';
    return 'log-badge-info';
  }

  function eventIcon(event) {
    if (event === 'chat_request') return '\ud83d\udcac';
    if (event === 'chat_response') return '\u2705';
    if (event === 'chat_error') return '\u274c';
    if (event === 'settings_updated' || event === 'settings_auto_reloaded') return '\u2699\ufe0f';
    if (event === 'startup') return '\ud83d\ude80';
    if (event === 'thinking_config_fallback') return '\u26a0\ufe0f';
    return '\ud83d\udccb';
  }

  function renderLogEntry(entry, index) {
    const ts = entry?.timestamp || '';
    const level = entry?.level || 'info';
    const event = entry?.event || 'event';
    const message = entry?.message || '';
    const data = entry?.data;
    const entryId = `log-${index}`;
    const isExpanded = state.expandedLogIds.has(entryId);

    const dataHtml = data && typeof data === 'object' && Object.keys(data).length > 0
      ? `<div class="log-entry-data">
          ${Object.entries(data).map(([key, value]) => {
        const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        return `<div class="log-data-row">
              <span class="log-data-key">${escapeHtml(key)}</span>
              <span class="log-data-value">${escapeHtml(displayValue)}</span>
            </div>`;
      }).join('')}
        </div>`
      : '';

    return `
      <div class="log-entry ${isExpanded ? 'expanded' : ''} ${level === 'error' ? 'log-entry-error' : ''}" data-log-entry-id="${entryId}">
        <div class="log-entry-header" data-log-toggle="${entryId}">
          <span class="log-entry-icon">${eventIcon(event)}</span>
          <span class="log-entry-time">${escapeHtml(formatLocalTime(ts))}</span>
          <span class="log-badge ${levelBadgeClass(level)}">${escapeHtml(level)}</span>
          <span class="log-badge log-badge-event">${escapeHtml(event)}</span>
          <span class="log-entry-message">${escapeHtml(message)}</span>
          <span class="log-entry-chevron">${isExpanded ? '\u25be' : '\u25b8'}</span>
        </div>
        ${isExpanded ? `
          <div class="log-entry-details">
            <div class="log-detail-row">
              <span class="log-data-key">Timestamp</span>
              <span class="log-data-value">${escapeHtml(formatLocalDateTime(ts))}</span>
            </div>
            <div class="log-detail-row">
              <span class="log-data-key">Component</span>
              <span class="log-data-value">${escapeHtml(entry?.component || '')}</span>
            </div>
            ${dataHtml}
          </div>
        ` : ''}
      </div>
    `;
  }

  function renderUsageEventEntry(event, index) {
    const ts = event?.timestamp || '';
    const model = event?.model || 'unknown';
    const promptTokens = Number(event?.promptTokens) || 0;
    const outputTokens = Number(event?.outputTokens) || 0;
    const thoughtsTokens = Number(event?.thoughtsTokens) || 0;
    const totalTokens = Number(event?.totalTokens) || 0;
    const cost = event?.estimatedCostUsd;
    const component = event?.component || '';
    const entryId = `usage-${index}`;
    const isExpanded = state.expandedLogIds.has(entryId);

    const costDisplay = cost !== null && cost !== undefined
      ? formatUsd(cost)
      : '\u2014';

    return `
      <div class="log-entry usage-event-entry ${isExpanded ? 'expanded' : ''}" data-log-entry-id="${entryId}">
        <div class="log-entry-header" data-log-toggle="${entryId}">
          <span class="log-entry-icon">\u26a1</span>
          <span class="log-entry-time">${escapeHtml(formatLocalTime(ts))}</span>
          <span class="log-badge log-badge-model">${escapeHtml(model)}</span>
          <span class="usage-event-tokens">${formatNumber(totalTokens)} tk</span>
          <span class="usage-event-cost ${cost > 0 ? 'has-cost' : ''}">${costDisplay}</span>
          <span class="log-entry-chevron">${isExpanded ? '\u25be' : '\u25b8'}</span>
        </div>
        ${isExpanded ? `
          <div class="log-entry-details">
            <div class="usage-detail-grid">
              <div class="usage-detail-card">
                <div class="usage-detail-label">Prompt Tokens</div>
                <div class="usage-detail-value">${formatNumber(promptTokens)}</div>
              </div>
              <div class="usage-detail-card">
                <div class="usage-detail-label">Output Tokens</div>
                <div class="usage-detail-value">${formatNumber(outputTokens)}</div>
              </div>
              <div class="usage-detail-card">
                <div class="usage-detail-label">Thinking Tokens</div>
                <div class="usage-detail-value">${formatNumber(thoughtsTokens)}</div>
              </div>
              <div class="usage-detail-card">
                <div class="usage-detail-label">Estimated Cost</div>
                <div class="usage-detail-value accent">${costDisplay}</div>
              </div>
            </div>
            <div class="log-detail-row">
              <span class="log-data-key">Model</span>
              <span class="log-data-value">${escapeHtml(model)}</span>
            </div>
            <div class="log-detail-row">
              <span class="log-data-key">Component</span>
              <span class="log-data-value">${escapeHtml(component)}</span>
            </div>
            <div class="log-detail-row">
              <span class="log-data-key">Timestamp</span>
              <span class="log-data-value">${escapeHtml(formatLocalDateTime(ts))}</span>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  function renderLogsTab() {
    const isEventsTab = state.logSubTab === 'events';
    const isRawTab = state.logSubTab === 'raw';

    let entriesHtml = '';
    let emptyMsg = '';
    let isLoading = false;

    if (isEventsTab) {
      isLoading = state.usageEventsLoading;
      const events = state.usageEvents || [];
      if (events.length === 0 && !isLoading) {
        emptyMsg = 'No API requests found for this date.';
      } else {
        entriesHtml = events.map((evt, i) => renderUsageEventEntry(evt, i)).join('');
      }
    } else {
      isLoading = state.logsLoading;
      const logs = state.logs || [];
      if (logs.length === 0 && !isLoading) {
        emptyMsg = 'No logs for selected filter.';
      } else {
        entriesHtml = logs.map((entry, i) => renderLogEntry(entry, i)).join('');
      }
    }

    return `
      <div class="logs-header-bar">
        <div class="logs-sub-tabs">
          <button class="logs-sub-tab ${isEventsTab ? 'active' : ''}" data-log-subtab="events">
            \u26a1 API Requests
          </button>
          <button class="logs-sub-tab ${isRawTab ? 'active' : ''}" data-log-subtab="raw">
            \ud83d\udccb System Logs
          </button>
        </div>
        <div class="logs-controls">
          <input type="date" id="settings-log-date" value="${escapeHtml(state.logDate)}" />
          <button class="settings-secondary-btn" id="settings-refresh-logs">Refresh</button>
        </div>
      </div>

      ${isRawTab ? `
        <div class="settings-actions-row logs-toolbar">
          <div class="settings-toggle-group">
            <button class="settings-toggle-btn ${state.logComponent === 'orchestrator' ? 'active' : ''}" data-log-component="orchestrator">Orchestrator</button>
            <button class="settings-toggle-btn ${state.logComponent === 'coding-agent' ? 'active' : ''}" data-log-component="coding-agent">Coding</button>
            <button class="settings-toggle-btn ${state.logComponent === 'browser-agent' ? 'active' : ''}" data-log-component="browser-agent">Browser</button>
            <button class="settings-toggle-btn ${state.logComponent === 'terminal-agent' ? 'active' : ''}" data-log-component="terminal-agent">Terminal</button>
            <button class="settings-toggle-btn ${state.logComponent === 'image-agent' ? 'active' : ''}" data-log-component="image-agent">Image</button>
            <button class="settings-toggle-btn ${state.logComponent === 'tts-agent' ? 'active' : ''}" data-log-component="tts-agent">TTS</button>
          </div>
        </div>
      ` : ''}

      ${isLoading ? '<div class="settings-loading">Loading...</div>' : ''}
      ${emptyMsg ? `<div class="settings-empty">${escapeHtml(emptyMsg)}</div>` : ''}

      <div class="logs-entries-list">
        ${entriesHtml}
      </div>

      <div class="logs-footer">
        <span class="settings-meta">${isEventsTab
        ? `${(state.usageEvents || []).length} requests`
        : `${(state.logs || []).length} log entries`
      } \u2022 ${escapeHtml(state.logDate)}</span>
      </div>
    `;
  }

  function getModelOptionsForField(field, selectedModel) {
    const lookup = state.modelLookups[field];
    const selected = normalizeModelId(selectedModel);
    const source = toModelOptions(lookup?.options || [], selected);
    const query = String(lookup?.query || '').trim().toLowerCase();

    const filtered = !query
      ? source
      : source.filter((model) => {
        const id = String(model.id || '').toLowerCase();
        const name = String(model.displayName || '').toLowerCase();
        const description = String(model.description || '').toLowerCase();
        return id.includes(query) || name.includes(query) || description.includes(query);
      });

    if (selected) {
      const selectedEntry = source.find((model) => normalizeModelId(model.id) === selected);
      if (selectedEntry) {
        const withoutSelected = filtered.filter((model) => normalizeModelId(model.id) !== selected);
        return [selectedEntry, ...withoutSelected].slice(0, 240);
      }
    }

    return filtered.slice(0, 240);
  }

  function renderModelCombobox(field, selectedModel, lookup) {
    const open = state.openModelDropdown === field;
    const selectedId = normalizeModelId(selectedModel);
    const selectedMeta = findModelMeta(lookup.options, selectedId) || findModelMeta(state.models, selectedId);
    const selectedLabel = selectedMeta?.displayName || selectedId || 'Choose model';
    const options = getModelOptionsForField(field, selectedModel);

    const triggerId = field === 'orchestrator'
      ? 'settings-orchestrator-combo-trigger'
      : field === 'coding'
        ? 'settings-coding-combo-trigger'
        : field === 'browser'
          ? 'settings-browser-combo-trigger'
          : field === 'image'
            ? 'settings-image-combo-trigger'
            : 'settings-tts-combo-trigger';
    const searchId = field === 'orchestrator'
      ? 'settings-orchestrator-combo-search'
      : field === 'coding'
        ? 'settings-coding-combo-search'
        : field === 'browser'
          ? 'settings-browser-combo-search'
          : field === 'image'
            ? 'settings-image-combo-search'
            : 'settings-tts-combo-search';

    const placeholder = lookup.loading ? 'Searching models...' : 'Search in dropdown...';

    return `
      <div class="settings-combobox ${open ? 'open' : ''}" data-combo-field="${field}">
        <button type="button" id="${triggerId}" class="settings-combobox-trigger">
          <span class="settings-combobox-title">${escapeHtml(selectedLabel)}</span>
          <span class="settings-combobox-id">${escapeHtml(selectedId || 'No model selected')}</span>
        </button>
        ${open ? `
          <div class="settings-combobox-panel">
            <input
              type="search"
              id="${searchId}"
              value="${escapeHtml(lookup.query)}"
              placeholder="${placeholder}"
              autocomplete="off"
            />
            <div class="settings-combobox-list">
              ${options.length === 0
          ? '<div class="settings-combobox-empty">No models found.</div>'
          : options.map((model) => {
            const id = normalizeModelId(model.id);
            const label = model.displayName || id;
            const activeClass = id === selectedId ? 'active' : '';
            return `
                    <button
                      type="button"
                      class="settings-combobox-option ${activeClass}"
                      data-combo-option-field="${field}"
                      data-combo-option-value="${escapeHtml(id)}"
                    >
                      <span class="settings-combobox-option-title">${escapeHtml(label)}</span>
                      <span class="settings-combobox-option-id">${escapeHtml(id)}</span>
                    </button>
                  `;
          }).join('')}
            </div>
          </div>
        ` : ''
      }
      </div>
      `;
  }

  function renderThinkingChips(field, thinkingLevel) {
    const selectedLevel = getThinkingLevelPreset(thinkingLevel).level;
    return `
      <div class="settings-thinking-row">
        ${THINKING_LEVEL_PRESETS.map((preset) => `
          <button
            type="button"
            class="settings-thinking-chip ${preset.level === selectedLevel ? 'active' : ''}"
            data-thinking-field="${field}"
            data-thinking-value="${preset.level}"
          >
            ${preset.label}
          </button>
        `).join('')
      }
      </div>
      `;
  }

  function renderModelCard({
    field,
    title,
    description,
    selectedModel,
    thinkingLevel,
    lookup,
    officialPricing,
    modelMeta,
    showThinking = true,
    helperText = '',
  }) {
    const thinkingPreset = getThinkingLevelPreset(thinkingLevel);

    return `
      <section class="settings-model-card">
        <div class="settings-model-head">
          <h4>${escapeHtml(title)}</h4>
          <div class="settings-meta">${escapeHtml(description)}</div>
        </div>

        <label>
          <span>Model (newest to oldest)</span>
          ${renderModelCombobox(field, selectedModel, lookup)}
        </label>

        ${showThinking ? `
          <label>
            <span>Thinking</span>
            ${renderThinkingChips(field, thinkingLevel)}
          </label>

          <div class="settings-model-helper">
            ${escapeHtml(thinkingPreset.description)}
          </div>
        ` : `
          <div class="settings-model-helper">
            ${escapeHtml(helperText || 'Uses a specialized model via Gemini API.')}
          </div>
        `}

    <div class="settings-model-meta-grid">
      <div class="settings-meta">Input token limit: ${modelMeta?.inputTokenLimit ? formatNumber(modelMeta.inputTokenLimit) : 'n/a'}</div>
      <div class="settings-meta">Output token limit: ${modelMeta?.outputTokenLimit ? formatNumber(modelMeta.outputTokenLimit) : 'n/a'}</div>
      <div class="settings-meta">Thinking supported: ${modelMeta?.thinking ? 'yes' : 'unknown/no'}</div>
    </div>

        ${officialPricing ? `
          <div class="settings-model-pricing-pill is-active">
            <span>Auto pricing: ${officialPricing.inputPer1M} / ${officialPricing.outputPer1M} USD per 1M tokens</span>
            <a href="${escapeHtml(officialPricing.sourceUrl)}" target="_blank" rel="noreferrer">Official pricing link</a>
          </div>
          ${officialPricing?.note ? `<div class="settings-meta">${escapeHtml(officialPricing.note)}</div>` : ''}
        ` : ''
      }
      </section>
      `;
  }

  function renderModelsTab() {
    const orchestratorLookup = state.modelLookups.orchestrator;
    const codingLookup = state.modelLookups.coding;
    const browserLookup = state.modelLookups.browser;
    const imageLookup = state.modelLookups.image;
    const ttsLookup = state.modelLookups.tts;

    const orchestratorModelMeta = findModelMeta(state.models, state.draft.orchestratorModel)
      || findModelMeta(orchestratorLookup.options, state.draft.orchestratorModel);
    const codingModelMeta = findModelMeta(state.models, state.draft.codingModel)
      || findModelMeta(codingLookup.options, state.draft.codingModel);
    const browserModelMeta = findModelMeta(state.models, state.draft.browserModel)
      || findModelMeta(browserLookup.options, state.draft.browserModel);
    const imageModelMeta = findModelMeta(state.models, state.draft.imageModel)
      || findModelMeta(imageLookup.options, state.draft.imageModel);
    const ttsModelMeta = findModelMeta(state.models, state.draft.ttsModel)
      || findModelMeta(ttsLookup.options, state.draft.ttsModel);

    const orchestratorOfficialPricing = resolveGemini3Pricing(state.draft.orchestratorModel);
    const codingOfficialPricing = resolveGemini3Pricing(state.draft.codingModel);
    const browserOfficialPricing = resolveGemini3Pricing(state.draft.browserModel);
    const imageOfficialPricing = resolveGemini3Pricing(state.draft.imageModel);
    const ttsOfficialPricing = resolveGemini3Pricing(state.draft.ttsModel);

    return `
      <div class="settings-meta">${escapeHtml(state.statusText || 'Auto-save enabled.')}</div>
      <div class="settings-models-layout">
        ${renderModelCard({
      field: 'orchestrator',
      title: 'Orchestrator Model',
      description: 'Used for routing, planning, and final responses.',
      selectedModel: state.draft.orchestratorModel,
      thinkingLevel: state.draft.orchestratorThinkingLevel,
      lookup: orchestratorLookup,
      officialPricing: orchestratorOfficialPricing,
      modelMeta: orchestratorModelMeta,
    })}

        ${renderModelCard({
      field: 'coding',
      title: 'Coding Agent Model',
      description: 'Used for executing autonomous code refactoring and creation.',
      selectedModel: state.draft.codingModel,
      thinkingLevel: THINKING_LEVEL_PRESETS[0].level,
      lookup: codingLookup,
      officialPricing: codingOfficialPricing,
      modelMeta: codingModelMeta,
      showThinking: false,
    })}

        ${renderModelCard({
      field: 'browser',
      title: 'Browser Agent Model',
      description: 'Used by browser automation tasks.',
      selectedModel: state.draft.browserModel,
      thinkingLevel: state.draft.browserThinkingLevel,
      lookup: browserLookup,
      officialPricing: browserOfficialPricing,
      modelMeta: browserModelMeta,
    })}

        ${renderModelCard({
      field: 'image',
      title: 'Image Agent Model',
      description: 'Used for image generation (Nano Banana family compatible).',
      selectedModel: state.draft.imageModel,
      thinkingLevel: THINKING_LEVEL_PRESETS[0].level,
      lookup: imageLookup,
      officialPricing: imageOfficialPricing,
      modelMeta: imageModelMeta,
      showThinking: false,
      helperText: 'Uses a specialized image-generation model via Gemini API.',
    })}

        ${renderModelCard({
      field: 'tts',
      title: 'TTS Agent Model',
      description: 'Used for Gemini text-to-speech audio generation.',
      selectedModel: state.draft.ttsModel,
      thinkingLevel: THINKING_LEVEL_PRESETS[0].level,
      lookup: ttsLookup,
      officialPricing: ttsOfficialPricing,
      modelMeta: ttsModelMeta,
      showThinking: false,
      helperText: 'Prompting tip: send clean script text and keep style/voice instructions short.',
    })}
      </div>

      <div class="settings-actions-row">
        <div class="settings-meta">${state.models.length} models loaded</div>
      </div>
    `;
  }

  function render() {
    container.className = state.open ? 'settings-layer active' : 'settings-layer';

    // Save scroll position before re-render
    const body = container.querySelector('.settings-body');
    const scrollTop = body ? body.scrollTop : 0;

    const content = state.activeTab === 'models'
      ? renderModelsTab()
      : state.activeTab === 'usage'
        ? renderUsageTab()
        : renderLogsTab();

    container.innerHTML = `
      <div class="settings-backdrop ${state.open ? 'visible' : ''}" id="settings-backdrop"></div>
        <aside class="settings-panel ${state.open ? 'open' : ''}">
          <div class="settings-header">
            <div>
              <h3>Settings</h3>
              <div class="settings-meta">Models, thinking presets, usage and logs</div>
            </div>
            <button class="settings-close-btn" id="settings-close-btn" aria-label="Close settings">×</button>
          </div>

          <div class="settings-tabs">
            <button class="settings-tab-btn ${state.activeTab === 'models' ? 'active' : ''}" data-settings-tab="models">Models</button>
            <button class="settings-tab-btn ${state.activeTab === 'usage' ? 'active' : ''}" data-settings-tab="usage">Usage</button>
            <button class="settings-tab-btn ${state.activeTab === 'logs' ? 'active' : ''}" data-settings-tab="logs">Logs</button>
          </div>

          <div class="settings-body">
            <div class="settings-body-inner">
              ${state.error ? `<div class="settings-alert error">${escapeHtml(state.error)}</div>` : ''}
              ${state.loading ? '<div class="settings-loading">Loading settings...</div>' : content}
            </div>
          </div>
        </aside>
    `;

    // Restore scroll position after re-render
    const newBody = container.querySelector('.settings-body');
    if (newBody && scrollTop > 0) {
      newBody.scrollTop = scrollTop;
    }

    container.querySelector('#settings-backdrop')?.addEventListener('click', closePanel);
    container.querySelector('#settings-close-btn')?.addEventListener('click', closePanel);

    container.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-settings-tab') || 'models';
        state.activeTab = tab;
        state.error = '';
        if (tab === 'logs') {
          if (state.logSubTab === 'events' && (state.usageEvents || []).length === 0) {
            void refreshUsageEvents();
          } else if (state.logSubTab === 'raw' && (state.logs || []).length === 0) {
            void refreshLogs();
          }
        }
        render();
      });
    });

    container.querySelector('.settings-body')?.addEventListener('click', (event) => {
      const insideCombo = event.target.closest('.settings-combobox');
      if (insideCombo) return;
      if (state.openModelDropdown) {
        state.openModelDropdown = null;
        render();
      }
    });

    container.querySelector('#settings-orchestrator-combo-trigger')?.addEventListener('click', () => {
      state.openModelDropdown = state.openModelDropdown === 'orchestrator' ? null : 'orchestrator';
      if (state.openModelDropdown === 'orchestrator') {
        state.modelLookups.orchestrator.query = '';
      }
      if (state.openModelDropdown === 'orchestrator'
        && state.modelLookups.orchestrator.options.length === 0) {
        void refreshLookupOptions('orchestrator', '');
      }
      render();
    });

    container.querySelector('#settings-coding-combo-trigger')?.addEventListener('click', () => {
      state.openModelDropdown = state.openModelDropdown === 'coding' ? null : 'coding';
      if (state.openModelDropdown === 'coding') {
        state.modelLookups.coding.query = '';
      }
      if (state.openModelDropdown === 'coding'
        && state.modelLookups.coding.options.length === 0) {
        void refreshLookupOptions('coding', '');
      }
      render();
    });

    container.querySelector('#settings-browser-combo-trigger')?.addEventListener('click', () => {
      state.openModelDropdown = state.openModelDropdown === 'browser' ? null : 'browser';
      if (state.openModelDropdown === 'browser') {
        state.modelLookups.browser.query = '';
      }
      if (state.openModelDropdown === 'browser'
        && state.modelLookups.browser.options.length === 0) {
        void refreshLookupOptions('browser', '');
      }
      render();
    });

    container.querySelector('#settings-image-combo-trigger')?.addEventListener('click', () => {
      state.openModelDropdown = state.openModelDropdown === 'image' ? null : 'image';
      if (state.openModelDropdown === 'image') {
        state.modelLookups.image.query = '';
      }
      if (state.openModelDropdown === 'image'
        && state.modelLookups.image.options.length === 0) {
        void refreshLookupOptions('image', '');
      }
      render();
    });

    container.querySelector('#settings-tts-combo-trigger')?.addEventListener('click', () => {
      state.openModelDropdown = state.openModelDropdown === 'tts' ? null : 'tts';
      if (state.openModelDropdown === 'tts') {
        state.modelLookups.tts.query = '';
      }
      if (state.openModelDropdown === 'tts'
        && state.modelLookups.tts.options.length === 0) {
        void refreshLookupOptions('tts', '');
      }
      render();
    });

    container.querySelector('#settings-orchestrator-combo-search')?.addEventListener('input', (event) => {
      const value = event.target.value || '';
      scheduleLookupSearch('orchestrator', value);
      render();
      const input = container.querySelector('#settings-orchestrator-combo-search');
      if (input) {
        input.focus();
        const pos = String(value).length;
        input.setSelectionRange(pos, pos);
      }
    });

    container.querySelector('#settings-coding-combo-search')?.addEventListener('input', (event) => {
      const value = event.target.value || '';
      scheduleLookupSearch('coding', value);
      render();
      const input = container.querySelector('#settings-coding-combo-search');
      if (input) {
        input.focus();
        const pos = String(value).length;
        input.setSelectionRange(pos, pos);
      }
    });

    container.querySelector('#settings-browser-combo-search')?.addEventListener('input', (event) => {
      const value = event.target.value || '';
      scheduleLookupSearch('browser', value);
      render();
      const input = container.querySelector('#settings-browser-combo-search');
      if (input) {
        input.focus();
        const pos = String(value).length;
        input.setSelectionRange(pos, pos);
      }
    });

    container.querySelector('#settings-image-combo-search')?.addEventListener('input', (event) => {
      const value = event.target.value || '';
      scheduleLookupSearch('image', value);
      render();
      const input = container.querySelector('#settings-image-combo-search');
      if (input) {
        input.focus();
        const pos = String(value).length;
        input.setSelectionRange(pos, pos);
      }
    });

    container.querySelector('#settings-tts-combo-search')?.addEventListener('input', (event) => {
      const value = event.target.value || '';
      scheduleLookupSearch('tts', value);
      render();
      const input = container.querySelector('#settings-tts-combo-search');
      if (input) {
        input.focus();
        const pos = String(value).length;
        input.setSelectionRange(pos, pos);
      }
    });

    container.querySelectorAll('[data-combo-option-field]').forEach((optionBtn) => {
      optionBtn.addEventListener('click', () => {
        const field = optionBtn.getAttribute('data-combo-option-field');
        const value = optionBtn.getAttribute('data-combo-option-value') || '';
        if (field === 'orchestrator') {
          state.draft.orchestratorModel = value;
          state.modelLookups.orchestrator.options = toModelOptions(
            state.modelLookups.orchestrator.options,
            state.draft.orchestratorModel
          );
        } else if (field === 'coding') {
          state.draft.codingModel = value;
          state.modelLookups.coding.options = toModelOptions(
            state.modelLookups.coding.options,
            state.draft.codingModel
          );
        } else if (field === 'browser') {
          state.draft.browserModel = value;
          state.modelLookups.browser.options = toModelOptions(
            state.modelLookups.browser.options,
            state.draft.browserModel
          );
        } else if (field === 'image') {
          state.draft.imageModel = value;
          state.modelLookups.image.options = toModelOptions(
            state.modelLookups.image.options,
            state.draft.imageModel
          );
        } else if (field === 'tts') {
          state.draft.ttsModel = value;
          state.modelLookups.tts.options = toModelOptions(
            state.modelLookups.tts.options,
            state.draft.ttsModel
          );
        }
        state.openModelDropdown = null;
        scheduleAutoSave();
        render();
      });
    });

    container.querySelectorAll('[data-thinking-field]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const field = btn.getAttribute('data-thinking-field');
        const level = normalizeThinkingLevel(btn.getAttribute('data-thinking-value'), THINKING_LEVEL_PRESETS[0].level);
        if (field === 'orchestrator') {
          state.draft.orchestratorThinkingLevel = level;
        } else if (field === 'browser') {
          state.draft.browserThinkingLevel = level;
        }
        scheduleAutoSave();
        render();
      });
    });

    container.querySelector('#settings-refresh-usage')?.addEventListener('click', () => {
      void refreshUsage();
    });

    container.querySelectorAll('[data-usage-component]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.usageComponentFilter = btn.getAttribute('data-usage-component') || 'all';
        render();
      });
    });

    container.querySelectorAll('[data-log-component]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.logComponent = btn.getAttribute('data-log-component') || 'orchestrator';
        void refreshLogs();
      });
    });

    container.querySelector('#settings-log-date')?.addEventListener('change', (event) => {
      state.logDate = event.target.value || todayDate();
      if (state.logSubTab === 'events') {
        void refreshUsageEvents();
      } else {
        void refreshLogs();
      }
    });

    container.querySelector('#settings-refresh-logs')?.addEventListener('click', () => {
      if (state.logSubTab === 'events') {
        void refreshUsageEvents();
      } else {
        void refreshLogs();
      }
    });

    container.querySelectorAll('[data-log-subtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.logSubTab = btn.getAttribute('data-log-subtab') || 'events';
        state.expandedLogIds = new Set();
        if (state.logSubTab === 'events' && state.usageEvents.length === 0) {
          void refreshUsageEvents();
        } else if (state.logSubTab === 'raw' && state.logs.length === 0) {
          void refreshLogs();
        } else {
          render();
        }
      });
    });

    container.querySelectorAll('[data-log-toggle]').forEach((header) => {
      header.addEventListener('click', () => {
        const entryId = header.getAttribute('data-log-toggle');
        if (!entryId) return;
        if (state.expandedLogIds.has(entryId)) {
          state.expandedLogIds.delete(entryId);
        } else {
          state.expandedLogIds.add(entryId);
        }
        render();
        requestAnimationFrame(() => {
          const entry = container.querySelector(`[data-log-entry-id="${entryId}"]`);
          if (entry) {
            entry.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        });
      });
    });
  }

  window.addEventListener('ui:open-settings', () => {
    openPanel();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open) {
      closePanel();
    }
  });

  // Restore settings panel if URL hash is #settings (survives page refresh)
  if (window.location.hash === '#settings') {
    openPanel();
  } else {
    render();
  }
  return container;
}
