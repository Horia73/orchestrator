function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

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

function summarizeStatus(status) {
  if (!status || typeof status !== 'object') {
    return 'No status returned by browser agent.';
  }

  const parts = [];
  if (status.lastStatusMessage) {
    parts.push(String(status.lastStatusMessage));
  }
  if (status.currentUrl) {
    parts.push(`URL: ${status.currentUrl}`);
  }
  if (typeof status.openTabs === 'number') {
    parts.push(`tabs=${status.openTabs}`);
  }

  return parts.join(' | ') || 'Browser agent finished without detailed status.';
}

function normalizeModel(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

function sanitizeThinkingLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return '';
}

export class BrowserAgentClient {
  constructor(config, { onUsage, onLog } = {}) {
    this.config = config;
    this.onUsage = typeof onUsage === 'function' ? onUsage : null;
    this.onLog = typeof onLog === 'function' ? onLog : null;
  }

  updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object') return;

    if (typeof patch.model === 'string' && patch.model.trim()) {
      this.config.model = patch.model.trim();
    }

    if (typeof patch.thinkingLevel === 'string' && patch.thinkingLevel.trim()) {
      this.config.thinkingLevel = patch.thinkingLevel.trim().toLowerCase();
    }
  }

  getConfig() {
    return {
      model: this.config.model,
      thinkingLevel: sanitizeThinkingLevel(this.config.thinkingLevel) || 'minimal',
    };
  }

  _emitUsageFromTaskSummary(taskSummary) {
    if (!taskSummary || !this.onUsage) return;

    const byModel = taskSummary.byModel && typeof taskSummary.byModel === 'object'
      ? taskSummary.byModel
      : {};
    const entries = Object.entries(byModel);

    if (entries.length === 0) {
      const fallbackModel = normalizeModel(taskSummary.model || this.config.model) || 'unknown';
      this.onUsage({
        component: 'browser-agent',
        phase: 'task',
        model: fallbackModel,
        promptTokens: Number(taskSummary?.totals?.promptTokens) || 0,
        outputTokens: Number(taskSummary?.totals?.outputTokens) || 0,
        thoughtsTokens: Number(taskSummary?.totals?.thoughtsTokens) || 0,
        totalTokens: Number(taskSummary?.totals?.totalTokens) || 0,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    for (const [model, totals] of entries) {
      this.onUsage({
        component: 'browser-agent',
        phase: 'task',
        model: normalizeModel(model),
        promptTokens: Number(totals?.promptTokens) || 0,
        outputTokens: Number(totals?.outputTokens) || 0,
        thoughtsTokens: Number(totals?.thoughtsTokens) || 0,
        totalTokens: Number(totals?.totalTokens) || 0,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async runTask({ goal, timeoutMs, signal }) {
    const trimmedGoal = String(goal || '').trim();
    if (!trimmedGoal) {
      return {
        ok: false,
        agent: 'browser',
        goal: '',
        error: 'Missing goal for browser agent call.',
      };
    }

    if (!this.config.enabled) {
      return {
        ok: false,
        agent: 'browser',
        goal: trimmedGoal,
        error: 'Browser agent is disabled (BROWSER_AGENT_ENABLED=false).',
      };
    }

    const startedAt = Date.now();
    const timeline = [];
    this.onLog?.({
      level: 'info',
      component: 'browser-agent',
      event: 'agent_task_started',
      message: `Browser agent task started: ${trimmedGoal}`,
      data: {
        goal: trimmedGoal,
        model: this.config.model,
        thinkingLevel: sanitizeThinkingLevel(this.config.thinkingLevel) || 'minimal',
      },
    });

    try {
      const submitPayload = await this._request('/task', {
        method: 'POST',
        body: {
          goal: trimmedGoal,
          preserveContext: true,
          model: this.config.model,
          thinkingLevel: sanitizeThinkingLevel(this.config.thinkingLevel) || 'minimal',
        },
        signal,
      });

      if (submitPayload?.status?.lastStatusMessage) {
        timeline.push(String(submitPayload.status.lastStatusMessage));
      }

      let finalStatus = submitPayload?.status || null;
      while (true) {
        if (signal?.aborted) {
          throw new Error('Aborted');
        }

        await sleep(this.config.pollIntervalMs, signal);
        const statusPayload = await this._request('/status', {
          method: 'GET',
          signal,
        });

        const status = statusPayload?.status || null;
        finalStatus = status;

        const lastMsg = status?.lastStatusMessage ? String(status.lastStatusMessage) : '';
        if (lastMsg && timeline[timeline.length - 1] !== lastMsg) {
          timeline.push(lastMsg);
          this.onLog?.({
            level: 'info',
            component: 'browser-agent',
            event: 'agent_progress',
            message: lastMsg,
            data: { goal: trimmedGoal }
          });
        }

        if (!status?.running) {
          const taskUsage = status?.usage?.lastTask || status?.usage?.currentTask || null;
          this._emitUsageFromTaskSummary(taskUsage);
          this.onLog?.({
            level: 'info',
            component: 'browser-agent',
            event: 'agent_task_completed',
            message: `Browser agent task completed: ${trimmedGoal}`,
            data: {
              goal: trimmedGoal,
              durationMs: Date.now() - startedAt,
              ok: true,
            },
          });

          return {
            ok: true,
            agent: 'browser',
            goal: trimmedGoal,
            durationMs: Date.now() - startedAt,
            status,
            usage: taskUsage,
            timeline,
            summary: summarizeStatus(status),
          };
        }
      }
    } catch (error) {
      this.onLog?.({
        level: 'error',
        component: 'browser-agent',
        event: 'agent_task_failed',
        message: error instanceof Error ? error.message : String(error),
        data: {
          goal: trimmedGoal,
          durationMs: Date.now() - startedAt,
        },
      });

      return {
        ok: false,
        agent: 'browser',
        goal: trimmedGoal,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        timeline,
      };
    }
  }

  async _request(pathname, { method, body, signal }) {
    const headers = {
      Accept: 'application/json',
    };

    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
    }

    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await fetch(`${this.config.baseUrl}${pathname}`, {
      method,
      headers,
      body: payload,
      signal,
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { ok: false, error: text || 'Invalid JSON response' };
    }

    if (!response.ok) {
      const detail = parsed?.error ? String(parsed.error) : `HTTP ${response.status}`;
      throw new Error(`Browser agent request failed (${pathname}): ${detail}`);
    }

    if (parsed?.ok === false) {
      throw new Error(String(parsed.error || `Browser agent returned ok=false for ${pathname}`));
    }

    return parsed;
  }
}
