import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getExecutionContext } from '../../core/context.js';
import { mergeContextWithReportingPolicy } from '../../agents/shared/reportingRules.js';
import { getResearcherToolAccess } from '../../agents/researcher/index.js';

const RESEARCHER_AGENT_ID = 'researcher';
const TOOL_NAME = 'call_researcher_agent';
const MAX_PREVIOUS_TURNS = 10;
const RESEARCH_DEPTH_ORDER = ['quick', 'standard', 'deep', 'exhaustive'];
const DEPTH_ESCALATION_RECOMMENDATION_RE = /^\s*DEPTH_ESCALATION_RECOMMENDED:\s*(quick|standard|deep|exhaustive)\s*$/gim;
const MAX_AUTO_RESEARCH_PASSES = RESEARCH_DEPTH_ORDER.length;
const RESEARCH_DEPTH_PROFILES = Object.freeze({
    quick: {
        label: 'QUICK',
        instruction: 'Use 3-5 searches maximum. Focus on the most relevant sources. Do not spawn subagents.',
        maxSubagentSpawnDepth: 0,
        allowSubagents: false,
    },
    standard: {
        label: 'STANDARD',
        instruction: 'Use roughly 8-12 searches. Read full articles when relevant. Do not spawn subagents at this depth.',
        maxSubagentSpawnDepth: 0,
        allowSubagents: false,
    },
    deep: {
        label: 'DEEP',
        instruction: 'Use roughly 12-20 searches across multiple angles. You may spawn first-level subagents for parallel work, but child subagents must remain terminal and may not spawn again.',
        maxSubagentSpawnDepth: 1,
        allowSubagents: true,
    },
    exhaustive: {
        label: 'EXHAUSTIVE',
        instruction: 'Be extremely thorough. Use 20+ searches across multiple angles. You may spawn subagents and allow one additional nested layer when it materially improves coverage.',
        maxSubagentSpawnDepth: 2,
        allowSubagents: true,
    },
});

function resolveDepthProfile(rawDepth) {
    const depthLevel = String(rawDepth ?? 'standard').toLowerCase().trim();
    return {
        depthLevel: RESEARCH_DEPTH_PROFILES[depthLevel] ? depthLevel : 'standard',
        profile: RESEARCH_DEPTH_PROFILES[depthLevel] ?? RESEARCH_DEPTH_PROFILES.standard,
    };
}

function getNextDepth(depthLevel) {
    const currentIndex = RESEARCH_DEPTH_ORDER.indexOf(depthLevel);
    if (currentIndex === -1 || currentIndex >= RESEARCH_DEPTH_ORDER.length - 1) {
        return '';
    }

    return RESEARCH_DEPTH_ORDER[currentIndex + 1];
}

