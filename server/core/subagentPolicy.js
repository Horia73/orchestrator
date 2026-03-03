import { getExecutionContext } from './context.js';

export const MAX_SUBAGENT_SPAWN_DEPTH = 2;
export const MAX_CHILD_SUBAGENTS_PER_OWNER = 4;
export const MAX_SUBAGENT_TOOL_CALLS = 15;

function normalizeDepth(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return 0;
    }

    return Math.trunc(numeric);
}

export function normalizeMaxSubagentSpawnDepth(value, fallback = MAX_SUBAGENT_SPAWN_DEPTH) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return fallback;
    }

    return Math.min(MAX_SUBAGENT_SPAWN_DEPTH, Math.trunc(numeric));
}

export function getSubagentExecutionProfile() {
    const context = getExecutionContext();
    const spawnDepth = normalizeDepth(context?.spawnDepth);
    const maxSpawnDepth = normalizeMaxSubagentSpawnDepth(context?.maxSubagentSpawnDepth);
    const subagentId = String(context?.subagentId ?? '').trim();
    const parentAgentId = String(context?.parentAgentId ?? '').trim();
    const isSubagent = Boolean(subagentId) || spawnDepth > 0;
    const isLeafSubagent = spawnDepth >= maxSpawnDepth;
    const canSpawnChildren = spawnDepth < maxSpawnDepth;

    return {
        spawnDepth,
        maxSpawnDepth,
        subagentId,
        parentAgentId,
        isSubagent,
        isLeafSubagent,
        canSpawnChildren,
        maxChildSubagents: canSpawnChildren ? MAX_CHILD_SUBAGENTS_PER_OWNER : 0,
        maxToolCalls: isSubagent ? MAX_SUBAGENT_TOOL_CALLS : Infinity,
    };
}

export function buildSubagentExecutionPromptBlock() {
    const profile = getSubagentExecutionProfile();
    const mode = !profile.isSubagent
        ? 'ROOT_AGENT'
        : profile.isLeafSubagent
            ? 'TERMINAL_SUBAGENT'
            : 'DELEGATING_SUBAGENT';
    const rootSpawnLine = profile.maxSpawnDepth > 0
        ? `- Root agent mode: use \`spawn_subagent\` only for genuinely parallel branches. Default branch budget is ${MAX_CHILD_SUBAGENTS_PER_OWNER} direct subagents for broad tasks. Spawned branches are INLINE work, not background jobs, so wait for their results before your final answer. Maximum allowed spawn depth for this execution: ${profile.maxSpawnDepth}.`
        : '- Root agent mode: subagent spawning is disabled for this execution. Solve the task without calling `spawn_subagent`.';
    const delegatingSpawnLine = profile.maxSpawnDepth > profile.spawnDepth
        ? `- Delegating subagent mode: you are working on one assigned slice of the parent task. Return strong structured findings for that slice. You may spawn up to ${MAX_CHILD_SUBAGENTS_PER_OWNER} narrower child subagents only when it materially improves coverage. Hard limit: at most ${MAX_SUBAGENT_TOOL_CALLS} total tool calls inside this subagent branch.`
        : `- Delegating subagent mode: child spawning is disabled at your current depth (${profile.spawnDepth}) because this execution caps spawn depth at ${profile.maxSpawnDepth}. Finish your assigned slice yourself. Hard limit: at most ${MAX_SUBAGENT_TOOL_CALLS} total tool calls inside this subagent branch.`;

    return `
<execution_mode>
Current execution mode: ${mode}
${rootSpawnLine}
${delegatingSpawnLine}
- Terminal subagent mode: if you are already at spawn depth ${profile.maxSpawnDepth}, do NOT call \`spawn_subagent\` again. Finish the assigned slice yourself. Hard limit: at most ${MAX_SUBAGENT_TOOL_CALLS} total tool calls inside this subagent branch.
</execution_mode>
`.trim();
}
