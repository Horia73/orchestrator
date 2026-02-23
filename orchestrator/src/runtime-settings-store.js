import fs from 'fs/promises';
import path from 'path';

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeModel(value, fallback) {
  const next = String(value || '').trim();
  return next || fallback;
}

function sanitizeThinkingBudget(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function sanitizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function sanitizeTemperature(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(2, parsed));
}

function sanitizePricingMap(raw, fallback = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return safeClone(fallback);
  }

  const output = {};
  for (const [key, value] of Object.entries(raw)) {
    const model = String(key || '').trim();
    if (!model) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    const inputPer1M = Number(value.inputPer1M);
    const outputPer1M = Number(value.outputPer1M);
    if (!Number.isFinite(inputPer1M) || inputPer1M < 0) continue;
    if (!Number.isFinite(outputPer1M) || outputPer1M < 0) continue;

    output[model] = {
      inputPer1M,
      outputPer1M,
      currency: 'USD',
    };
  }

  return output;
}

function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstGrapheme(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const iterator = segmenter.segment(text)[Symbol.iterator]();
      const first = iterator.next();
      return first?.value?.segment || '';
    } catch {
      // fallback below
    }
  }
  return Array.from(text)[0] || '';
}

function normalizeAssistantProfile(raw, fallback) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : {};
  const name = compactText(source.name).slice(0, 48)
    || compactText(fallbackSource.name).slice(0, 48)
    || 'AI Chat';
  const emoji = firstGrapheme(source.emoji)
    || firstGrapheme(fallbackSource.emoji)
    || '🤖';
  return { name, emoji };
}

function mergePricingMap(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return current;
  }

  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const model = String(key || '').trim();
    if (!model) continue;

    if (value === null) {
      delete next[model];
      continue;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const inputPer1M = Number(value.inputPer1M);
    const outputPer1M = Number(value.outputPer1M);
    if (!Number.isFinite(inputPer1M) || inputPer1M < 0) continue;
    if (!Number.isFinite(outputPer1M) || outputPer1M < 0) continue;

    next[model] = {
      inputPer1M,
      outputPer1M,
      currency: 'USD',
    };
  }

  return next;
}

function normalizeState(raw, defaults) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const orchestratorPatch = source.orchestrator && typeof source.orchestrator === 'object' ? source.orchestrator : {};
  const agentsPatch = source.agents && typeof source.agents === 'object' ? source.agents : {};
  const toolsPatch = source.tools && typeof source.tools === 'object' ? source.tools : {};
  const browserPatch = agentsPatch.browser && typeof agentsPatch.browser === 'object' ? agentsPatch.browser : {};
  const imagePatch = agentsPatch.image && typeof agentsPatch.image === 'object' ? agentsPatch.image : {};
  const ttsPatch = agentsPatch.tts && typeof agentsPatch.tts === 'object' ? agentsPatch.tts : {};
  const terminalPatch = toolsPatch.terminal && typeof toolsPatch.terminal === 'object'
    ? toolsPatch.terminal
    : (agentsPatch.terminal && typeof agentsPatch.terminal === 'object' ? agentsPatch.terminal : {});
  const fsPatch = toolsPatch.fs && typeof toolsPatch.fs === 'object'
    ? toolsPatch.fs
    : (agentsPatch.fs && typeof agentsPatch.fs === 'object' ? agentsPatch.fs : {});
  const imageDefaults = defaults?.agents?.image && typeof defaults.agents.image === 'object'
    ? defaults.agents.image
    : {
      model: 'gemini-3-pro-image-preview',
    };
  const ttsDefaults = defaults?.agents?.tts && typeof defaults.agents.tts === 'object'
    ? defaults.agents.tts
    : {
      model: 'gemini-2.5-flash-preview-tts',
      voice: 'Kore',
    };
  const terminalDefaults = defaults?.tools?.terminal && typeof defaults.tools.terminal === 'object'
    ? defaults.tools.terminal
    : (defaults?.agents?.terminal && typeof defaults.agents.terminal === 'object' ? defaults.agents.terminal : {
      enabled: true,
      cwd: '',
      shell: '',
      timeoutMs: 20000,
      maxOutputChars: 6000,
    });
  const fsDefaults = defaults?.tools?.fs && typeof defaults.tools.fs === 'object'
    ? defaults.tools.fs
    : {
      enabled: true,
    };
  const uiPatch = source.ui && typeof source.ui === 'object' ? source.ui : {};
  const assistantProfilePatch = uiPatch.assistantProfile && typeof uiPatch.assistantProfile === 'object'
    ? uiPatch.assistantProfile
    : {};

  return {
    orchestrator: {
      model: sanitizeModel(orchestratorPatch.model, defaults.orchestrator.model),
      thinkingBudget: sanitizeThinkingBudget(orchestratorPatch.thinkingBudget, defaults.orchestrator.thinkingBudget),
      webResearch: typeof orchestratorPatch.webResearch === 'boolean'
        ? orchestratorPatch.webResearch
        : defaults.orchestrator.webResearch,
      temperature: sanitizeTemperature(orchestratorPatch.temperature, defaults.orchestrator.temperature),
    },
    agents: {
      browser: {
        model: sanitizeModel(browserPatch.model, defaults.agents.browser.model),
        thinkingBudget: sanitizeThinkingBudget(browserPatch.thinkingBudget, defaults.agents.browser.thinkingBudget),
      },
      image: {
        model: sanitizeModel(imagePatch.model, imageDefaults.model),
      },
      tts: {
        model: sanitizeModel(ttsPatch.model, ttsDefaults.model),
        voice: sanitizeModel(ttsPatch.voice, ttsDefaults.voice),
      },
    },
    tools: {
      terminal: {
        enabled: typeof terminalPatch.enabled === 'boolean'
          ? terminalPatch.enabled
          : Boolean(terminalDefaults.enabled),
        cwd: sanitizeModel(terminalPatch.cwd, terminalDefaults.cwd),
        shell: sanitizeModel(terminalPatch.shell, terminalDefaults.shell),
        timeoutMs: sanitizePositiveInt(terminalPatch.timeoutMs, terminalDefaults.timeoutMs),
        maxOutputChars: sanitizePositiveInt(terminalPatch.maxOutputChars, terminalDefaults.maxOutputChars),
      },
      fs: {
        enabled: typeof fsPatch.enabled === 'boolean'
          ? fsPatch.enabled
          : Boolean(fsDefaults.enabled),
      },
    },
    pricing: sanitizePricingMap(source.pricing, defaults.pricing),
    ui: {
      assistantProfile: normalizeAssistantProfile(
        assistantProfilePatch,
        defaults.ui?.assistantProfile || { name: 'AI Chat', emoji: '🤖' }
      ),
    },
  };
}

