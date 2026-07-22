import assert from 'node:assert/strict'

import { browserVisionTestHooks, createVisionService, type VisionUsage } from '@/lib/browser-agent-runtime/vision'
import { codexVisionTestHooks } from '@/lib/browser-agent-runtime/vision-codex'
import { browserAgentCoordinateTestHooks } from '@/lib/browser-agent-runtime/agent'
import { buildSystemPrompt, buildActionPrompt } from '@/lib/browser-agent-runtime/prompts'
import { buildVisionParts } from '@/lib/browser-agent-runtime/vision-shared'
import type { BrowserFrameSnapshot } from '@/lib/browser-agent-runtime/browser'
import {
    BROWSER_AGENT_CAPABILITY_GROUPS,
    BROWSER_AGENT_EXECUTION_ACTIONS,
    getBrowserAgentPromptActions,
} from '@/lib/browser-agent-runtime/capabilities'
import { BROWSER_AGENT_CAPABILITY_HINT } from '@/lib/ai/agents/browser-agent-capabilities'
import { calculateBrowserScrollAxis } from '@/lib/browser-agent-runtime/scroll-state'

const {
    buildRequestConfig,
    parseAgentActionsFromModelText,
    parseIterationLimitReviewFromModelText,
    requestParsedJsonWithRetries,
} = browserVisionTestHooks

// One canonical manifest drives schema validation, the browser-model prompt,
// and the exact capability surface shown to the parent Orchestrator.
{
    const groupedActions = BROWSER_AGENT_CAPABILITY_GROUPS.flatMap(group => [...group.actions])
    assert.deepEqual(
        [...new Set(groupedActions)].sort(),
        [...BROWSER_AGENT_EXECUTION_ACTIONS].sort(),
        'every executable browser action should appear exactly once in the capability map',
    )
    assert.equal(groupedActions.length, new Set(groupedActions).size)
    for (const action of BROWSER_AGENT_EXECUTION_ACTIONS) {
        assert.ok(BROWSER_AGENT_CAPABILITY_HINT.includes(action), `Orchestrator capability hint is missing ${action}`)
    }
    assert.deepEqual(
        getBrowserAgentPromptActions({ escalationEnabled: false }).slice(0, BROWSER_AGENT_EXECUTION_ACTIONS.length),
        [...BROWSER_AGENT_EXECUTION_ACTIONS],
    )
}

{
    const middle = calculateBrowserScrollAxis(2_000, 6_000, 1_000)
    assert.equal(middle.progressPercent, 40)
    assert.equal(middle.visibleEnd, 3_000)
    assert.equal(middle.remaining, 3_000)
    assert.equal(middle.atStart, false)
    assert.equal(middle.atEnd, false)
}

const config = buildRequestConfig(
    { provider: 'google', model: 'gemini-smoke', thinkingLevel: 'low', mediaResolution: 'medium' },
    { systemInstruction: 'system', responseJsonSchema: { type: 'object' } },
) as Record<string, unknown>

assert.equal(config.responseMimeType, 'application/json')
assert.deepEqual(config.responseJsonSchema, { type: 'object' })
assert.equal(config.systemInstruction, 'system')

// xhigh degrades to high on the Gemini backend instead of being dropped.
const xhighConfig = buildRequestConfig(
    { provider: 'google', model: 'gemini-smoke', thinkingLevel: 'xhigh', mediaResolution: 'medium' },
) as Record<string, { thinkingLevel?: string }>
assert.equal(xhighConfig.thinkingConfig?.thinkingLevel, 'high')

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

const currentUrlAction = parseAgentActionsFromModelText(JSON.stringify({
    action: 'getCurrentUrl',
    reasoning: 'Read the exact current address-bar URL without navigating',
}))
assert.equal(currentUrlAction[0].action, 'getCurrentUrl')

const uploadAction = parseAgentActionsFromModelText(JSON.stringify({
    action: 'chooseFile',
    ref: 'e18',
    path: 'files/Clienti_Oblio_TEST.xls',
    reasoning: 'Use the visible chooser in the open import dialog',
}))
assert.equal(uploadAction[0].action, 'chooseFile')
assert.equal(uploadAction[0].path, 'files/Clienti_Oblio_TEST.xls')
assert.equal(uploadAction[0].ref, 'e18')

const dropAction = parseAgentActionsFromModelText(JSON.stringify({
    action: 'dropFiles',
    ref: 'e21',
    paths: ['files/Clienti.xls', 'files/Produse.xls'],
    reasoning: 'Drop the authorized files on the visible dropzone',
}))
assert.equal(dropAction[0].action, 'dropFiles')
assert.deepEqual(dropAction[0].paths, ['files/Clienti.xls', 'files/Produse.xls'])

