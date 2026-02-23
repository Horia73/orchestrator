/**
 * Agent Panel — Claude artifacts-style split view.
 *
 * Agents are scoped per-conversation. Each message can trigger agents
 * that appear inline in the conversation flow.
 */

import {
  openBrowserSession,
  loadBrowserStatus,
  loadBrowserFrame,
  loadBrowserHistory,
  setBrowserManualControl,
  sendBrowserControl,
  sendBrowserTask,
  streamBrowserFrames,
} from '../services/api.js';

const AGENT_STATES = {
  THINKING: 'thinking',
  TOOL_CALLING: 'tool_calling',
  WAITING: 'waiting',
  WORKING: 'working',
  DONE: 'done',
  ERROR: 'error',
};

const STATE_LABELS = {
  thinking: 'Thinking',
  tool_calling: 'Using tool',
  waiting: 'Waiting',
  working: 'Working',
  done: 'Done',
  error: 'Error',
};

const STATE_ICONS = {
  thinking: '🌿',
  tool_calling: '⚙',
  waiting: '◌',
  working: '●',
  done: '✓',
  error: '✗',
};

const BROWSER_KIND = 'browser';
const BROWSER_HISTORY_LIMIT = 120;
const BROWSER_IDLE_POLL_MS = 1500;
const BROWSER_STATUS_POLL_MS = 1200;
const BROWSER_STREAM_FPS = 12;

function normalizeSnapshotLogs(rawLogs) {
  if (!Array.isArray(rawLogs)) return [];
  return rawLogs
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, 120);
}

function normalizeAgentKind(rawKind, fallbackName = '') {
  const primary = String(rawKind || '').trim().toLowerCase();
  if (primary === 'browser') return BROWSER_KIND;
  if (primary === 'terminal' || primary === 'fs' || primary === 'image' || primary === 'tts') return primary;

  const fromName = String(fallbackName || '').trim().toLowerCase();
  if (fromName.includes('browser')) return BROWSER_KIND;

  return primary || '';
}

function createDefaultBrowserState() {
  return {
    opened: false,
    live: false,
    manual: false,
    streaming: false,
    loading: false,
    error: '',
    frame: null,
    history: [],
    selectedFrameId: '',
    lastHistoryFetchAt: 0,
    pollCount: 0,
    urlDraft: '',
    typeDraft: '',
    steerDraft: '',
    editingUrl: false,
    editingType: false,
    editingSteer: false,
    autoOpenTried: false,
    lastStatusLine: '',
  };
}

function ensureBrowserState(agent) {
  const defaults = createDefaultBrowserState();
  if (!agent.browser || typeof agent.browser !== 'object') {
    agent.browser = defaults;
  } else {
    agent.browser = {
      ...defaults,
      ...agent.browser,
    };
  }
  return agent.browser;
}

function isBrowserAgent(agent) {
  return normalizeAgentKind(agent?.kind, agent?.name) === BROWSER_KIND;
}

function toLocalTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

class AgentManager {
  constructor() {
    // Map<agentId, agent> — agents now have a convId and msgId
    this.agents = new Map();
    this.selectedAgentId = null;
    this.listeners = new Set();
    this.activeConvId = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    this._notify();
  }

  _notify() {
    this._toggleWrapperClass();
    this.listeners.forEach(fn => fn());
  }

  _toggleWrapperClass() {
    const wrapper = document.querySelector('.chat-area-wrapper');
    if (!wrapper) return;
    if (this.selectedAgentId) {
      wrapper.classList.add('panel-open');
    } else {
      wrapper.classList.remove('panel-open');
    }
  }

  // Set active conversation — clears selection
  setActiveConversation(convId) {
    if (this.activeConvId !== convId) {
      this.activeConvId = convId;
      this.selectedAgentId = null;
      this._notify();
    }
  }

  // Get agents for the active conversation only
  getAgents() {
    return [...this.agents.values()].filter(a => a.convId === this.activeConvId);
  }

  // Get agents spawned for a specific message
  getAgentsForMessage(msgId) {
    return [...this.agents.values()].filter(a => a.msgId === msgId);
  }

  getActiveAgents() {
    return this.getAgents().filter(a => a.state !== AGENT_STATES.DONE && a.state !== AGENT_STATES.ERROR);
  }

  getAgent(id) {
    return this.agents.get(id);
  }

  ensureAgent(snapshot, options = {}) {
    if (!snapshot || !snapshot.id) return null;

    const {
      convId = this.activeConvId,
      msgId = null,
      task = 'Agent execution',
    } = options;

    const snapshotKind = normalizeAgentKind(snapshot.kind, snapshot.name);

    let agent = this.agents.get(snapshot.id);
    if (!agent) {
      const now = new Date();
      const snapshotLogs = normalizeSnapshotLogs(snapshot.logs);
      agent = {
        id: snapshot.id,
        name: snapshot.name || 'Agent',
        kind: snapshotKind,
        task,
        convId,
        msgId,
        state: snapshot.state || AGENT_STATES.THINKING,
        logs: snapshotLogs.length > 0
          ? snapshotLogs.map((text) => ({ time: now, text }))
          : [
            {
              time: now,
              text: 'Loaded from conversation history.',
            },
          ],
        createdAt: now,
      };

      if (agent.kind === BROWSER_KIND) {
        ensureBrowserState(agent);
      }

      this.agents.set(agent.id, agent);
    } else {
      const snapshotLogs = normalizeSnapshotLogs(snapshot.logs);
      if (snapshot.name) agent.name = snapshot.name;
      if (snapshot.state) agent.state = snapshot.state;
      if (snapshotKind) agent.kind = snapshotKind;
      if (convId) agent.convId = convId;
      if (msgId) agent.msgId = msgId;
      if (task && !agent.task) agent.task = task;
      if (snapshotLogs.length > 0 && agent.logs.length <= 1) {
        const now = new Date();
        agent.logs = snapshotLogs.map((text) => ({ time: now, text }));
      }

      if (agent.kind === BROWSER_KIND) {
        ensureBrowserState(agent);
      }
    }

    return agent.id;
  }

