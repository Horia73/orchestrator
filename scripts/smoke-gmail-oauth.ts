import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ToolExecutionContext } from '@/lib/ai/agents/types'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-smoke-gmail-oauth-'))
process.env.ORCHESTRATOR_STATE_DIR = stateDir
process.env.GOOGLE_OAUTH_CLIENT_ID = 'gmail-smoke.apps.googleusercontent.com'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gmail-smoke-secret'
delete process.env.GMAIL_OAUTH_REDIRECT_URI
delete process.env.GOOGLE_OAUTH_REDIRECT_URI
delete process.env.ORCHESTRATOR_PUBLIC_URL

process.on('exit', () => {
    fs.rmSync(stateDir, { recursive: true, force: true })
})

const [
    { executeGmailStartOAuth, executeGmailStatus },
    { getGoogleOAuthCallbackStateProvider },
    { INTEGRATION_MANIFEST },
    { getSubsystemManifest },
    { runWithProfileContext },
    { ADMIN_PROFILE_ID },
    { runtimePathsForProfile },
] = await Promise.all([
    import('@/lib/ai/tools/gmail'),
    import('@/lib/integrations/google-oauth-callback'),
    import('@/lib/integrations/manifest'),
    import('@/lib/integrations/subsystem-manifest'),
    import('@/lib/profiles/context'),
    import('@/lib/profiles/constants'),
    import('@/lib/runtime-paths'),
])

const origin = 'https://orchestrator.example.com'
const context = { appOrigin: origin } as ToolExecutionContext

await runWithProfileContext(
    { profileId: ADMIN_PROFILE_ID, role: 'admin' },
    async () => {
        const status = await executeGmailStatus({}, context)
        assert.equal(status.success, true)
        const statusData = status.data as { redirectUri?: string }
        assert.equal(
            statusData.redirectUri,
            `${origin}/api/integrations/google/oauth/callback`
        )

        const started = await executeGmailStartOAuth({}, context)
        assert.equal(started.success, true)
        const startData = started.data as { authUrl?: string; redirectUri?: string }
        assert.equal(
            startData.redirectUri,
            `${origin}/api/integrations/google/oauth/callback`
        )

        const authUrl = new URL(startData.authUrl ?? '')
        const state = authUrl.searchParams.get('state')
        assert.ok(state)
        assert.equal(authUrl.searchParams.get('redirect_uri'), startData.redirectUri)
        assert.equal(getGoogleOAuthCallbackStateProvider(state), 'gmail')
    }
)

const gmailManifest = INTEGRATION_MANIFEST.find((entry) => entry.id === 'gmail')
assert.deepEqual(gmailManifest?.setupToolIds, [
    'GmailStatus',
    'GmailConfigure',
    'GmailStartOAuth',
])
assert.ok(!gmailManifest?.operationalToolIds.includes('GmailStartOAuth'))

const setupManifest = getSubsystemManifest('setup')
for (const toolId of ['GmailStatus', 'GmailConfigure', 'GmailStartOAuth']) {
    assert.ok(setupManifest?.toolIds?.includes(toolId), `${toolId} is missing from setup`)
}

const paths = runtimePathsForProfile(ADMIN_PROFILE_ID)
assert.equal(fs.existsSync(path.join(paths.workspaceDir, 'tmp', 'gmail-oauth-start.json')), false)
assert.equal(fs.existsSync(path.join(paths.workspaceDir, 'tmp', 'gmail-oauth-session.cookie')), false)

console.log('Gmail OAuth setup tool and unified callback smoke test passed.')