const preciseActions = parseAgentActionsFromModelText(JSON.stringify([
    {
        action: 'click',
        ref: 'e7',
        button: 'right',
        modifiers: ['Shift'],
        reasoning: 'Open the exact element context menu',
    },
    {
        action: 'waitFor',
        waitFor: 'ref',
        ref: 'e8',
        waitState: 'visible',
        durationMs: 5_000,
        reasoning: 'Wait for the result control',
    },
    {
        action: 'uploadFile',
        ref: 'e9',
        paths: ['files/Clienti.xls', 'files/Produse.xls'],
        reasoning: 'Attach the validated batch atomically',
    },
    {
        action: 'downloadMedia',
        assetRef: 'a3',
        reasoning: 'Save the selected page image',
    },
]))
assert.equal(preciseActions[0].ref, 'e7')
assert.deepEqual(preciseActions[0].modifiers, ['Shift'])
assert.equal(preciseActions[1].waitFor, 'ref')
assert.deepEqual(preciseActions[2].paths, ['files/Clienti.xls', 'files/Produse.xls'])
assert.equal(preciseActions[3].assetRef, 'a3')

assert.throws(
    () => parseAgentActionsFromModelText('{ action: "click", reasoning: "bad JSON" }'),
    /Invalid JSON/,
)
assert.throws(
    () => parseAgentActionsFromModelText('{"action":"teleport","reasoning":"bad action"}'),
    /Invalid browser action/,
)

// Codex strict-schema shape: { actions: [...] } wrapper with nulls for unset
// optionals — wrapper unwrapped, nulls stripped.
const wrappedActions = parseAgentActionsFromModelText(JSON.stringify({
    actions: [{
        action: 'click',
        coordinate: [990, 540],
        coordinateEnd: null,
        text: null,
        submit: null,
        clearBefore: null,
        clickCount: null,
        key: null,
        scrollDirection: null,
        scrollAmount: null,
        url: null,
        tabIndex: null,
        path: null,
        sub_objective: null,
        reasoning: 'Click pixel target',
        memory: null,
        durationMs: null,
        expectedFilename: null,
    }],
}))
assert.equal(wrappedActions.length, 1)
assert.equal(wrappedActions[0].action, 'click')
assert.deepEqual(wrappedActions[0].coordinate, [990, 540])
assert.equal('text' in wrappedActions[0], false)
assert.equal('key' in wrappedActions[0], false)

// Codex output schema is strict-safe: object root, no anyOf at top level,
// every property required, no Gemini propertyOrdering.
{
    const schema = codexVisionTestHooks.CODEX_ACTION_RESPONSE_OUTPUT_SCHEMA as unknown as Record<string, unknown>
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, ['actions'])
    const actionsSchema = (schema.properties as Record<string, Record<string, unknown>>).actions
    const itemSchema = actionsSchema.items as Record<string, unknown>
    assert.equal(itemSchema.additionalProperties, false)
    const properties = Object.keys(itemSchema.properties as Record<string, unknown>)
    assert.deepEqual([...(itemSchema.required as string[])].sort(), [...properties].sort())
    assert.equal('propertyOrdering' in itemSchema, false)

    const reviewSchema = codexVisionTestHooks.CODEX_ITERATION_REVIEW_OUTPUT_SCHEMA as Record<string, unknown>
    assert.equal('propertyOrdering' in reviewSchema, false)
    assert.equal(reviewSchema.additionalProperties, false)
}

// Effort mapping + per-effort turn timeouts.
assert.equal(codexVisionTestHooks.mapEffortForCodex('minimal'), 'low')
assert.equal(codexVisionTestHooks.mapEffortForCodex('xhigh'), 'xhigh')
assert.equal(codexVisionTestHooks.mapEffortForCodex('max'), 'xhigh')
assert.equal(codexVisionTestHooks.turnTimeoutForEffort('xhigh'), 600_000)
assert.equal(codexVisionTestHooks.turnTimeoutForEffort('low'), 120_000)