  ensureBrowserConsoleAgent(convId = this.activeConvId) {
    const safeConvId = convId || '__global__';
    const id = `browser_console_${safeConvId}`;

    const existing = this.agents.get(id);
    if (existing) {
      return existing.id;
    }

    const now = new Date();
    const agent = {
      id,
      name: 'Browser Agent',
      kind: BROWSER_KIND,
      task: 'Live browser view and manual control',
      convId: safeConvId,
      msgId: null,
      state: AGENT_STATES.WAITING,
      logs: [{ time: now, text: 'Browser console ready.' }],
      createdAt: now,
      browser: createDefaultBrowserState(),
    };

    this.agents.set(id, agent);
    this._notify();
    return id;
  }

  getSelectedAgent() {
    return this.selectedAgentId ? this.agents.get(this.selectedAgentId) : null;
  }

  focusAgent(id) {
    if (!id || !this.agents.has(id)) return;
    this.selectedAgentId = id;
    this._notify();
  }

  selectAgent(id) {
    this.selectedAgentId = this.selectedAgentId === id ? null : id;
    this._notify();
  }

  closePanel() {
    this.selectedAgentId = null;
    this._notify();
  }

  // Spawn agent scoped to conversation + message
  spawnAgent(name, task, convId, msgId, kind = '') {
    const id = 'agent_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const normalizedKind = normalizeAgentKind(kind, name);
    const agent = {
      id,
      name,
      kind: normalizedKind,
      task,
      convId: convId || this.activeConvId,
      msgId: msgId || null,
      state: AGENT_STATES.THINKING,
      logs: [{ time: new Date(), text: `Starting: ${task}` }],
      createdAt: new Date(),
    };
    if (normalizedKind === BROWSER_KIND) {
      ensureBrowserState(agent);
    }
    this.agents.set(id, agent);
    this._notify();
    return id;
  }

  addLog(id, text, state) {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (state) agent.state = state;
    agent.logs.push({ time: new Date(), text });
    this._notify();
  }