export class RuntimeSettingsStore {
  constructor({ filePath, defaults, onChange }) {
    this.filePath = filePath;
    this.defaults = normalizeState(defaults, defaults);
    this.state = safeClone(this.defaults);
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.writeQueue = Promise.resolve();
    this.isWriting = false;
    this.watchDebounce = null;
  }

  enqueueWrite(task) {
    const run = this.writeQueue.then(() => task());
    this.writeQueue = run.catch(() => { });
    return run;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = normalizeState(parsed, this.defaults);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.warn(`Failed to load runtime settings from ${this.filePath}:`, error);
      }
      await this._saveUnlocked();
    }

    try {
      const watcher = fs.watch(this.filePath);
      (async () => {
        try {
          for await (const event of watcher) {
            if (this.isWriting) continue;
            if (this.watchDebounce) clearTimeout(this.watchDebounce);

            this.watchDebounce = setTimeout(async () => {
              try {
                const raw = await fs.readFile(this.filePath, 'utf8');
                const parsed = JSON.parse(raw);
                this.state = normalizeState(parsed, this.defaults);
                if (this.onChange) {
                  this.onChange(this.get());
                }
              } catch (err) {
                // ignore transient read errors during save
              }
            }, 100);
          }
        } catch (err) {
          console.warn('Config watch error:', err);
        }
      })();
    } catch (err) {
      console.warn(`Failed to set up watcher for ${this.filePath}:`, err);
    }
  }

  get() {
    return safeClone(this.state);
  }

  getPricingMap() {
    return safeClone(this.state.pricing);
  }

  async update(patch) {
    return this.enqueueWrite(async () => {
      const current = this.state;
      const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
      const orchestratorPatch = source.orchestrator && typeof source.orchestrator === 'object' ? source.orchestrator : {};
      const agentsPatch = source.agents && typeof source.agents === 'object' ? source.agents : {};
      const toolsPatch = source.tools && typeof source.tools === 'object' ? source.tools : {};
      const browserPatch = agentsPatch.browser && typeof agentsPatch.browser === 'object' ? agentsPatch.browser : {};
      const imagePatch = agentsPatch.image && typeof agentsPatch.image === 'object' ? agentsPatch.image : {};
      const ttsPatch = agentsPatch.tts && typeof agentsPatch.tts === 'object' ? agentsPatch.tts : {};
      const terminalPatch = toolsPatch.terminal && typeof toolsPatch.terminal === 'object'
        ? toolsPatch.terminal
        : (agentsPatch.terminal && typeof agentsPatch.terminal === 'object' ? agentsPatch.terminal : {});
      const fsPatch = toolsPatch.fs && typeof toolsPatch.fs === 'object'
        ? toolsPatch.fs
        : (agentsPatch.fs && typeof agentsPatch.fs === 'object' ? agentsPatch.fs : {});
      const uiPatch = source.ui && typeof source.ui === 'object' ? source.ui : {};
      const assistantProfilePatch = uiPatch.assistantProfile && typeof uiPatch.assistantProfile === 'object'
        ? uiPatch.assistantProfile
        : {};

      const next = {
        orchestrator: {
          model: 'model' in orchestratorPatch
            ? sanitizeModel(orchestratorPatch.model, current.orchestrator.model)
            : current.orchestrator.model,
          thinkingBudget: 'thinkingBudget' in orchestratorPatch
            ? sanitizeThinkingBudget(orchestratorPatch.thinkingBudget, current.orchestrator.thinkingBudget)
            : current.orchestrator.thinkingBudget,
          webResearch: typeof orchestratorPatch.webResearch === 'boolean'
            ? orchestratorPatch.webResearch
            : current.orchestrator.webResearch,
          temperature: 'temperature' in orchestratorPatch
            ? sanitizeTemperature(orchestratorPatch.temperature, current.orchestrator.temperature)
            : current.orchestrator.temperature,
        },
        agents: {
          browser: {
            model: 'model' in browserPatch
              ? sanitizeModel(browserPatch.model, current.agents.browser.model)
              : current.agents.browser.model,
            thinkingBudget: 'thinkingBudget' in browserPatch
              ? sanitizeThinkingBudget(browserPatch.thinkingBudget, current.agents.browser.thinkingBudget)
              : current.agents.browser.thinkingBudget,
          },
          image: {
            model: 'model' in imagePatch
              ? sanitizeModel(imagePatch.model, current.agents?.image?.model || this.defaults.agents?.image?.model || 'gemini-3-pro-image-preview')
              : (current.agents?.image?.model || this.defaults.agents?.image?.model || 'gemini-3-pro-image-preview'),
          },
          tts: {
            model: 'model' in ttsPatch
              ? sanitizeModel(ttsPatch.model, current.agents?.tts?.model || this.defaults.agents?.tts?.model || 'gemini-2.5-flash-preview-tts')
              : (current.agents?.tts?.model || this.defaults.agents?.tts?.model || 'gemini-2.5-flash-preview-tts'),
            voice: 'voice' in ttsPatch
              ? sanitizeModel(ttsPatch.voice, current.agents?.tts?.voice || this.defaults.agents?.tts?.voice || 'Kore')
              : (current.agents?.tts?.voice || this.defaults.agents?.tts?.voice || 'Kore'),
          },
        },
        tools: {
          terminal: {
            enabled: typeof terminalPatch.enabled === 'boolean'
              ? terminalPatch.enabled
              : current.tools.terminal.enabled,
            cwd: 'cwd' in terminalPatch
              ? sanitizeModel(terminalPatch.cwd, current.tools.terminal.cwd)
              : current.tools.terminal.cwd,
            shell: 'shell' in terminalPatch
              ? sanitizeModel(terminalPatch.shell, current.tools.terminal.shell)
              : current.tools.terminal.shell,
            timeoutMs: 'timeoutMs' in terminalPatch
              ? sanitizePositiveInt(terminalPatch.timeoutMs, current.tools.terminal.timeoutMs)
              : current.tools.terminal.timeoutMs,
            maxOutputChars: 'maxOutputChars' in terminalPatch
              ? sanitizePositiveInt(terminalPatch.maxOutputChars, current.tools.terminal.maxOutputChars)
              : current.tools.terminal.maxOutputChars,
          },
          fs: {
            enabled: typeof fsPatch.enabled === 'boolean'
              ? fsPatch.enabled
              : current.tools.fs.enabled,
          },
        },
        pricing: mergePricingMap(current.pricing, source.pricing),
        ui: {
          assistantProfile: normalizeAssistantProfile(
            {
              ...current.ui?.assistantProfile,
              ...assistantProfilePatch,
            },
            this.defaults.ui?.assistantProfile || { name: 'AI Chat', emoji: '🤖' }
          ),
        },
      };

      this.state = next;
      await this._saveUnlocked();
      return this.get();
    });
  }

  async save() {
    return this.enqueueWrite(() => this._saveUnlocked());
  }

  async _saveUnlocked() {
    this.isWriting = true;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
    } finally {
      setTimeout(() => { this.isWriting = false; }, 300);
    }
  }
}
