import type { Message } from '@/lib/types'
import type { RequestLogRow } from '@/lib/observability/schema'
import { normalizeLogTranscriptForPreview } from '@/lib/observability/log-transcript'

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

if (failures > 0) process.exit(1)
console.log('Logs transcript smoke passed.')
