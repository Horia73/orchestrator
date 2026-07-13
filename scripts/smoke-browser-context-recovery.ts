import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createBrowserManager } from '@/lib/browser-agent-runtime/browser'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-context-recovery-'))
const logs: string[] = []

async function main(): Promise<void> {
    const manager = await createBrowserManager({
        headless: true,
        liveView: false,
        userDataDir: path.join(root, 'profile'),
        downloadsDir: path.join(root, 'downloads'),
        onLog: (message) => logs.push(message),
    })

    try {
        await manager.launch()
        const originalContext = manager.getContext()
        assert.ok(originalContext, 'initial Patchright context should exist')
        await originalContext.addCookies([{
            name: 'orchestrator_recovery_smoke',
            value: 'preserved',
            domain: 'example.test',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 3_600,
        }])

        // Simulates the exact stale-context failure mode from a killed/hung
        // browser run: the manager stays alive while Chromium's context closes.
        await originalContext.close()

        const recoveredSession = await manager.createSession({
            id: 'recovered_session',
            startupUrl: 'data:text/html,<title>Recovered</title><p>browser recovered</p>',
        })
        const recoveredContext = manager.getContext()
        assert.ok(recoveredContext, 'browser action should relaunch a context')
        assert.notEqual(recoveredContext, originalContext, 'recovery should replace the closed context')
        assert.match(recoveredSession.getPageUrl(), /^data:text\/html,/)

        const cookies = await recoveredContext.cookies('https://example.test/')
        assert.equal(
            cookies.find((cookie) => cookie.name === 'orchestrator_recovery_smoke')?.value,
            'preserved',
            'persistent profile cookies should survive context recovery',
        )
        assert.ok(logs.some((line) => line.includes('next browser action will relaunch')))
        assert.ok(logs.some((line) => line.includes('Patchright Browser ready')))
    } finally {
        await manager.close()
        fs.rmSync(root, { recursive: true, force: true })
    }

    console.log('smoke-browser-context-recovery ok')
}

main().catch((error) => {
    fs.rmSync(root, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
})
