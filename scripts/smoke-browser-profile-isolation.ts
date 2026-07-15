import assert from 'node:assert/strict'

import {
    getBrowserSessionManager,
    shutdownActiveBrowserSessionManager,
    shutdownBrowserSessionManager,
} from '@/lib/ai/providers/browser-session-manager'
import { runWithProfileContext } from '@/lib/profiles/context'

async function main(): Promise<void> {
    const adminManager = runWithProfileContext(
        { profileId: 'admin_horia', role: 'admin' },
        () => getBrowserSessionManager(),
    )
    const sameAdminManager = runWithProfileContext(
        { profileId: 'admin_horia', role: 'admin' },
        () => getBrowserSessionManager(),
    )
    const memberManager = runWithProfileContext(
        { profileId: 'member_browser_smoke', role: 'member' },
        () => getBrowserSessionManager(),
    )

    assert.strictEqual(
        sameAdminManager,
        adminManager,
        'the same profile should reuse its browser manager and concurrency gate',
    )
    assert.notStrictEqual(
        memberManager,
        adminManager,
        'different profiles must own different browser managers, displays, and concurrency gates',
    )
    assert.equal(adminManager.profileId, 'admin_horia')
    assert.equal(memberManager.profileId, 'member_browser_smoke')

    await runWithProfileContext(
        { profileId: 'member_browser_smoke', role: 'member' },
        () => shutdownActiveBrowserSessionManager(),
    )
    const adminAfterMemberShutdown = runWithProfileContext(
        { profileId: 'admin_horia', role: 'admin' },
        () => getBrowserSessionManager(),
    )
    const memberAfterOwnShutdown = runWithProfileContext(
        { profileId: 'member_browser_smoke', role: 'member' },
        () => getBrowserSessionManager(),
    )
    assert.strictEqual(
        adminAfterMemberShutdown,
        adminManager,
        'shutting down one profile must not replace or interrupt another profile manager',
    )
    assert.notStrictEqual(
        memberAfterOwnShutdown,
        memberManager,
        'a profile-specific shutdown should replace only that profile manager',
    )

    await shutdownBrowserSessionManager()
    console.log('smoke-browser-profile-isolation ok')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
