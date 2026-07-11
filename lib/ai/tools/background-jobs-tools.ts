import path from 'path'

import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import {
    BACKGROUND_JOB_DEFAULT_TIMEOUT_MS,
    BACKGROUND_JOB_MAX_TIMEOUT_MS,
    getBackgroundJob,
    killBackgroundJob,
    listBackgroundJobs,
    readBackgroundJobLogTail,
    startTrackedBackgroundJob,
} from '@/lib/ai/background-jobs'
import { displayPath } from './sandbox'
import { collectEnvKeys, resolveEnvVarInjection } from './env-vars'

/**
 * Tracked background jobs as first-class tools.
 *
 * `Bash { run_in_background: true }` routes through the same tracked-job
 * machinery, but CLI-backed runtimes (Claude Code / Codex) use their NATIVE
 * Bash tool, whose background tasks die shortly after the turn ends. These
 * tools are bridged to those runtimes over MCP, so a CLI-backed agent gets
 * the same durable behavior: the job outlives the turn and the conversation
 * is woken automatically with a completion notice.
 */

export const startBackgroundJobTool: ToolDef = {
    id: 'start_background_job',
    name: 'start_background_job',
    description: [
        'Start a long-running shell command as a TRACKED background job that keeps running after this turn ends. The job is owned by the Orchestrator server, not by your runtime — when it exits, a completion notice (exit code + log tail) is posted into this conversation automatically and you are woken to continue the task, so you can safely end your turn instead of waiting.',
        'Use this for anything that outlives a reasonable wait: long builds, big downloads or conversions, batch processing, training runs, deploys. Do NOT use it for dev servers or other never-exiting processes you merely want alive — set wake_on_exit false for those, and remember they are killed at the timeout.',
        'IMPORTANT on CLI runtimes (Claude Code/Codex): your native Bash tool\'s run_in_background does NOT survive the end of the turn — the runtime kills it seconds after your final message. Always use start_background_job for work that must continue after you stop.',
        'Commands start in the agent workspace by default and log to a redacted file you can tail with manage_background_jobs.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command to run in the background.',
            },
            description: {
                type: 'string',
                description: 'Short human-readable purpose; echoed in the completion notice so the follow-up turn has context.',
            },
            cwd: {
                type: 'string',
                description: 'Optional working directory. Relative paths resolve from the workspace root; absolute host paths are accepted. Defaults to the workspace root.',
            },
            timeout: {
                type: 'integer',
                description: `Timeout in milliseconds before the job is SIGTERMed. Defaults to ${BACKGROUND_JOB_DEFAULT_TIMEOUT_MS} (30 minutes), capped at ${BACKGROUND_JOB_MAX_TIMEOUT_MS} (24 hours).`,
            },
            wake_on_exit: {
                type: 'boolean',
                description: 'When false, no completion notice is posted and the conversation is not woken when the job exits. Defaults to true.',
            },
            env_keys: {
                type: 'array',
                description: 'Optional environment variable names to inject from the current profile workspace .env.local or process env. Values are never returned and are redacted from the log.',
                items: {
                    type: 'string',
                    description: 'Environment variable name, e.g. SHOPIFY_CLI_THEME_TOKEN.',
                },
            },
        },
        required: ['command'],
    },
    tags: ['execute', 'shell', 'background'],
}

export const manageBackgroundJobsTool: ToolDef = {
    id: 'manage_background_jobs',
    name: 'manage_background_jobs',
    description: [
        'Inspect and control tracked background jobs started with start_background_job or Bash run_in_background.',
        "action 'list' shows this conversation's jobs (running and recent). action 'output' returns the redacted log tail for one job. action 'kill' terminates a running job (no completion wake — you asked for the kill).",
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'output', 'kill'],
                description: 'What to do.',
            },
            job_id: {
                type: 'string',
                description: "Job id (e.g. bg_1730000000000_ab12cd). Required for 'output' and 'kill'.",
            },
            tail_chars: {
                type: 'integer',
                description: "For 'output': how many characters of log tail to return. Default 4000, max 20000.",
            },
            all_conversations: {
                type: 'boolean',
                description: "For 'list': include jobs from other conversations in this profile. Defaults to false.",
            },
        },
        required: ['action'],
    },
    tags: ['execute', 'background'],
}

