/**
 * manage_schedule tool — allows agents to create, list, and remove scheduled tasks.
 */
import { cronService } from '../services/cron.js';
import { getExecutionContext } from '../core/context.js';

export const declaration = {
    name: 'manage_schedule',
    description: 'Create, list, or remove scheduled/recurring tasks. Jobs fire their prompt as a message in the chat.',
    parameters: {
        type: 'OBJECT',
        properties: {
            action: {
                type: 'STRING',
                description: 'The action to perform: "add", "list", "remove", or "enable".',
                enum: ['add', 'list', 'remove', 'enable'],
            },
            name: {
                type: 'STRING',
                description: 'Human-readable name for the job (required for "add").',
            },
            schedule: {
                type: 'OBJECT',
                description: 'Schedule definition. Use one of: { every: <seconds> }, { cron: "<expr>", tz: "<timezone>" }, or { at: "<ISO datetime>" }. Required for "add".',
                properties: {
                    every: { type: 'NUMBER', description: 'Interval in seconds.' },
                    cron: { type: 'STRING', description: 'Cron expression (e.g. "0 9 * * *").' },
                    tz: { type: 'STRING', description: 'IANA timezone for cron (e.g. "Europe/Bucharest"). Only valid with cron.' },
                    at: { type: 'STRING', description: 'ISO 8601 datetime for one-shot execution.' },
                },
            },
            prompt: {
                type: 'STRING',
                description: 'The message/instruction to send when the job fires (required for "add").',
            },
            jobId: {
                type: 'STRING',
                description: 'Job ID (required for "remove" and "enable").',
            },
            enabled: {
                type: 'BOOLEAN',
                description: 'Set enabled state (for "enable" action). Defaults to true.',
            },
        },
        required: ['action'],
    },
};

export async function execute(args) {
    const context = getExecutionContext();
    const action = String(args?.action ?? '').trim().toLowerCase();

    switch (action) {
        case 'list': {
            const jobs = cronService.listJobs();
            const status = cronService.status();
            return {
                status: status.running ? 'running' : 'stopped',
                jobCount: jobs.length,
                jobs: jobs.map((j) => ({
                    id: j.id,
                    name: j.name,
                    schedule: j.schedule,
                    prompt: j.prompt.slice(0, 200),
                    enabled: j.enabled,
                    nextRun: j.nextRun ? new Date(j.nextRun).toISOString() : null,
                    lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
                    lastStatus: j.lastStatus,
                })),
            };
        }

        case 'add': {
            const name = String(args?.name ?? '').trim();
            if (!name) return { error: 'Name is required for adding a job.' };

            const schedule = args?.schedule;
            if (!schedule) return { error: 'Schedule is required. Use { every: <seconds> }, { cron: "<expr>" }, or { at: "<ISO>" }.' };

            const prompt = String(args?.prompt ?? '').trim();
            if (!prompt) return { error: 'Prompt is required — this is what gets sent when the job fires.' };

            const chatId = context?.chatId ?? '';

            try {
                const job = cronService.addJob({ name, schedule, prompt, chatId });
                return {
                    ok: true,
                    job: {
                        id: job.id,
                        name: job.name,
                        schedule: job.schedule,
                        nextRun: job.nextRun ? new Date(job.nextRun).toISOString() : null,
                    },
                };
            } catch (error) {
                return { error: error.message };
            }
        }

        case 'remove': {
            const jobId = String(args?.jobId ?? '').trim();
            if (!jobId) return { error: 'jobId is required for removing a job.' };

            const removed = cronService.removeJob(jobId);
            return removed
                ? { ok: true, message: `Job ${jobId} removed.` }
                : { error: `Job ${jobId} not found.` };
        }

        case 'enable': {
            const jobId = String(args?.jobId ?? '').trim();
            if (!jobId) return { error: 'jobId is required.' };

            const enabled = args?.enabled !== false;
            const job = cronService.enableJob(jobId, enabled);
            return job
                ? { ok: true, job: { id: job.id, name: job.name, enabled: job.enabled } }
                : { error: `Job ${jobId} not found.` };
        }

        default:
            return { error: `Unknown action "${action}". Use "add", "list", "remove", or "enable".` };
    }
}
