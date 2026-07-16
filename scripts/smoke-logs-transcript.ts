import type { Message } from '@/lib/types'
import type { RequestLogRow, ToolLogRow } from '@/lib/observability/schema'
import {
    deferMessageToolDetails,
    findToolCallReasoningEntry,
    normalizeLogTranscriptForPreview,
    toolLogReasoningEntry,
    withMissingToolLogReasoning,
} from '@/lib/observability/log-transcript'

let failures = 0

function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
    if (!ok) failures++
}

const row = {
    id: 'req_logs_smoke',
    conversationId: 'inbox_smoke',
    agentId: 'orchestrator',
    agentThreadId: null,
    parentRequestId: 'inbox_smoke_parent',
    depth: 0,
    provider: 'openai',
    model: 'gpt-smoke',
    thinkingLevel: 'medium',
    status: 'ok',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    thinkingMs: null,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    cachedTokens: null,
    toolUseTokens: null,
    totalTokens: null,
    modalityBreakdown: null,
    billingBreakdown: null,
    toolCallCount: 1,
    interactionId: null,
    statefulMode: false,
    errorMessage: null,
    inputText: 'ROW INPUT: provider prompt sent to the model',
    outputText: 'ROW OUTPUT: assistant text stored on the request log',
} satisfies RequestLogRow

const mixedThreadTranscript = {
    userMessage: {
        id: 'thread_user',
        role: 'user',
        content: 'THREAD USER: inline inbox reply',
        timestamp: 1_100,
    },
    assistantMessage: {
        id: 'thread_assistant',
        role: 'assistant',
        content: 'THREAD OUTPUT: human-facing inbox summary',
        contentSegments: [{ phase: 0, content: 'THREAD OUTPUT: human-facing inbox summary' }],
        reasoning: [{
            type: 'tool_call',
            id: 'tool_1',
            phase: 0,
            toolCallId: 'tool_1',
            title: 'Run tool',
            content: 'ok',
            toolName: 'run_tool',
            success: true,
            status: 'ok',
        }],
        timestamp: 2_100,
    },
} satisfies { userMessage: Message; assistantMessage: Message }

const normalized = normalizeLogTranscriptForPreview(row, mixedThreadTranscript)

check('normalization returns a transcript', normalized !== null)
check('user preview stays on request log input', normalized?.userMessage?.content === row.inputText, normalized?.userMessage)
check('assistant preview stays on request log output', normalized?.assistantMessage.content === row.outputText, normalized?.assistantMessage)
check(
    'mismatched source content segments are replaced with row output',
    normalized?.assistantMessage.contentSegments?.length === 1
        && normalized.assistantMessage.contentSegments[0]?.content === row.outputText,
    normalized?.assistantMessage.contentSegments
)
check('reasoning is preserved from richer transcript', normalized?.assistantMessage.reasoning?.length === 1, normalized?.assistantMessage.reasoning)

const streaming = normalizeLogTranscriptForPreview(
    { ...row, status: 'streaming', endedAt: null, durationMs: null, outputText: null },
    mixedThreadTranscript
)

check(
    'streaming rows without output can still use live source content',
    streaming?.assistantMessage.content === mixedThreadTranscript.assistantMessage.content,
    streaming?.assistantMessage
)

const toolLogs = [
    {
        id: 1,
        requestId: row.id,
        toolCallId: 'call_read',
        toolName: 'Read',
        title: 'Read status.ts',
        phase: 0,
        args: { path: 'status.ts' },
        resultText: '{"path":"status.ts","content":"ready"}',
        deltas: [{ stream: 'message', text: 'ready' }],
        success: true,
        startedAt: 1_200,
        durationMs: 25,
        errorMessage: null,
    },
    {
        id: 2,
        requestId: row.id,
        toolName: 'Bash',
        success: true,
        startedAt: 1_300,
        durationMs: 50,
        errorMessage: null,
    },
] satisfies ToolLogRow[]

const synthesized = withMissingToolLogReasoning({
    id: 'assistant_without_reasoning',
    role: 'assistant',
    content: 'final answer',
    timestamp: 2_000,
}, toolLogs)

check('missing reasoning synthesizes every tool log', synthesized.reasoning?.length === 2, synthesized.reasoning)
check(
    'synthesized tool logs keep final answer after tool phases',
    synthesized.contentSegments?.[0]?.phase === 2 && synthesized.contentSegments[0]?.content === 'final answer',
    synthesized.contentSegments
)
check('synthesized recent tool keeps full result', synthesized.reasoning?.[0]?.type === 'tool_call' && synthesized.reasoning[0].content.includes('ready'), synthesized.reasoning)
check('synthesized headers defer heavy cards', synthesized.reasoning?.every(entry => entry.type !== 'tool_call' || entry.detailsDeferred), synthesized.reasoning)
check('legacy tool fallback is explicit', synthesized.reasoning?.[1]?.type === 'tool_call' && synthesized.reasoning[1].content.includes('older tool call'), synthesized.reasoning)

const fullTool = toolLogReasoningEntry(toolLogs[0], 0, 0)
const deferredToolMessage = deferMessageToolDetails({
    id: 'deferred_tools',
    role: 'assistant',
    content: '',
    reasoning: [fullTool],
    timestamp: 2_000,
})
check('tool summary strips heavy result', deferredToolMessage.reasoning?.[0]?.type === 'tool_call' && deferredToolMessage.reasoning[0].content === '', deferredToolMessage.reasoning)
check('full tool can be found by stable call id', findToolCallReasoningEntry([fullTool], 'call_read')?.args?.path === 'status.ts', fullTool)

const partialSource = {
    id: 'assistant_with_one_tool',
    role: 'assistant',
    content: 'final answer',
    timestamp: 2_000,
    reasoning: [{
        type: 'tool_call',
        id: 'existing_read',
        phase: 0,
        toolCallId: 'existing_read',
        title: 'Read',
        content: 'already persisted',
        toolName: 'Read',
        success: true,
        status: 'ok',
    }],
    contentSegments: [{ phase: 1, content: 'final answer' }],
} satisfies Message

const partial = withMissingToolLogReasoning(partialSource, toolLogs)
check('partial reasoning appends only missing tool logs', partial.reasoning?.length === 2, partial.reasoning)
check('partial reasoning preserves existing tool entry', partial.reasoning?.[0]?.id === 'existing_read', partial.reasoning)

if (failures > 0) process.exit(1)
console.log('Logs transcript smoke passed.')