// Coordinate resolution: pixel mode clamps, normalized mode scales /1000.
assert.deepEqual(browserAgentCoordinateTestHooks.denormalize([500, 500], 1980, 1080), [990, 540])
assert.deepEqual(browserAgentCoordinateTestHooks.clampToViewport([500.4, 1200], 1980, 1080), [500, 1079])
assert.deepEqual(browserAgentCoordinateTestHooks.clampToViewport([-5, 10], 1980, 1080), [0, 10])
assert.equal(
    browserAgentCoordinateTestHooks.hasRecentDiagnosticsForCurrentPage(
        [{ action: 'inspectDiagnostics', url: 'https://example.test/app#section', success: true }],
        'https://example.test/app',
    ),
    true,
)
assert.equal(
    browserAgentCoordinateTestHooks.hasRecentDiagnosticsForCurrentPage(
        [
            { action: 'inspectDiagnostics', url: 'https://example.test/app', success: true },
            { action: 'click', coordinate: [500, 500], success: true, reasoning: 'Try reload button' },
        ],
        'https://example.test/app',
    ),
    false,
)

// Dispatcher coordinate mode follows the provider; no backend is instantiated
// by getCoordinateMode/updateConfig alone (no API key needed here).
{
    const dispatcher = createVisionService({ provider: 'codex', model: 'gpt-5.5', thinkingLevel: 'low', mediaResolution: 'medium' })
    assert.equal(dispatcher.getCoordinateMode(), 'pixel')
    dispatcher.updateConfig({ provider: 'google' })
    assert.equal(dispatcher.getCoordinateMode(), 'normalized')
}

// Prompt coordinate-space branches: pixel prompt speaks pixels, normalized
// prompt stays byte-identical in its coordinate instructions.
{
    const pixelPrompt = buildSystemPrompt(false, 'pixel-viewport', true, { width: 1980, height: 1080 })
    assert.match(pixelPrompt, /PIXEL COORDINATES/)
    assert.match(pixelPrompt, /1980x1080/)
    assert.doesNotMatch(pixelPrompt, /1000x1000 grid/)

    const normalizedPrompt = buildSystemPrompt(false, 'normalized-viewport', true)
    assert.match(normalizedPrompt, /NORMALIZED COORDINATES \(0-1000 range\)/)
    assert.match(normalizedPrompt, /1000x1000 grid/)
    for (const action of getBrowserAgentPromptActions({ escalationEnabled: true })) {
        assert.ok(normalizedPrompt.includes(`"${action}"`), `browser system prompt is missing ${action}`)
    }

    const pixelActionPrompt = buildActionPrompt('goal', [], [], [], true, 'pixel-viewport')
    assert.match(pixelActionPrompt, /Output PIXEL COORDINATES/)
    const normalizedActionPrompt = buildActionPrompt('goal', [], [], [], true)
    assert.match(normalizedActionPrompt, /Estimate NORMALIZED COORDINATES \(0-1000\)/)

    const displayPrompt = buildSystemPrompt(false, 'pixel-display', true, { width: 1280, height: 720 })
    assert.match(displayPrompt, /full browser display/)
    assert.match(displayPrompt, /NOT a DOM full-page screenshot/)
    assert.doesNotMatch(displayPrompt, /full-page overview screenshot/)

    const displayActionPrompt = buildActionPrompt('goal', [], [], [], true, 'pixel-display')
    assert.match(displayActionPrompt, /final display frame/)

    const displayFrame: BrowserFrameSnapshot = {
        id: 'frame-display',
        source: 'agent',
        timestamp: '2026-06-21T00:00:00.000Z',
        imageBase64: 'ZmFrZQ==',
        url: 'https://example.test/',
        captureMode: 'viewport',
        coordinateSpace: 'normalized-display',
        viewport: { width: 1280, height: 720 },
        page: {
            measurement: 'dom',
            width: 1180,
            height: 6_000,
            viewportWidth: 1180,
            viewportHeight: 640,
            scrollX: 0,
            scrollY: 2_000,
        },
    }
    const displayParts = buildVisionParts('', '', 'act', displayFrame, null, [], 'pixel-display')
    assert.match(displayParts[0].text ?? '', /current display frame/)
    assert.match(displayParts[1].text ?? '', /Document vertical scroll: 37%/)
    assert.match(displayParts[1].text ?? '', /visible 2000-2640px of 6000px/)
    assert.match(displayParts[1].text ?? '', /below=3360px/)

    const unknownDisplayFrame: BrowserFrameSnapshot = {
        ...displayFrame,
        id: 'frame-display-unknown',
        page: {
            measurement: 'unavailable',
            width: null,
            height: null,
            viewportWidth: null,
            viewportHeight: null,
            scrollX: null,
            scrollY: null,
        },
    }
    const unknownParts = buildVisionParts('', '', 'act', unknownDisplayFrame, null, [], 'pixel-display')
    assert.match(unknownParts[1].text ?? '', /Document scroll: unknown/)
    assert.doesNotMatch(unknownParts[1].text ?? '', /Scroll: 0, 0/)
}

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
