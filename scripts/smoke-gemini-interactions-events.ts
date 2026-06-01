import assert from 'node:assert/strict'

import type { ProviderSendOptions, StreamCallbacks, ToolCallInfo, ToolResult } from '@/lib/ai/agents/types'
import { GoogleProvider } from '@/lib/ai/providers/google'

type GeminiEvent = Record<string, unknown>

function makeStream(events: GeminiEvent[]): AsyncIterable<GeminiEvent> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) yield event
        },
    }
}

const firstRoundUsage = {
    total_input_tokens: 3,
    total_output_tokens: 1,
    total_thought_tokens: 2,
    total_tokens: 6,
}

const secondRoundUsage = {
    total_input_tokens: 5,
    total_output_tokens: 4,
    total_thought_tokens: 0,
    total_tokens: 9,
}

const streams: GeminiEvent[][] = [
    [
        {
            event_type: 'interaction.created',
            interaction: { id: 'int_tool', status: 'in_progress', steps: [], created: '', updated: '' },
        },
        {
            event_type: 'step.start',
            index: 0,
            step: { type: 'thought', summary: [{ type: 'text', text: 'Need a lookup.' }] },
        },
        {
            event_type: 'step.start',
            index: 1,
            step: { type: 'function_call', id: 'fc_1', name: 'lookup' },
        },
        {
            event_type: 'step.delta',
            index: 1,
            delta: { type: 'arguments_delta', arguments: '{"query":"ge' },
        },
        {
            event_type: 'step.delta',
            index: 1,
            delta: { type: 'arguments_delta', arguments: 'mini"}' },
        },
        {
            event_type: 'step.stop',
            index: 1,
        },
        {
            event_type: 'interaction.completed',
            interaction: {
                id: 'int_tool',
                status: 'completed',
                steps: [],
                created: '',
                updated: '',
                usage: firstRoundUsage,
            },
        },
    ],
    [
        {
            type: 'interaction.created',
            interaction: { id: 'int_final', status: 'in_progress', steps: [], created: '', updated: '' },
        },
        {
            event_type: 'step.start',
            index: 0,
            step: { type: 'model_output', content: [{ type: 'text', text: 'Final' }] },
        },
        {
            type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: ' answer.' },
        },
        {
            type: 'interaction.completed',
            interaction: {
                id: 'int_final',
                status: 'completed',
                steps: [],
                created: '',
                updated: '',
                usage: secondRoundUsage,
            },
        },
    ],
]

const createCalls: Array<Record<string, unknown>> = []
const fakeClient = {
    interactions: {
        create: async (params: Record<string, unknown>) => {
            createCalls.push(JSON.parse(JSON.stringify(params)) as Record<string, unknown>)
            const events = streams.shift()
            assert.ok(events, 'unexpected extra Gemini interaction create call')
            return makeStream(events)
        },
    },
}

const provider = new GoogleProvider('fake-api-key')
;(provider as unknown as { client: unknown }).client = fakeClient

const contents: string[] = []
const thoughts: string[] = []
const thinkingDone: number[] = []
const toolCalls: ToolCallInfo[] = []
const toolResults: Array<{ id: string; name: string; result: ToolResult }> = []
let doneMeta: Parameters<StreamCallbacks['onDone']>[0] | null = null

const callbacks: StreamCallbacks = {
    onThinking: (text) => thoughts.push(text),
    onThinkingDone: (seconds) => thinkingDone.push(seconds),
    onContent: (text) => contents.push(text),
    onToolCall: (toolCall) => toolCalls.push(toolCall),
    onToolResult: (id, name, result) => toolResults.push({ id, name, result }),
    onDone: (meta) => { doneMeta = meta },
    onError: (error) => { throw new Error(error) },
}

const options: ProviderSendOptions = {
    model: 'gemini-smoke',
    thinkingLevel: 'low',
    messages: [{ role: 'user', content: 'Hello Gemini' }],
}

await provider.stream(options, callbacks)

assert.equal(createCalls.length, 2)
assert.equal(createCalls[0].input, 'Hello Gemini')
assert.equal(createCalls[1].previous_interaction_id, 'int_tool')
assert.deepEqual(createCalls[1].input, [
    {
        type: 'function_result',
        name: 'lookup',
        call_id: 'fc_1',
        result: JSON.stringify({ success: false, error: 'Unknown tool: lookup' }),
        is_error: true,
    },
])

assert.deepEqual(thoughts, ['Need a lookup.'])
assert.ok(thinkingDone.length >= 1)
assert.deepEqual(toolCalls, [{ id: 'fc_1', name: 'lookup', arguments: { query: 'gemini' } }])
assert.deepEqual(toolResults, [
    {
        id: 'fc_1',
        name: 'lookup',
        result: { success: false, error: 'Unknown tool: lookup' },
    },
])
assert.equal(contents.join(''), 'Final answer.')
assert.deepEqual(doneMeta, {
    sessionId: 'int_final',
    usage: {
        total_input_tokens: 8,
        total_output_tokens: 5,
        total_thought_tokens: 2,
        total_tokens: 15,
    },
    thinkingDuration: 1,
})
