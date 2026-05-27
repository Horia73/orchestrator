import assert from 'node:assert/strict'

import { parseBrowserBackendPreference, resolveBrowserBackend } from '@/lib/browser-agent-backend'
import { buildActionPrompt, type ActionHistoryItem } from '@/lib/browser-agent-runtime/prompts'

assert.equal(parseBrowserBackendPreference('auto'), 'auto')
assert.equal(parseBrowserBackendPreference('official_display'), 'official-display')
assert.equal(parseBrowserBackendPreference('patchright'), 'patchright')
assert.equal(parseBrowserBackendPreference('unknown'), null)

const darwinAuto = resolveBrowserBackend({
    envValue: '',
    settingsValue: 'auto',
    platform: 'darwin',
})
assert.equal(darwinAuto.effective, 'patchright')
assert.equal(darwinAuto.source, 'settings')

const envForcedOfficial = resolveBrowserBackend({
    envValue: 'official-display',
    settingsValue: 'patchright',
    platform: 'darwin',
})
assert.equal(envForcedOfficial.configured, 'official-display')
assert.equal(envForcedOfficial.effective, 'official-display')
assert.equal(envForcedOfficial.source, 'env')
assert.equal(envForcedOfficial.envOverride, 'official-display')

const envForcedAuto = resolveBrowserBackend({
    envValue: 'auto',
    settingsValue: 'patchright',
    platform: 'darwin',
})
assert.equal(envForcedAuto.configured, 'auto')
assert.equal(envForcedAuto.effective, 'patchright')
assert.equal(envForcedAuto.source, 'env')

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
