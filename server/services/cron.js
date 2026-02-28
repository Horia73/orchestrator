/**
 * Cron / Scheduling service.
 *
 * Supports three schedule kinds:
 *   - `every`: interval in seconds
 *   - `cron`: cron expression with optional IANA timezone
 *   - `at`: one-shot ISO datetime
 *
 * Jobs are persisted as JSON in ~/.orchestrator/data/cron/jobs.json.
 * When a job fires, the `onJob` callback is called with the job object.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import cronParser from 'cron-parser';
const { parseExpression } = cronParser;
import { CRON_DATA_DIR, CRON_STORE_PATH } from '../core/dataPaths.js';

function nowMs() {
    return Date.now();
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Compute the next run time (epoch ms) for a given schedule.
 */
function computeNextRun(schedule, fromMs = nowMs()) {
    if (!schedule || typeof schedule !== 'object') return null;

    if (schedule.at) {
        const atMs = new Date(schedule.at).getTime();
        if (!Number.isFinite(atMs)) return null;
        return atMs > fromMs ? atMs : null;
    }

    if (schedule.every) {
        const intervalMs = Number(schedule.every) * 1000;
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
        return fromMs + intervalMs;
    }

    if (schedule.cron) {
        try {
            const options = {
                currentDate: new Date(fromMs),
            };
            if (schedule.tz) {
                options.tz = schedule.tz;
            }
            const interval = parseExpression(schedule.cron, options);
            const next = interval.next();
            return next.getTime();
        } catch {
            return null;
        }
    }

    return null;
}

function validateSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object') {
        return 'Schedule must be an object with `every`, `cron`, or `at`.';
    }

    const hasEvery = schedule.every !== undefined;
    const hasCron = schedule.cron !== undefined;
    const hasAt = schedule.at !== undefined;
    const count = [hasEvery, hasCron, hasAt].filter(Boolean).length;

    if (count === 0) return 'Schedule must specify `every` (seconds), `cron` (expression), or `at` (ISO datetime).';
    if (count > 1) return 'Schedule must specify exactly one of `every`, `cron`, or `at`.';

    if (hasEvery) {
        const val = Number(schedule.every);
        if (!Number.isFinite(val) || val <= 0) return '`every` must be a positive number of seconds.';
    }

    if (hasCron) {
        try {
            const opts = {};
            if (schedule.tz) opts.tz = schedule.tz;
            parseExpression(schedule.cron, opts);
        } catch (e) {
            return `Invalid cron expression: ${e.message}`;
        }
    }

    if (hasAt) {
        const atMs = new Date(schedule.at).getTime();
        if (!Number.isFinite(atMs)) return '`at` must be a valid ISO datetime.';
    }

    if (schedule.tz && !hasCron) {
        return '`tz` is only valid with `cron` schedules.';
    }

    return null;
}

class CronService {
    constructor() {
        this._jobs = [];
        this._timer = null;
        this._onJob = null;
        this._running = false;
    }

    /**
     * Start the cron service.
     * @param {Function} onJob - Callback when a job fires: async (job) => void
     */
    start(onJob) {
        this._onJob = onJob;
        this._loadStore();
        this._recomputeAllNextRuns();
        this._armTimer();
        this._running = true;
        console.log(`[cron] Started with ${this._jobs.length} job(s)`);
    }

    stop() {
        this._running = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    listJobs() {
        return this._jobs.map((j) => ({ ...j }));
    }

    addJob({ name, schedule, prompt, chatId }) {
        const error = validateSchedule(schedule);
        if (error) throw new Error(error);

        const job = {
            id: randomUUID(),
            name: String(name ?? 'Unnamed job').trim(),
            schedule,
            prompt: String(prompt ?? '').trim(),
            chatId: String(chatId ?? '').trim() || null,
            enabled: true,
            createdAt: nowMs(),
            nextRun: computeNextRun(schedule),
            lastRun: null,
            lastStatus: null,
            lastError: null,
        };

        this._jobs.push(job);
        this._saveStore();
        this._armTimer();
        return { ...job };
    }

    removeJob(id) {
        const idx = this._jobs.findIndex((j) => j.id === id);
        if (idx === -1) return false;
        this._jobs.splice(idx, 1);
        this._saveStore();
        this._armTimer();
        return true;
    }

    enableJob(id, enabled = true) {
        const job = this._jobs.find((j) => j.id === id);
        if (!job) return null;
        job.enabled = enabled;
        if (enabled && !job.nextRun) {
            job.nextRun = computeNextRun(job.schedule);
        }
        this._saveStore();
        this._armTimer();
        return { ...job };
    }

    /**
     * Force-execute a job now, regardless of schedule.
     */
    async runJob(id) {
        const job = this._jobs.find((j) => j.id === id);
        if (!job) return null;
        await this._executeJob(job);
        return { ...job };
    }

    status() {
        return {
            running: this._running,
            jobCount: this._jobs.length,
            enabledCount: this._jobs.filter((j) => j.enabled).length,
            nextFireAt: this._getEarliestNextRun(),
        };
    }

    // ─── Internal ──────────────────────────────────────────────────────

    _loadStore() {
        try {
            if (fs.existsSync(CRON_STORE_PATH)) {
                const raw = fs.readFileSync(CRON_STORE_PATH, 'utf8');
                const parsed = JSON.parse(raw);
                this._jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
            }
        } catch {
            this._jobs = [];
        }
    }

    _saveStore() {
        ensureDir(CRON_DATA_DIR);
        fs.writeFileSync(
            CRON_STORE_PATH,
            JSON.stringify({ jobs: this._jobs }, null, 2) + '\n',
            'utf8',
        );
    }

    _recomputeAllNextRuns() {
        const now = nowMs();
        for (const job of this._jobs) {
            if (!job.enabled) continue;
            if (!job.nextRun || job.nextRun <= now) {
                job.nextRun = computeNextRun(job.schedule, now);
            }
        }
        this._saveStore();
    }

    _getEarliestNextRun() {
        let earliest = null;
        for (const job of this._jobs) {
            if (!job.enabled || !job.nextRun) continue;
            if (earliest === null || job.nextRun < earliest) {
                earliest = job.nextRun;
            }
        }
        return earliest;
    }

    _armTimer() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }

        const earliest = this._getEarliestNextRun();
        if (earliest === null) return;

        const delayMs = Math.max(earliest - nowMs(), 100);
        this._timer = setTimeout(() => this._onTimer(), delayMs);
    }

    async _onTimer() {
        this._timer = null;
        const now = nowMs();

        // Collect all due jobs
        const dueJobs = this._jobs.filter((j) => j.enabled && j.nextRun && j.nextRun <= now);

        for (const job of dueJobs) {
            await this._executeJob(job);
        }

        this._saveStore();
        this._armTimer();
    }

    async _executeJob(job) {
        job.lastRun = nowMs();
        try {
            if (this._onJob) {
                await this._onJob(job);
            }
            job.lastStatus = 'ok';
            job.lastError = null;
        } catch (error) {
            job.lastStatus = 'error';
            job.lastError = error?.message ?? String(error);
        }

        // Handle one-shot `at` schedules
        if (job.schedule.at) {
            job.enabled = false;
            job.nextRun = null;
        } else {
            // Recompute next run
            job.nextRun = computeNextRun(job.schedule, nowMs());
        }
    }
}

export const cronService = new CronService();