function jobSummary(job: NonNullable<ReturnType<typeof getBackgroundJob>>) {
    return {
        id: job.id,
        status: job.status,
        exit_code: job.exitCode,
        command: job.command,
        description: job.description ?? undefined,
        cwd: job.cwd ? displayPath(job.cwd) : undefined,
        log_path: displayPath(job.logPath),
        started_at: job.startedAt,
        ended_at: job.endedAt ?? undefined,
        wake_on_exit: Boolean(job.wakeOnExit),
        conversation_id: job.conversationId ?? undefined,
    }
}

export async function executeStartBackgroundJob(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    const command = typeof args.command === 'string' ? args.command : ''
    if (!command.trim()) return { success: false, error: 'Missing required parameter: command' }

    const workspaceDir = activeRuntimePaths().agentWorkspaceDir
    const cwdArg = typeof args.cwd === 'string' ? args.cwd.trim() : ''
    const cwd = cwdArg
        ? path.normalize(path.isAbsolute(cwdArg) ? cwdArg : `${workspaceDir}/${cwdArg}`)
        : workspaceDir

    const envResolution = resolveEnvVarInjection(collectEnvKeys(args))
    if (!envResolution.ok) {
        return {
            success: false,
            error: envResolution.error,
            data: envResolution.missing ? { missing_env_keys: envResolution.missing } : undefined,
        }
    }

    const timeout = typeof args.timeout === 'number' && Number.isFinite(args.timeout)
        ? args.timeout
        : undefined
    const wakeOnExit = args.wake_on_exit !== false && Boolean(ctx?.conversationId)

    const result = startTrackedBackgroundJob({
        command,
        cwd,
        timeoutMs: timeout,
        injection: envResolution.injection,
        conversationId: ctx?.conversationId ?? null,
        description: typeof args.description === 'string' ? args.description : null,
        wakeOnExit,
    })
    if (!result.ok || !result.job) {
        return { success: false, error: result.error ?? 'Could not start background job' }
    }
    return {
        success: true,
        data: {
            ...jobSummary(result.job),
            started: true,
            note: wakeOnExit
                ? 'The job keeps running after this turn ends. When it exits, a completion notice with the log tail is posted into this conversation and you will be woken automatically — no need to wait or poll.'
                : 'The job keeps running after this turn ends. No completion wake was requested; check on it later with manage_background_jobs.',
        },
    }
}

export async function executeManageBackgroundJobs(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    const action = typeof args.action === 'string' ? args.action : ''
    const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : ''

    if (action === 'list') {
        const allConversations = args.all_conversations === true
        const jobs = listBackgroundJobs({
            conversationId: allConversations ? undefined : ctx?.conversationId,
            limit: 25,
        })
        return {
            success: true,
            data: {
                jobs: jobs.map(jobSummary),
                note: jobs.length === 0 ? 'No background jobs found.' : undefined,
            },
        }
    }

    if (action === 'output') {
        if (!jobId) return { success: false, error: "job_id is required for action 'output'" }
        const job = getBackgroundJob(jobId)
        if (!job) return { success: false, error: `Unknown background job: ${jobId}` }
        const tailChars = typeof args.tail_chars === 'number' && Number.isFinite(args.tail_chars)
            ? Math.min(Math.max(Math.floor(args.tail_chars), 200), 20_000)
            : 4_000
        return {
            success: true,
            data: {
                ...jobSummary(job),
                output_tail: readBackgroundJobLogTail(job, tailChars) || '(no output captured yet)',
            },
        }
    }

    if (action === 'kill') {
        if (!jobId) return { success: false, error: "job_id is required for action 'kill'" }
        const result = killBackgroundJob(jobId)
        if (!result.ok) return { success: false, error: result.error }
        return {
            success: true,
            data: { id: jobId, killed: true, note: 'SIGTERM sent (SIGKILL follows in 1.5s if needed). No completion wake will fire for a deliberate kill.' },
        }
    }

    return { success: false, error: `Unknown action: ${action || '(missing)'}. Use 'list', 'output', or 'kill'.` }
}
