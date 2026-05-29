import assert from 'node:assert/strict'

import { browserVisionTestHooks, type VisionUsage } from '@/lib/browser-agent-runtime/vision'

const {
    buildRequestConfig,
    parseAgentActionsFromModelText,
    parseIterationLimitReviewFromModelText,
    requestParsedJsonWithRetries,
} = browserVisionTestHooks

const config = buildRequestConfig(
    { model: 'gemini-smoke', thinkingLevel: 'low', mediaResolution: 'medium' },
    { systemInstruction: 'system', responseJsonSchema: { type: 'object' } },
) as Record<string, unknown>

assert.equal(config.responseMimeType, 'application/json')
assert.deepEqual(config.responseJsonSchema, { type: 'object' })
assert.equal(config.systemInstruction, 'system')

const singleAction = parseAgentActionsFromModelText(`
The action is:
\`\`\`json
{"action":"click","coordinate":[10,20],"reasoning":"Click target"}
\`\`\`
`)
assert.equal(singleAction.length, 1)
assert.equal(singleAction[0].action, 'click')
assert.deepEqual(singleAction[0].coordinate, [10, 20])

const batchedActions = parseAgentActionsFromModelText(JSON.stringify([
    { action: 'click', coordinate: [1, 2], reasoning: 'Focus field' },
    { action: 'type', text: 'hello', reasoning: 'Enter value' },
]))
assert.equal(batchedActions.length, 2)
assert.equal(batchedActions[1].action, 'type')

assert.throws(
    () => parseAgentActionsFromModelText('{ action: "click", reasoning: "bad JSON" }'),
    /Invalid JSON/,
)
assert.throws(
    () => parseAgentActionsFromModelText('{"action":"teleport","reasoning":"bad action"}'),
    /Invalid browser action/,
)

const review = parseIterationLimitReviewFromModelText(JSON.stringify({
    whyNotFinished: 'Still loading',
    stuckPoint: 'Spinner',
    whySelfRecoveryFailed: 'Refresh did not help',
    humanAssessment: 'Human should inspect',
    missingToolsOrCapabilities: [],
    hardParts: ['dynamic UI'],
    easyParts: ['navigation'],
    futureStrategy: ['inspect diagnostics'],
    questionsForUser: [],
}))
assert.equal(review.stuckPoint, 'Spinner')

const originalWarn = console.warn
console.warn = () => {}
try {
    let calls = 0
    const usages: VisionUsage[] = []

    const retried = await requestParsedJsonWithRetries({
        contextLabel: 'browser action',
        model: 'gemini-smoke',
        requestParts: [{ text: 'base prompt' }],
        maxRetries: 3,
        parse: parseAgentActionsFromModelText,
        onUsage: (usage) => usages.push(usage),
        generate: async (parts) => {
            calls += 1
            if (calls === 1) {
                assert.equal(parts.at(-1)?.text, 'base prompt')
            } else {
                assert.match(parts.at(-1)?.text ?? '', /JSON OUTPUT RETRY/)
            }
            return {
                text: calls < 4
                    ? '{ action: "click", reasoning: "bad JSON" }'
                    : '{"action":"done","reasoning":"Recovered after retry"}',
                usageMetadata: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 2,
                    thoughtsTokenCount: 1,
                    totalTokenCount: 13,
                },
            }
        },
    })

    assert.equal(calls, 4)
    assert.equal(usages.length, 4)
    assert.equal(usages[0].model, 'gemini-smoke')
    assert.equal(usages[0].totalTokens, 13)
    assert.equal(retried[0].action, 'done')
} finally {
    console.warn = originalWarn
}

console.log('smoke-browser-vision-json ok')
