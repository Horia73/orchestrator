import fs from 'fs/promises';
import path from 'path';

function toDateKey(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function sanitizeComponent(component) {
  const normalized = String(component || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return normalized || 'orchestrator';
}

function resolveDateKey(value) {
  if (!value) return toDateKey(new Date());
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return toDateKey(new Date());
}

export class DailyLogger {
  constructor({ dir }) {
    this.dir = dir;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  _filePath(component, dateKey) {
    return path.join(this.dir, `${sanitizeComponent(component)}-${dateKey}.ndjson`);
  }

  async log(entry) {
    const timestamp = entry?.timestamp || new Date().toISOString();
    const dateKey = resolveDateKey(timestamp.slice(0, 10));
    const payload = {
      timestamp,
      level: entry?.level || 'info',
      component: sanitizeComponent(entry?.component || 'orchestrator'),
      event: String(entry?.event || 'event'),
      message: String(entry?.message || ''),
      data: entry?.data && typeof entry.data === 'object' ? entry.data : undefined,
    };

    const line = `${JSON.stringify(payload)}\n`;
    const filePath = this._filePath(payload.component, dateKey);
    await fs.appendFile(filePath, line, 'utf8');
  }

  async read({ component = 'orchestrator', date, limit = 200 } = {}) {
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Number(limit), 2000)) : 200;
    const dateKey = resolveDateKey(date);
    const filePath = this._filePath(component, dateKey);

    let raw = '';
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const lines = raw.split('\n').filter(Boolean);
    const selected = lines.slice(-boundedLimit);
    const parsed = [];

    for (const line of selected) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        parsed.push({
          timestamp: `${dateKey}T00:00:00.000Z`,
          level: 'warn',
          component: sanitizeComponent(component),
          event: 'invalid_log_line',
          message: line,
        });
      }
    }

    return parsed;
  }
}

