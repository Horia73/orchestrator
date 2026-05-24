import assert from 'node:assert/strict'

import { parseBrowserBackendPreference, resolveBrowserBackend } from '@/lib/browser-agent-backend'

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

console.log('smoke-browser-backend ok')