  finishAgent(id, summary) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.state = AGENT_STATES.DONE;
    if (summary) agent.logs.push({ time: new Date(), text: `✓ ${summary}` });
    this._notify();
  }

  errorAgent(id, error) {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.state = AGENT_STATES.ERROR;
    agent.logs.push({ time: new Date(), text: `✗ Error: ${error}` });
    this._notify();
  }

  // Clear all agents for a conversation
  clearForConversation(convId) {
    for (const [id, agent] of this.agents) {
      if (agent.convId === convId) this.agents.delete(id);
    }
    if (this.selectedAgentId && !this.agents.has(this.selectedAgentId)) {
      this.selectedAgentId = null;
    }
    this._notify();
  }

  // ─── Mock / Demo ───
  async simulateForMessage(message, convId, msgId) {
    const plans = this._decideMockAgents(message);

    for (const plan of plans) {
      await sleep(200 + Math.random() * 300);
      const id = this.spawnAgent(plan.name, plan.task, convId, msgId);
      this._runMockAgent(id, plan.steps);
    }
  }

  _decideMockAgents(message) {
    const lower = message.toLowerCase();

    if (lower.includes('cod') || lower.includes('script') || lower.includes('python') || lower.includes('javascript') || lower.includes('code')) {
      return [
        {
          name: 'Research Agent',
          task: 'Analyzing code requirements and best practices',
          steps: ['Parsing user intent...', 'Identifying language & framework...', 'Reviewing relevant documentation...', 'Preparing solution approach'],
        },
        {
          name: 'Code Agent',
          task: 'Writing and validating implementation',
          steps: ['Setting up boilerplate...', 'Implementing core logic...', 'Adding error handling...', 'Optimizing performance...', 'Running lint checks'],
        },
      ];
    }

    if (lower.includes('cm3588') || lower.includes('server') || lower.includes('deploy')) {
      return [
        {
          name: 'Research Agent',
          task: 'Looking up hardware specs and capabilities',
          steps: ['Querying knowledge base...', 'Checking ARM64 compatibility...', 'Reviewing benchmark data...'],
        },
        {
          name: 'Analysis Agent',
          task: 'Comparing configurations and options',
          steps: ['Evaluating use cases...', 'Comparing performance profiles...', 'Generating recommendations'],
        },
      ];
    }

    if (lower.includes('imagine') || lower.includes('poza') || lower.includes('image') || lower.includes('design')) {
      return [
        {
          name: 'Vision Agent',
          task: 'Processing visual content',
          steps: ['Analyzing image context...', 'Extracting features...', 'Generating description'],
        },
      ];
    }

    // Default
    return [
      {
        name: 'Assistant Agent',
        task: 'Processing your request',
        steps: ['Understanding context...', 'Gathering information...', 'Composing response...'],
      },
    ];
  }

  async _runMockAgent(id, steps) {
    const stateSequence = [AGENT_STATES.THINKING, AGENT_STATES.TOOL_CALLING, AGENT_STATES.WORKING, AGENT_STATES.WAITING, AGENT_STATES.WORKING];

    for (let i = 0; i < steps.length; i++) {
      await sleep(800 + Math.random() * 1200);
      const agent = this.agents.get(id);
      if (!agent || agent.state === AGENT_STATES.DONE || agent.state === AGENT_STATES.ERROR) break;
      const nextState = stateSequence[i % stateSequence.length];
      this.addLog(id, steps[i], nextState);
    }
    await sleep(500);
    const agent = this.agents.get(id);
    if (agent && agent.state !== AGENT_STATES.DONE && agent.state !== AGENT_STATES.ERROR) {
      this.finishAgent(id, 'Task complete');
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export const agentManager = new AgentManager();
export { AGENT_STATES, STATE_LABELS, STATE_ICONS };


// ─── Agent Detail Panel (half-screen, slides in from right like Claude artifacts) ───
export function createAgentDetailPanel() {
  const el = document.createElement('div');
  el.className = 'agent-detail-panel';
  el.id = 'agent-detail-panel';

  let pollTimer = null;
  let pollInFlight = false;
  let pollAgentId = '';
  let pollIntervalMs = 0;
  let frameStreamAbort = null;
  let frameStreamAgentId = '';
  let frameStreamFps = 0;

  function stopFrameStream() {
    if (frameStreamAbort) {
      frameStreamAbort.abort();
      frameStreamAbort = null;
    }
    frameStreamAgentId = '';
    frameStreamFps = 0;
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    pollAgentId = '';
    pollIntervalMs = 0;
    stopFrameStream();
  }

  async function syncBrowserStatus(agent) {
    if (!agent || !isBrowserAgent(agent)) return false;
    const browserState = ensureBrowserState(agent);
    const status = await loadBrowserStatus();
    let changed = false;
    if (status && typeof status === 'object') {
      const nextManual = Boolean(status.manualControlEnabled);
      if (browserState.manual !== nextManual) {
        browserState.manual = nextManual;
        changed = true;
      }
      if (typeof status.lastStatusMessage === 'string' && status.lastStatusMessage.trim()) {
        const lastLog = browserState.lastStatusLine || '';
        if (lastLog !== status.lastStatusMessage) {
          browserState.lastStatusLine = status.lastStatusMessage;
          agent.logs.push({ time: new Date(), text: status.lastStatusMessage });
          if (agent.logs.length > 160) {
            agent.logs = agent.logs.slice(-160);
          }
          changed = true;
        }
      }
    }
    return changed;
  }

  async function hydrateBrowserState(agent, options = {}) {
    if (!agent || !isBrowserAgent(agent)) return;

    const {
      forceOpen = false,
      live = false,
      refreshHistory = false,
      skipFrame = false,
      background = false,
    } = options;

    const browserState = ensureBrowserState(agent);
    let changed = false;

    if (!background) {
      browserState.loading = true;
      browserState.error = '';
      changed = true;
      agentManager.notify();
    }

    try {
      if (forceOpen) {
        const opened = await openBrowserSession();
        browserState.opened = true;
        changed = true;
        browserState.frame = opened.frame || browserState.frame || null;
        browserState.history = Array.isArray(opened.history) ? opened.history : browserState.history;
        if (!browserState.selectedFrameId && browserState.history.length > 0) {
          browserState.selectedFrameId = browserState.history[browserState.history.length - 1].id;
        }
        if (opened.status) {
          const nextManual = Boolean(opened.status.manualControlEnabled);
          if (browserState.manual !== nextManual) {
            browserState.manual = nextManual;
            changed = true;
          }
        }
      }

      if (await syncBrowserStatus(agent)) {
        changed = true;
      }

      const wantsLive = Boolean(live || browserState.live || browserState.manual);
      if (!skipFrame) {
        const frame = await loadBrowserFrame({ live: wantsLive });
        if (frame && typeof frame === 'object') {
          browserState.opened = true;
          browserState.frame = frame;
          if (wantsLive) {
            browserState.selectedFrameId = '';
          }
          changed = true;
        }
      }

      const shouldRefreshHistory = refreshHistory
        || (Date.now() - Number(browserState.lastHistoryFetchAt || 0) > 3200)
        || !Array.isArray(browserState.history)
        || browserState.history.length === 0;

      if (shouldRefreshHistory) {
        const history = await loadBrowserHistory(BROWSER_HISTORY_LIMIT);
        browserState.lastHistoryFetchAt = Date.now();
        browserState.history = Array.isArray(history) ? history : [];
        if (!browserState.selectedFrameId && browserState.history.length > 0) {
          browserState.selectedFrameId = browserState.history[browserState.history.length - 1].id;
        }
        changed = true;
      }
    } catch (error) {
      browserState.error = error instanceof Error ? error.message : String(error);
      changed = true;
    } finally {
      if (!background) {
        browserState.loading = false;
      }
      browserState.pollCount = Number(browserState.pollCount || 0) + 1;
      if (changed || !background) {
        agentManager.notify();
      }
    }
  }

  function getDisplayedFrame(agent) {
    if (!agent || !isBrowserAgent(agent)) return null;
    const browserState = ensureBrowserState(agent);

    if ((browserState.live || browserState.manual) && browserState.frame) {
      return browserState.frame;
    }

    if (browserState.selectedFrameId && Array.isArray(browserState.history) && browserState.history.length > 0) {
      const selected = browserState.history.find((item) => item.id === browserState.selectedFrameId);
      if (selected) {
        return selected;
      }
    }

    if (browserState.frame) {
      return browserState.frame;
    }

    if (Array.isArray(browserState.history) && browserState.history.length > 0) {
      return browserState.history[browserState.history.length - 1];
    }

    return null;
  }

  function updateBrowserFrameDom(agent, frame) {
    if (!agent || !isBrowserAgent(agent) || !frame) return false;
    const selected = agentManager.getSelectedAgent();
    if (!selected || selected.id !== agent.id) return false;

    const image = el.querySelector('#browser-live-image');
    if (!(image instanceof HTMLImageElement)) return false;

    image.src = `data:image/jpeg;base64,${frame.imageBase64}`;
    image.dataset.frameId = String(frame.id || '');
    image.dataset.vw = String(frame.viewport?.width || 0);
    image.dataset.vh = String(frame.viewport?.height || 0);

    const frameTimeEl = el.querySelector('#browser-meta-frame-time');
    if (frameTimeEl) {
      frameTimeEl.textContent = frame?.timestamp ? `Frame: ${toLocalTime(frame.timestamp)}` : 'Frame: n/a';
    }

    const sourceEl = el.querySelector('#browser-meta-source');
    if (sourceEl) {
      sourceEl.textContent = frame?.source ? `Source: ${String(frame.source)}` : '';
    }

    const viewportEl = el.querySelector('#browser-meta-viewport');
    if (viewportEl) {
      viewportEl.textContent = frame?.viewport ? `${frame.viewport.width}x${frame.viewport.height}` : '';
    }

    const browserState = ensureBrowserState(agent);
    if (!browserState.editingUrl) {
      const url = String(frame?.url || '');
      browserState.urlDraft = url;
      const urlInput = el.querySelector('#browser-url-input');
      if (urlInput instanceof HTMLInputElement) {
        urlInput.value = url;
      }
    }

    return true;
  }

  function ensureFrameStream(agent) {
    if (!agent || !isBrowserAgent(agent)) {
      stopFrameStream();
      return;
    }

    const browserState = ensureBrowserState(agent);
    const wantsRealtime = Boolean(browserState.live || browserState.manual);
    if (!wantsRealtime) {
      browserState.streaming = false;
      stopFrameStream();
      return;
    }

    if (frameStreamAbort && frameStreamAgentId === agent.id && frameStreamFps === BROWSER_STREAM_FPS) {
      return;
    }

    stopFrameStream();
    const controller = new AbortController();
    frameStreamAbort = controller;
    frameStreamAgentId = agent.id;
    frameStreamFps = BROWSER_STREAM_FPS;
    browserState.streaming = true;
    browserState.error = '';
    agentManager.notify();

    void streamBrowserFrames(
      {
        live: true,
        fps: BROWSER_STREAM_FPS,
        includeStatus: true,
        onFrame: async (frame) => {
          if (controller.signal.aborted || !frame || !isBrowserAgent(agent)) return;
          const localState = ensureBrowserState(agent);
          localState.opened = true;
          localState.frame = frame;
          localState.selectedFrameId = '';
          const patched = updateBrowserFrameDom(agent, frame);
          if (!patched) {
            agentManager.notify();
          }
        },
        onStatus: async (status) => {
          if (controller.signal.aborted || !status || !isBrowserAgent(agent)) return;
          const localState = ensureBrowserState(agent);
          const nextManual = Boolean(status.manualControlEnabled);
          let changed = false;
          if (localState.manual !== nextManual) {
            localState.manual = nextManual;
            changed = true;
          }
          if (typeof status.lastStatusMessage === 'string' && status.lastStatusMessage.trim()) {
            if (localState.lastStatusLine !== status.lastStatusMessage) {
              localState.lastStatusLine = status.lastStatusMessage;
              agent.logs.push({ time: new Date(), text: status.lastStatusMessage });
              if (agent.logs.length > 160) {
                agent.logs = agent.logs.slice(-160);
              }
              changed = true;
            }
          }
          if (changed) {
            agentManager.notify();
          }
        },
        onError: async (message) => {
          if (controller.signal.aborted || !isBrowserAgent(agent)) return;
          const localState = ensureBrowserState(agent);
          localState.error = String(message || 'Browser stream error.');
          agentManager.notify();
        },
      },
      controller.signal
    ).catch((error) => {
      if (controller.signal.aborted || !isBrowserAgent(agent)) return;
      const localState = ensureBrowserState(agent);
      localState.error = error instanceof Error ? error.message : String(error);
      agentManager.notify();
    }).finally(() => {
      if (!isBrowserAgent(agent)) return;
      const localState = ensureBrowserState(agent);
      if (frameStreamAbort === controller) {
        frameStreamAbort = null;
        frameStreamAgentId = '';
        frameStreamFps = 0;
      }
      localState.streaming = false;
      agentManager.notify();
    });
  }

  function ensurePolling(agent) {
    if (!agent || !isBrowserAgent(agent)) {
      stopPolling();
      return;
    }

    const browserState = ensureBrowserState(agent);
    if (!browserState.opened && !browserState.live && !browserState.manual) {
      stopPolling();
      return;
    }

    const desiredInterval = browserState.live || browserState.manual
      ? BROWSER_STATUS_POLL_MS
      : BROWSER_IDLE_POLL_MS;

    if (pollTimer && pollAgentId === agent.id && pollIntervalMs === desiredInterval) {
      ensureFrameStream(agent);
      return;
    }

    stopPolling();
    pollAgentId = agent.id;
    pollIntervalMs = desiredInterval;
    ensureFrameStream(agent);
    pollTimer = setInterval(() => {
      const selected = agentManager.getSelectedAgent();
      if (!selected || selected.id !== pollAgentId || !isBrowserAgent(selected)) {
        stopPolling();
        return;
      }

      if (pollInFlight) {
        return;
      }

      pollInFlight = true;
      void hydrateBrowserState(selected, {
        live: Boolean(selected.browser?.live || selected.browser?.manual),
        skipFrame: Boolean(selected.browser?.live || selected.browser?.manual),
        background: true,
        refreshHistory: Number(selected.browser?.pollCount || 0) % 4 === 0,
      }).finally(() => {
        pollInFlight = false;
      });
    }, desiredInterval);
  }

  async function runBrowserAction(agent, action, options = {}) {
    if (!agent || !isBrowserAgent(agent)) return;

    const {
      refreshHistory = false,
      liveFrame = true,
    } = options;

    const browserState = ensureBrowserState(agent);
    browserState.loading = true;
    browserState.error = '';
    agentManager.notify();

    try {
      const payload = await sendBrowserControl(action);
      if (payload?.status && typeof payload.status === 'object') {
        browserState.manual = Boolean(payload.status.manualControlEnabled);
      }
      if (payload?.frame && typeof payload.frame === 'object') {
        browserState.opened = true;
        browserState.frame = payload.frame;
        if (browserState.live || browserState.manual) {
          browserState.selectedFrameId = '';
        }
        updateBrowserFrameDom(agent, payload.frame);
      } else if (liveFrame) {
        const frame = await loadBrowserFrame({ live: true });
        if (frame) {
          browserState.opened = true;
          browserState.frame = frame;
          if (browserState.live || browserState.manual) {
            browserState.selectedFrameId = '';
          }
          updateBrowserFrameDom(agent, frame);
        }
      }

      if (refreshHistory) {
        browserState.history = await loadBrowserHistory(BROWSER_HISTORY_LIMIT);
        browserState.lastHistoryFetchAt = Date.now();
      }
    } catch (error) {
      browserState.error = error instanceof Error ? error.message : String(error);
    } finally {
      browserState.loading = false;
      agentManager.notify();
      ensurePolling(agent);
    }
  }

  async function runBrowserTask(agent, goal) {
    if (!agent || !isBrowserAgent(agent)) return;
    const browserState = ensureBrowserState(agent);
    const trimmedGoal = String(goal || '').trim();
    if (!trimmedGoal) return;

    browserState.loading = true;
    browserState.error = '';
    agentManager.notify();

    try {
      await sendBrowserTask(trimmedGoal);
      browserState.steerDraft = '';
      browserState.opened = true;
      browserState.live = true;
      browserState.selectedFrameId = '';
      await hydrateBrowserState(agent, {
        live: true,
        refreshHistory: false,
        background: true,
      });
    } catch (error) {
      browserState.error = error instanceof Error ? error.message : String(error);
    } finally {
      browserState.loading = false;
      agentManager.notify();
      ensurePolling(agent);
    }
  }

  async function toggleManualControl(agent) {
    if (!agent || !isBrowserAgent(agent)) return;

    const browserState = ensureBrowserState(agent);
    browserState.loading = true;
    browserState.error = '';
    agentManager.notify();

    try {
      const nextManual = !browserState.manual;
      const status = await setBrowserManualControl(nextManual);
      browserState.manual = Boolean(status?.manualControlEnabled ?? nextManual);
      if (browserState.manual) {
        browserState.live = true;
        browserState.selectedFrameId = '';
      }
      if (!browserState.opened) {
        await hydrateBrowserState(agent, { forceOpen: true, live: true, refreshHistory: true });
      } else {
        await hydrateBrowserState(agent, { live: true, refreshHistory: false });
      }
    } catch (error) {
      browserState.error = error instanceof Error ? error.message : String(error);
    } finally {
      browserState.loading = false;
      agentManager.notify();
      ensurePolling(agent);
    }
  }

  async function toggleLive(agent) {
    if (!agent || !isBrowserAgent(agent)) return;

    const browserState = ensureBrowserState(agent);
    browserState.live = !browserState.live;
    if (browserState.live) {
      browserState.selectedFrameId = '';
    }
    if (browserState.live && !browserState.opened) {
      await hydrateBrowserState(agent, { forceOpen: true, live: true, refreshHistory: true });
    } else {
      await hydrateBrowserState(agent, {
        live: browserState.live || browserState.manual,
        refreshHistory: false,
      });
    }

    ensurePolling(agent);
  }

  function renderBrowserSection(agent) {
    const browserState = ensureBrowserState(agent);
    const frame = getDisplayedFrame(agent);
    const history = Array.isArray(browserState.history) ? browserState.history : [];
    const historyDesc = [...history].reverse();
    const controlDisabledAttr = browserState.manual ? '' : 'disabled';
    const historyDisabledAttr = browserState.live || browserState.manual ? 'disabled' : '';
    const steerDisabledAttr = browserState.manual ? 'disabled' : '';

    if (!browserState.editingUrl) {
      browserState.urlDraft = String(frame?.url || '');
    }

    const selectedFrameId = browserState.selectedFrameId || '';

    return `
      <div class="browser-panel">
        <div class="browser-toolbar-row">
          <button class="browser-btn" id="browser-open-btn" type="button">${browserState.opened ? 'Refresh' : 'Open Browser'}</button>
          <button class="browser-btn ${browserState.live ? 'active' : ''}" id="browser-live-btn" type="button">${browserState.live ? 'Live ON' : 'Live OFF'}</button>
          <button class="browser-btn ${browserState.manual ? 'active warn' : ''}" id="browser-manual-btn" type="button">${browserState.manual ? 'Release Control' : 'Take Control'}</button>
        </div>

        <div class="browser-toolbar-row browser-nav-row">
          <button class="browser-mini-btn" id="browser-back-btn" type="button" title="Back" ${controlDisabledAttr}>←</button>
          <button class="browser-mini-btn" id="browser-forward-btn" type="button" title="Forward" ${controlDisabledAttr}>→</button>
          <button class="browser-mini-btn" id="browser-reload-btn" type="button" title="Reload" ${controlDisabledAttr}>↻</button>
          <input class="browser-url-input" id="browser-url-input" type="text" placeholder="https://example.com" value="${escapeAttr(browserState.urlDraft || '')}" ${controlDisabledAttr} />
          <button class="browser-btn" id="browser-go-btn" type="button" ${controlDisabledAttr}>Go</button>
        </div>

        <div class="browser-live-wrap ${browserState.manual ? 'manual' : ''}">
          ${frame
            ? `<img
                class="browser-live-image"
                id="browser-live-image"
                src="data:image/jpeg;base64,${frame.imageBase64}"
                alt="Browser frame"
                data-frame-id="${escapeAttr(frame.id || '')}"
                data-vw="${escapeAttr(String(frame.viewport?.width || 0))}"
                data-vh="${escapeAttr(String(frame.viewport?.height || 0))}"
                tabindex="${browserState.manual ? '0' : '-1'}"
                draggable="false"
              />`
            : `<div class="browser-live-placeholder">No frame yet. Click Open Browser.</div>`
          }
        </div>

        <div class="browser-metadata-row">
          <span id="browser-meta-frame-time">${frame?.timestamp ? `Frame: ${escapeHtml(toLocalTime(frame.timestamp))}` : 'Frame: n/a'}</span>
          <span id="browser-meta-source">${frame?.source ? `Source: ${escapeHtml(String(frame.source))}` : ''}</span>
          <span id="browser-meta-viewport">${frame?.viewport ? `${frame.viewport.width}x${frame.viewport.height}` : ''}</span>
          <span id="browser-meta-stream">${browserState.streaming ? `Stream: ${BROWSER_STREAM_FPS}fps` : 'Stream: off'}</span>
        </div>

        <div class="browser-toolbar-row browser-type-row">
          <input class="browser-type-input" id="browser-type-input" type="text" value="${escapeAttr(browserState.typeDraft || '')}" placeholder="Type text into current focused field" ${controlDisabledAttr} />
          <button class="browser-btn" id="browser-type-send-btn" type="button" ${controlDisabledAttr}>Type</button>
          <button class="browser-btn" id="browser-enter-btn" type="button" ${controlDisabledAttr}>Enter</button>
        </div>

        <div class="browser-toolbar-row browser-steer-row">
          <input class="browser-steer-input" id="browser-steer-input" type="text" value="${escapeAttr(browserState.steerDraft || '')}" placeholder="Steer browser agent (e.g. 'find pricing on this page and summarize')" ${steerDisabledAttr} />
          <button class="browser-btn" id="browser-steer-send-btn" type="button" ${steerDisabledAttr}>Steer</button>
        </div>

        <div class="browser-history-title">Agent frames history (${history.length})</div>
        <div class="browser-history-strip" id="browser-history-strip">
          ${historyDesc.map((item) => {
            const active = item.id === selectedFrameId;
            return `
              <button class="browser-history-item ${active ? 'active' : ''}" type="button" data-history-frame-id="${escapeAttr(item.id || '')}" ${historyDisabledAttr}>
                <img src="data:image/jpeg;base64,${item.imageBase64}" alt="history frame" />
                <span>${escapeHtml(toLocalTime(item.timestamp))}</span>
              </button>
            `;
          }).join('')}
        </div>

        <div class="browser-helper-text">
          ${browserState.manual
            ? 'Manual control active: click frame to focus, use keyboard directly, scroll with wheel, and use controls above.'
            : 'Enable Take Control to interact directly. While Live/Manual is ON, history selection is paused to keep click mapping accurate.'}
        </div>

        ${browserState.error ? `<div class="browser-error">${escapeHtml(browserState.error)}</div>` : ''}
      </div>
    `;
  }

  function bindBrowserEvents(agent) {
    if (!agent || !isBrowserAgent(agent)) return;
    const browserState = ensureBrowserState(agent);

    el.querySelector('#browser-open-btn')?.addEventListener('click', () => {
      void hydrateBrowserState(agent, { forceOpen: true, live: browserState.live || browserState.manual, refreshHistory: true });
      ensurePolling(agent);
    });

    el.querySelector('#browser-live-btn')?.addEventListener('click', () => {
      void toggleLive(agent);
    });

    el.querySelector('#browser-manual-btn')?.addEventListener('click', () => {
      void toggleManualControl(agent);
    });

    el.querySelector('#browser-back-btn')?.addEventListener('click', () => {
      void runBrowserAction(agent, { type: 'goBack' });
    });

    el.querySelector('#browser-forward-btn')?.addEventListener('click', () => {
      void runBrowserAction(agent, { type: 'goForward' });
    });

    el.querySelector('#browser-reload-btn')?.addEventListener('click', () => {
      void runBrowserAction(agent, { type: 'reload' });
    });

    const navigate = () => {
      const value = String(browserState.urlDraft || '').trim();
      if (!value) return;
      void runBrowserAction(agent, { type: 'navigate', url: value });
    };

    const urlInput = el.querySelector('#browser-url-input');
    if (urlInput instanceof HTMLInputElement) {
      urlInput.addEventListener('focus', () => {
        browserState.editingUrl = true;
      });
      urlInput.addEventListener('blur', () => {
        browserState.editingUrl = false;
      });
      urlInput.addEventListener('input', () => {
        browserState.urlDraft = urlInput.value;
      });
    }

    el.querySelector('#browser-go-btn')?.addEventListener('click', navigate);
    el.querySelector('#browser-url-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        navigate();
      }
    });

    const typeText = () => {
      const value = String(browserState.typeDraft || '');
      if (!value) return;
      void runBrowserAction(agent, { type: 'type', text: value }, { liveFrame: false });
      browserState.typeDraft = '';
      const input = el.querySelector('#browser-type-input');
      if (input instanceof HTMLInputElement) {
        input.value = '';
      }
    };

    const typeInput = el.querySelector('#browser-type-input');
    if (typeInput instanceof HTMLInputElement) {
      typeInput.addEventListener('focus', () => {
        browserState.editingType = true;
      });
      typeInput.addEventListener('blur', () => {
        browserState.editingType = false;
      });
      typeInput.addEventListener('input', () => {
        browserState.typeDraft = typeInput.value;
      });
    }

    el.querySelector('#browser-type-send-btn')?.addEventListener('click', typeText);
    el.querySelector('#browser-enter-btn')?.addEventListener('click', () => {
      void runBrowserAction(agent, { type: 'pressKey', key: 'Enter' }, { liveFrame: false });
    });

    el.querySelector('#browser-type-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        typeText();
      }
    });

    const steer = () => {
      const value = String(browserState.steerDraft || '').trim();
      if (!value) return;
      void runBrowserTask(agent, value);
    };

    const steerInput = el.querySelector('#browser-steer-input');
    if (steerInput instanceof HTMLInputElement) {
      steerInput.addEventListener('focus', () => {
        browserState.editingSteer = true;
      });
      steerInput.addEventListener('blur', () => {
        browserState.editingSteer = false;
      });
      steerInput.addEventListener('input', () => {
        browserState.steerDraft = steerInput.value;
      });
      steerInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          steer();
        }
      });
    }

    el.querySelector('#browser-steer-send-btn')?.addEventListener('click', steer);

    const mapPointerToViewport = (event, image) => {
      const viewportWidth = Number(image.dataset.vw || 0);
      const viewportHeight = Number(image.dataset.vh || 0);
      if (viewportWidth <= 0 || viewportHeight <= 0) return null;

      const rect = image.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const naturalWidth = image.naturalWidth || viewportWidth;
      const naturalHeight = image.naturalHeight || viewportHeight;
      const imageRatio = naturalWidth / naturalHeight;
      const boxRatio = rect.width / rect.height;

      let drawWidth = rect.width;
      let drawHeight = rect.height;
      let offsetX = 0;
      let offsetY = 0;

      if (imageRatio > boxRatio) {
        drawWidth = rect.width;
        drawHeight = rect.width / imageRatio;
        offsetY = (rect.height - drawHeight) / 2;
      } else {
        drawHeight = rect.height;
        drawWidth = rect.height * imageRatio;
        offsetX = (rect.width - drawWidth) / 2;
      }

      const localX = event.clientX - rect.left - offsetX;
      const localY = event.clientY - rect.top - offsetY;
      if (localX < 0 || localY < 0 || localX > drawWidth || localY > drawHeight) {
        return null;
      }

      const ratioX = localX / drawWidth;
      const ratioY = localY / drawHeight;
      return {
        x: Math.max(0, Math.min(viewportWidth - 1, Math.round(ratioX * viewportWidth))),
        y: Math.max(0, Math.min(viewportHeight - 1, Math.round(ratioY * viewportHeight))),
      };
    };

    let wheelBlocked = false;
    const frameImage = el.querySelector('#browser-live-image');
    frameImage?.addEventListener('click', (event) => {
      if (!browserState.manual) return;
      const image = event.currentTarget;
      if (!(image instanceof HTMLImageElement)) return;
      const point = mapPointerToViewport(event, image);
      if (!point) return;

      browserState.selectedFrameId = '';
      image.focus({ preventScroll: true });

      void runBrowserAction(agent, {
        type: 'click',
        x: point.x,
        y: point.y,
        count: event.detail >= 2 ? 2 : 1,
      }, { liveFrame: false });
    });

    frameImage?.addEventListener('wheel', (event) => {
      if (!browserState.manual) return;
      event.preventDefault();

      if (wheelBlocked) return;
      wheelBlocked = true;
      setTimeout(() => {
        wheelBlocked = false;
      }, 120);

      browserState.selectedFrameId = '';
      if (frameImage instanceof HTMLElement) {
        frameImage.focus({ preventScroll: true });
      }

      const direction = event.deltaY > 0 ? 'down' : 'up';
      void runBrowserAction(agent, { type: 'scroll', direction }, { liveFrame: false });
    }, { passive: false });

    frameImage?.addEventListener('keydown', (event) => {
      if (!browserState.manual) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      let action = null;
      if (event.key === 'Enter') action = { type: 'pressKey', key: 'Enter' };
      else if (event.key === 'Backspace') action = { type: 'pressKey', key: 'Backspace' };
      else if (event.key === 'Delete') action = { type: 'pressKey', key: 'Delete' };
      else if (event.key === 'Tab') action = { type: 'pressKey', key: event.shiftKey ? 'Shift+Tab' : 'Tab' };
      else if (event.key === 'Escape') action = { type: 'pressKey', key: 'Escape' };
      else if (event.key === 'ArrowUp') action = { type: 'pressKey', key: 'ArrowUp' };
      else if (event.key === 'ArrowDown') action = { type: 'pressKey', key: 'ArrowDown' };
      else if (event.key === 'ArrowLeft') action = { type: 'pressKey', key: 'ArrowLeft' };
      else if (event.key === 'ArrowRight') action = { type: 'pressKey', key: 'ArrowRight' };
      else if (event.key === ' ') action = { type: 'pressKey', key: 'Space' };
      else if (event.key.length === 1) action = { type: 'type', text: event.key };

      if (!action) return;
      event.preventDefault();
      browserState.selectedFrameId = '';
      void runBrowserAction(agent, action, { liveFrame: false });
    });

    el.querySelectorAll('[data-history-frame-id]').forEach((node) => {
      node.addEventListener('click', () => {
        if (browserState.live || browserState.manual) {
          return;
        }
        const frameId = String(node.getAttribute('data-history-frame-id') || '').trim();
        if (!frameId) return;
        browserState.selectedFrameId = frameId;
        agentManager.notify();
      });
    });
  }

  function captureInputSnapshot() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !el.contains(active)) {
      return null;
    }

    const id = String(active.id || '').trim();
    if (!id) return null;

    if (active instanceof HTMLInputElement) {
      return {
        id,
        value: active.value,
        start: Number.isFinite(active.selectionStart) ? active.selectionStart : null,
        end: Number.isFinite(active.selectionEnd) ? active.selectionEnd : null,
      };
    }

    return { id, value: null, start: null, end: null };
  }

  function restoreInputSnapshot(snapshot) {
    if (!snapshot || !snapshot.id) return;
    const target = el.querySelector(`#${snapshot.id}`);
    if (!(target instanceof HTMLElement)) return;

    if (target instanceof HTMLInputElement && typeof snapshot.value === 'string') {
      target.value = snapshot.value;
      if (Number.isInteger(snapshot.start) && Number.isInteger(snapshot.end)) {
        try {
          target.setSelectionRange(snapshot.start, snapshot.end);
        } catch {
          // ignore selection restoration failures
        }
      }
    }

    target.focus({ preventScroll: true });
  }

  function render() {
    const agent = agentManager.getSelectedAgent();

    if (!agent) {
      stopPolling();
      el.classList.remove('open');
      return;
    }

    const browserMode = isBrowserAgent(agent);
    if (browserMode) {
      const browserState = ensureBrowserState(agent);
      if (!browserState.opened && !browserState.loading && !browserState.autoOpenTried) {
        browserState.autoOpenTried = true;
        void hydrateBrowserState(agent, { forceOpen: true, live: true, refreshHistory: true });
      }
    }
    const browserSection = browserMode ? renderBrowserSection(agent) : '';
    const focusSnapshot = captureInputSnapshot();

    el.classList.add('open');

    el.innerHTML = `
      <div class="agent-detail-header">
        <div class="agent-detail-title">
          <span class="agent-detail-dot ${agent.state}">${STATE_ICONS[agent.state] || '●'}</span>
          <span class="agent-detail-name">${escapeHtml(agent.name)}</span>
          <span class="agent-detail-status ${agent.state}">${STATE_LABELS[agent.state] || agent.state}</span>
        </div>
        <button class="agent-detail-close" id="agent-close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="agent-detail-task">${escapeHtml(agent.task)}</div>
      ${browserSection}
      <div class="agent-detail-logs" id="agent-logs">
        ${agent.logs.map((log, i) => `
          <div class="agent-log ${i === agent.logs.length - 1 ? 'latest' : ''} ${log.text.startsWith('✓') ? 'success' : ''} ${log.text.startsWith('✗') ? 'error' : ''}">
            <span class="agent-log-time">${formatLogTime(log.time)}</span>
            <span class="agent-log-text">${escapeHtml(log.text)}</span>
          </div>
        `).join('')}
      </div>
    `;

    const logsEl = el.querySelector('#agent-logs');
    if (logsEl) logsEl.scrollTop = logsEl.scrollHeight;

    el.querySelector('#agent-close')?.addEventListener('click', () => {
      agentManager.closePanel();
    });

    if (browserMode) {
      bindBrowserEvents(agent);
      ensurePolling(agent);
      restoreInputSnapshot(focusSnapshot);
    } else {
      stopPolling();
    }
  }

  agentManager.subscribe(render);
  render();

  return el;
}


function formatLogTime(date) {
  if (!(date instanceof Date)) date = new Date(date);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(value) {
  return escapeHtml(String(value || '')).replace(/"/g, '&quot;');
}
