import assert from 'node:assert/strict'

import { parseBrowserBackendPreference, resolveBrowserBackend } from '@/lib/browser-agent-backend'
import { buildActionPrompt, buildSystemPrompt, type ActionHistoryItem } from '@/lib/browser-agent-runtime/prompts'

assert.equal(parseBrowserBackendPreference('auto'), null)
assert.equal(parseBrowserBackendPreference('official_display'), null)
assert.equal(parseBrowserBackendPreference('patchright'), 'patchright')
assert.equal(parseBrowserBackendPreference('unknown'), null)

const darwinPatchright = resolveBrowserBackend({
    settingsValue: 'patchright',
    platform: 'darwin',
})
assert.equal(darwinPatchright.configured, 'patchright')
assert.equal(darwinPatchright.effective, 'patchright')
assert.equal(darwinPatchright.source, 'settings')

const defaultPatchright = resolveBrowserBackend({
    platform: 'darwin',
})
assert.equal(defaultPatchright.configured, 'patchright')
assert.equal(defaultPatchright.effective, 'patchright')
assert.equal(defaultPatchright.source, 'default')
assert.match(defaultPatchright.reason, /only browser backend/)

const tabLoopHistory: ActionHistoryItem[] = [
    { action: 'switchTab', tabIndex: 0, success: true, reasoning: 'Check UI tab' },
    { action: 'switchTab', tabIndex: 1, success: true, reasoning: 'Check API tab' },
    { action: 'switchTab', tabIndex: 0, success: true, reasoning: 'Check UI tab again' },
    { action: 'switchTab', tabIndex: 1, success: true, reasoning: 'Check API tab again' },
]
const tabLoopPrompt = buildActionPrompt('Diagnose a loading page.', tabLoopHistory)
assert.match(tabLoopPrompt, /LOOP DETECTED/)
assert.ok(
    tabLoopPrompt.includes('switchTab tab[0]') && tabLoopPrompt.includes('switchTab tab[1]'),
    tabLoopPrompt
)

const systemPrompt = buildSystemPrompt()
assert.match(systemPrompt, /Safe Container Scrolling/)
assert.match(systemPrompt, /Do not click a row\/card\/link\/button just to focus scrolling/)
assert.match(systemPrompt, /coordinate.*hover.*inert panel point/i)
assert.match(systemPrompt, /If the form or page is scrollable/)
assert.match(systemPrompt, /confirmation\/result screen/)

const normalizedDisplayPrompt = buildSystemPrompt(false, 'normalized-display')
assert.match(normalizedDisplayPrompt, /NORMALIZED COORDINATES \(0-1000 range\)/)
assert.match(normalizedDisplayPrompt, /full browser display, including tabs, address bar, toolbar, page content, popups, and context menus/)
assert.match(normalizedDisplayPrompt, /Native Browser UI/)
assert.match(normalizedDisplayPrompt, /1000x1000 grid system/)
assert.doesNotMatch(normalizedDisplayPrompt, /ABSOLUTE PIXEL COORDINATES/)

const unsafeScrollFocusPrompt = buildActionPrompt('Scroll a course list to Course 10.', [
    {
        action: 'click',
        coordinate: [520, 480],
        success: true,
        reasoning: "Click inside the 'Învățare Interactivă' list box to focus it so we can scroll down to find Cursul 10.",
    },
    {
        action: 'scroll',
        scrollDirection: 'down',
        scrollAmount: 500,
        success: true,
        reasoning: "Scroll down inside the 'Învățare Interactivă' container to find Curs nr. 10.",
    },
    {
        action: 'click',
        coordinate: [967, 43],
        success: true,
        reasoning: "We accidentally entered Course 1 instead of scrolling. Click 'Ieși' to return to the dashboard.",
    },
])
assert.match(unsafeScrollFocusPrompt, /UNSAFE SCROLL FOCUS PATTERN/)
assert.match(unsafeScrollFocusPrompt, /Do not click that list\/card area again/)
assert.match(unsafeScrollFocusPrompt, /scroll.*coordinate.*inert/i)

const urlHistoryPrompt = buildActionPrompt('Inspect API.', [
    {
        action: 'newTab',
        url: 'https://example.test/api/library/places',
        success: true,
        reasoning: 'Open API endpoint',
    },
])
assert.match(urlHistoryPrompt, /oldest to newest/)
assert.match(urlHistoryPrompt, /url="https:\/\/example\.test\/api\/library\/places"/)

console.log('smoke-browser-backend ok')