function stripDepthEscalationRecommendation(text) {
    const normalized = String(text ?? '');
    if (!normalized) {
        return '';
    }

    return normalized
        .replace(DEPTH_ESCALATION_RECOMMENDATION_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getAutoEscalationTarget(text, currentDepthLevel) {
    const nextDepth = getNextDepth(currentDepthLevel);
    if (!nextDepth) {
        return '';
    }

    DEPTH_ESCALATION_RECOMMENDATION_RE.lastIndex = 0;
    const match = DEPTH_ESCALATION_RECOMMENDATION_RE.exec(String(text ?? ''));
    if (!match) {
        return '';
    }

    const requestedDepth = String(match[1] ?? '').toLowerCase().trim();
    const currentIndex = RESEARCH_DEPTH_ORDER.indexOf(currentDepthLevel);
    const requestedIndex = RESEARCH_DEPTH_ORDER.indexOf(requestedDepth);
    if (requestedIndex <= currentIndex) {
        return '';
    }

    return nextDepth;
}

function buildSyntheticPreviousTurns({ task, context, depthLevel, responseText }) {
    const cleanedResponse = String(responseText ?? '').trim();
    if (!cleanedResponse) {
        return [];
    }

    const { profile } = resolveDepthProfile(depthLevel);
    const userText = [
        context ? `Context:\n${context}` : '',
        `Research Task:\n${task}`,
        `[Research Depth Used: ${profile.label}] ${profile.instruction}`,
    ].filter(Boolean).join('\n\n');

    return [
        { role: 'user', text: userText, parts: [{ text: userText }] },
        { role: 'ai', text: cleanedResponse, parts: [{ text: cleanedResponse }] },
    ];
}

/**
 * Extract previous researcher agent call/response pairs from chat history
 * for multi-turn conversation continuity.
 */
function extractPreviousAgentTurns(chatHistory) {
    if (!Array.isArray(chatHistory)) return [];

    const turns = [];
    for (const message of chatHistory) {
        if (message.role !== 'ai' || !Array.isArray(message.parts)) continue;

        for (const part of message.parts) {
            if (!part?.functionCall || part.functionCall.name !== TOOL_NAME) continue;

            const args = part.functionCall.args ?? {};
            const task = String(args.task ?? '').trim();
            if (!task) continue;

            const callId = typeof part.functionCall.id === 'string' ? part.functionCall.id.trim() : '';
            let responseText = '';
            for (const rPart of message.parts) {
                if (!rPart?.functionResponse) continue;
                const rId = typeof rPart.functionResponse.id === 'string' ? rPart.functionResponse.id.trim() : '';
                const rName = typeof rPart.functionResponse.name === 'string' ? rPart.functionResponse.name : '';
                if ((callId && rId === callId) || rName === TOOL_NAME) {
                    const resp = rPart.functionResponse.response ?? {};
                    responseText = String(resp.text ?? '').trim();
                    break;
                }
            }

            if (!responseText) continue;

            let userText = '';
            if (args.context) userText += `Context:\n${args.context}\n\n`;
            userText += `Research Task:\n${task}`;

            turns.push(
                { role: 'user', text: userText, parts: [{ text: userText }] },
                { role: 'ai', text: responseText, parts: [{ text: responseText }] },
            );
        }
    }

    if (turns.length > MAX_PREVIOUS_TURNS * 2) {
        return turns.slice(-(MAX_PREVIOUS_TURNS * 2));
    }
    return turns;
}

export const declaration = {
    name: 'call_researcher_agent',
    description: `Delegates a complex research task to the Researcher Agent — a deep-dive specialist for topics that require extensive web searching, reading multiple articles, cross-referencing sources, and synthesizing findings. Use this for:

• Travel research: flights, hotels, itineraries, visa requirements, best prices
• Medical/scientific research: literature reviews, drug efficacy, clinical trials
• Price comparison: best deals, product reviews, feature comparisons
• Market research: industry analysis, competitor intelligence, trends
• Technical research: comparing tools, frameworks, evaluating solutions
• Any task requiring reading 5+ web sources and producing a synthesis

Do NOT use this for simple questions that can be answered with a single web search.`,
    parameters: {
        type: 'OBJECT',
        properties: {
            task: {
                type: 'STRING',
                description: 'The specific research question or task. Be as detailed as possible — include dates, locations, constraints, and what outcome you expect.',
            },
            context: {
                type: 'STRING',
                description: 'Optional background context, user preferences, or constraints (e.g., "Budget max 500€", "Prefer peer-reviewed sources from 2023+").',
            },
            depth: {
                type: 'STRING',
                description: 'Research depth: "quick" (3-5 sources, no subagents), "standard" (8-12 sources, no subagents), "deep" (12-20 sources, root researcher may spawn first-level subagents only), or "exhaustive" (20+ sources, allows one additional nested subagent layer). Default: "standard".',
            },
            file_paths: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional absolute paths to files the agent should read for additional context.',
            },
        },
        required: ['task'],
    },
};

export async function execute({ task, context, depth, file_paths }) {
    const taskText = String(task ?? '').trim();
    if (!taskText) {
        return { error: 'task is required.' };
    }

    // Enhance context with depth instruction
    const { depthLevel, profile } = resolveDepthProfile(depth);

    try {
        const filesData = [];
        if (Array.isArray(file_paths) && file_paths.length > 0) {
            for (const path of file_paths) {
                const absolutePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
                try {
                    const content = await readFile(absolutePath, 'utf8');
                    filesData.push({ path: absolutePath, content });
                } catch (err) {
                    filesData.push({ path: absolutePath, content: `Error reading file: ${err.message}` });
                }
            }
        }

        const { generateResearchAdvice } = await import('../../agents/researcher/service.js');
        const contextData = getExecutionContext();
        const contextAttachments = Array.isArray(contextData?.userAttachments) ? contextData.userAttachments : [];
        const basePreviousTurns = extractPreviousAgentTurns(contextData?.chatHistory);
        const syntheticPreviousTurns = [];
        const accumulatedUsageRecords = [];
        const depthHistory = [];
        const mergedBaseContext = mergeContextWithReportingPolicy(context);

        let currentDepthLevel = depthLevel;
        let currentProfile = profile;
        let finalResult = null;
        let finalStatus = 'completed';

        for (let passIndex = 0; passIndex < MAX_AUTO_RESEARCH_PASSES; passIndex += 1) {
            const previousTurns = [...basePreviousTurns, ...syntheticPreviousTurns];
            const continuationMode = previousTurns.length > 0 ? 'continue_and_expand' : 'fresh';
            const enrichedContext = [
                mergedBaseContext,
                `[Research Depth: ${currentProfile.label}] ${currentProfile.instruction}`,
                previousTurns.length > 0
                    ? '[Continuation Policy] Prior researcher work exists in this chat. Reuse it, expand uncovered angles, and avoid repeating identical searches unless you are verifying freshness, resolving conflicts, or going materially deeper.'
                    : '',
                syntheticPreviousTurns.length > 0
                    ? '[Auto Escalation] This pass is a direct continuation at the next research depth. Continue from the prior pass instead of restarting from scratch.'
                    : '',
            ].filter(Boolean).join('\n\n').trim();

            const result = await generateResearchAdvice({
                task: taskText,
                context: enrichedContext,
                files: filesData,
                attachments: contextAttachments,
                previousTurns,
                spawnDepth: contextData?.spawnDepth ?? 0,
                maxSubagentSpawnDepth: currentProfile.maxSubagentSpawnDepth,
                toolAccessOverride: getResearcherToolAccess({ allowSubagents: currentProfile.allowSubagents }),
                continuationMode,
            });

            const resultUsageRecords = Array.isArray(result?.toolUsageRecords) ? result.toolUsageRecords : [];
            for (const usageRecord of resultUsageRecords) {
                accumulatedUsageRecords.push(usageRecord);
            }

            const rawText = String(result?.text ?? '');
            const cleanedText = stripDepthEscalationRecommendation(rawText);
            const wasStopped = result?.stopped === true || String(result?.stopReason ?? '').trim().length > 0;
            const toolStatus = wasStopped
                ? 'stopped'
                : (result.ok !== false ? 'completed' : 'error');

            depthHistory.push(currentDepthLevel);

            const nextDepth = toolStatus !== 'error'
                ? getAutoEscalationTarget(rawText, currentDepthLevel)
                : '';

            const sanitizedResult = {
                ...result,
                text: cleanedText,
            };

            if (!nextDepth) {
                finalResult = sanitizedResult;
                finalStatus = toolStatus;
                break;
            }

            syntheticPreviousTurns.push(...buildSyntheticPreviousTurns({
                task: taskText,
                context: enrichedContext,
                depthLevel: currentDepthLevel,
                responseText: cleanedText,
            }));

            currentDepthLevel = nextDepth;
            currentProfile = RESEARCH_DEPTH_PROFILES[currentDepthLevel];
            finalResult = sanitizedResult;
            finalStatus = toolStatus;
        }

        const usageMetadata = finalResult?.usageMetadata && typeof finalResult.usageMetadata === 'object'
            ? finalResult.usageMetadata
            : null;

        return {
            ok: finalStatus !== 'error',
            status: finalStatus,
            model: finalResult?.model,
            depth: currentDepthLevel,
            requestedDepth: depthLevel,
            depthHistory,
            autoEscalated: depthHistory.length > 1,
            continuedFromPrevious: (basePreviousTurns.length + syntheticPreviousTurns.length) > 0,
            nextSuggestedDepth: getNextDepth(currentDepthLevel) || undefined,
            agentThought: finalResult?.thought || '',
            text: finalResult?.text || '',
            stopReason: finalStatus === 'stopped' ? (finalResult?.stopReason || 'stopped') : undefined,
            fileCount: filesData.length,
            _usageRecords: accumulatedUsageRecords,
            _usage: {
                model: finalResult?.model,
                status: finalStatus,
                agentId: RESEARCHER_AGENT_ID,
                inputText: taskText,
                outputText: finalResult?.text || '',
                usageMetadata,
            },
        };
    } catch (error) {
        return { error: `Researcher agent call failed: ${error.message}` };
    }
}
