import fs from 'fs/promises';
import path from 'path';

function toDateKey(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function dateKeyDaysAgo(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return toDateKey(date);
}

function safeNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function sanitizeComponent(component) {
  const normalized = String(component || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return normalized || 'orchestrator';
}

function normalizeModel(model) {
  const raw = String(model || '').trim();
  if (!raw) return 'unknown';
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

function emptyTotals() {
  return {
    promptTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    requests: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
  };
}

function addToTotals(target, source) {
  target.promptTokens += safeNumber(source.promptTokens);
  target.outputTokens += safeNumber(source.outputTokens);
  target.thoughtsTokens += safeNumber(source.thoughtsTokens);
  target.totalTokens += safeNumber(source.totalTokens);
  target.requests += safeNumber(source.requests || 1);
  target.estimatedCostUsd += safeNumber(source.estimatedCostUsd);
  target.pricedRequests += safeNumber(source.pricedRequests || 0);
}

function roundTotals(totals) {
  return {
    promptTokens: Math.round(totals.promptTokens),
    outputTokens: Math.round(totals.outputTokens),
    thoughtsTokens: Math.round(totals.thoughtsTokens),
    totalTokens: Math.round(totals.totalTokens),
    requests: Math.round(totals.requests),
    estimatedCostUsd: Number(totals.estimatedCostUsd.toFixed(8)),
    pricedRequests: Math.round(totals.pricedRequests),
  };
}

function resolvePricingForModel(pricing, model) {
  if (!pricing || typeof pricing !== 'object') return null;
  const shortModel = normalizeModel(model);

  const candidates = [model, `models/${shortModel}`, shortModel];
  for (const key of candidates) {
    const entry = pricing[key];
    if (!entry || typeof entry !== 'object') continue;
    const inputPer1M = Number(entry.inputPer1M);
    const outputPer1M = Number(entry.outputPer1M);
    if (!Number.isFinite(inputPer1M) || inputPer1M < 0) continue;
    if (!Number.isFinite(outputPer1M) || outputPer1M < 0) continue;
    return { inputPer1M, outputPer1M };
  }

  return null;
}

function estimateCostUsd({ pricing, model, promptTokens, outputTokens, thoughtsTokens }) {
  const price = resolvePricingForModel(pricing, model);
  if (!price) return null;
  const effectiveOutput = safeNumber(outputTokens) + safeNumber(thoughtsTokens);
  const promptCost = (safeNumber(promptTokens) / 1_000_000) * price.inputPer1M;
  const outputCost = (effectiveOutput / 1_000_000) * price.outputPer1M;
  return promptCost + outputCost;
}

function normalizeEvent(event) {
  const timestamp = event?.timestamp || new Date().toISOString();
  const model = normalizeModel(event?.model);
  const promptTokens = safeNumber(event?.promptTokens);
  const outputTokens = safeNumber(event?.outputTokens);
  const thoughtsTokens = safeNumber(event?.thoughtsTokens);
  const totalTokens = safeNumber(event?.totalTokens) || (promptTokens + outputTokens + thoughtsTokens);

  return {
    timestamp,
    component: sanitizeComponent(event?.component || 'orchestrator'),
    model,
    promptTokens,
    outputTokens,
    thoughtsTokens,
    totalTokens,
    requests: 1,
  };
}

export class UsageTracker {
  constructor({ dir, getPricingMap }) {
    this.dir = dir;
    this.getPricingMap = typeof getPricingMap === 'function' ? getPricingMap : () => ({});
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  _filePath(dateKey) {
    return path.join(this.dir, `usage-${dateKey}.ndjson`);
  }

  async record(event) {
    const normalized = normalizeEvent(event);
    const dateKey = toDateKey(new Date(normalized.timestamp));
    const line = `${JSON.stringify(normalized)}\n`;
    await fs.appendFile(this._filePath(dateKey), line, 'utf8');
  }

  async getEvents({ date, limit = 500 } = {}) {
    const dateKey = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : toDateKey(new Date());
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Number(limit), 2000)) : 500;
    const events = await this._readEventsForDate(dateKey);
    const pricing = this.getPricingMap();

    const enriched = events.map((event) => {
      const cost = estimateCostUsd({
        pricing,
        model: event.model,
        promptTokens: event.promptTokens,
        outputTokens: event.outputTokens,
        thoughtsTokens: event.thoughtsTokens,
      });
      return {
        ...event,
        estimatedCostUsd: cost !== null ? Number(cost.toFixed(8)) : null,
      };
    });

    return enriched.slice(-boundedLimit);
  }

  async _readEventsForDate(dateKey) {
    const filePath = this._filePath(dateKey);
    let raw = '';
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }

    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizeEvent(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async getSummary({ days = 7 } = {}) {
    const boundedDays = Number.isFinite(days) ? Math.max(1, Math.min(Number(days), 31)) : 7;
    const pricing = this.getPricingMap();
    const dayKeys = [];
    for (let i = 0; i < boundedDays; i += 1) {
      dayKeys.push(dateKeyDaysAgo(i));
    }

    const globalTotals = emptyTotals();
    const globalByComponent = new Map();
    const byDay = [];

    for (const dateKey of dayKeys.reverse()) {
      const events = await this._readEventsForDate(dateKey);
      const dayTotals = emptyTotals();
      const dayComponents = new Map();

      for (const event of events) {
        const estimatedCostUsd = estimateCostUsd({
          pricing,
          model: event.model,
          promptTokens: event.promptTokens,
          outputTokens: event.outputTokens,
          thoughtsTokens: event.thoughtsTokens,
        });
        const priced = estimatedCostUsd !== null;

        const eventTotals = {
          ...event,
          estimatedCostUsd: priced ? estimatedCostUsd : 0,
          pricedRequests: priced ? 1 : 0,
        };

        addToTotals(dayTotals, eventTotals);
        addToTotals(globalTotals, eventTotals);

        const dayComponent = dayComponents.get(event.component) || {
          component: event.component,
          totals: emptyTotals(),
          byModel: new Map(),
        };
        addToTotals(dayComponent.totals, eventTotals);

        const dayModel = dayComponent.byModel.get(event.model) || {
          model: event.model,
          totals: emptyTotals(),
        };
        addToTotals(dayModel.totals, eventTotals);
        dayComponent.byModel.set(event.model, dayModel);
        dayComponents.set(event.component, dayComponent);

        const globalComponent = globalByComponent.get(event.component) || {
          component: event.component,
          totals: emptyTotals(),
          byModel: new Map(),
        };
        addToTotals(globalComponent.totals, eventTotals);
        const globalModel = globalComponent.byModel.get(event.model) || {
          model: event.model,
          totals: emptyTotals(),
        };
        addToTotals(globalModel.totals, eventTotals);
        globalComponent.byModel.set(event.model, globalModel);
        globalByComponent.set(event.component, globalComponent);
      }

      byDay.push({
        date: dateKey,
        totals: roundTotals(dayTotals),
        byComponent: [...dayComponents.values()]
          .map((component) => ({
            component: component.component,
            totals: roundTotals(component.totals),
            byModel: [...component.byModel.values()]
              .map((model) => ({
                model: model.model,
                totals: roundTotals(model.totals),
              }))
              .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
          }))
          .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
      });
    }

    return {
      windowDays: boundedDays,
      totals: roundTotals(globalTotals),
      byComponent: [...globalByComponent.values()]
        .map((component) => ({
          component: component.component,
          totals: roundTotals(component.totals),
          byModel: [...component.byModel.values()]
            .map((model) => ({
              model: model.model,
              totals: roundTotals(model.totals),
            }))
            .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
        }))
        .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
      byDay,
    };
  }
}

