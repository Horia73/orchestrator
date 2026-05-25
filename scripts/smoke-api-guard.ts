import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'api-guard-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const { guardSensitiveRequest } = await import('@/lib/api/request-guard')
    const { shouldGuardApiRequest } = await import('../proxy')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
        if (!ok) failures++
    }

    const originalApiToken = process.env.ORCHESTRATOR_API_TOKEN
    const originalAccessToken = process.env.ORCHESTRATOR_ACCESS_TOKEN
    delete process.env.ORCHESTRATOR_API_TOKEN
    delete process.env.ORCHESTRATOR_ACCESS_TOKEN

    check(
        'public webhook ingress skips API guard',
        shouldGuardApiRequest('/api/webhooks/home-assistant-location', 'POST') === false,
    )
    check(
        'webhook management GET stays guarded',
        shouldGuardApiRequest('/api/webhooks/home-assistant-location', 'GET') === true,
    )
    check(
        'webhook subscription management stays guarded',
        shouldGuardApiRequest('/api/webhooks/home-assistant-location/subscriptions', 'POST') === true,
    )
    check(
        'webhook endpoint creation stays guarded',
        shouldGuardApiRequest('/api/webhooks', 'POST') === true,
    )

    const publicApiRequest = new Request('https://orchestrator.example.com/api/config', {
        headers: { host: 'orchestrator.example.com' },
    })
    const publicApiGuard = guardSensitiveRequest(publicApiRequest)
    check('public API request without token is blocked', publicApiGuard?.status === 403, publicApiGuard?.status)

    process.env.ORCHESTRATOR_API_TOKEN = 'smoke-api-token'
    const tokenGuard = guardSensitiveRequest(new Request('https://orchestrator.example.com/api/config', {
        headers: {
            host: 'orchestrator.example.com',
            'x-orchestrator-api-token': 'smoke-api-token',
        },
    }))
    check('X-Orchestrator-API-Token satisfies public API guard', tokenGuard === null, tokenGuard?.status)

    delete process.env.ORCHESTRATOR_API_TOKEN
    const forwardedMappedLoopbackGuard = guardSensitiveRequest(new Request('http://127.0.0.1:3000/api/config', {
        headers: {
            host: '127.0.0.1:3000',
            'x-forwarded-host': '127.0.0.1:3000',
            'x-forwarded-for': '::ffff:127.0.0.1',
            'x-forwarded-proto': 'http',
        },
    }))
    check(
        'forwarded mapped loopback client can use loopback host',
        forwardedMappedLoopbackGuard === null,
        forwardedMappedLoopbackGuard?.status,
    )

    const spoofedLoopbackGuard = guardSensitiveRequest(new Request('https://127.0.0.1:3000/api/config', {
        headers: {
            host: '127.0.0.1:3000',
            'x-forwarded-host': '127.0.0.1:3000',
            'x-forwarded-for': '203.0.113.9',
            'x-forwarded-proto': 'https',
        },
    }))
    check(
        'forwarded non-loopback client cannot claim loopback host',
        spoofedLoopbackGuard?.status === 403,
        spoofedLoopbackGuard?.status,
    )

    if (originalApiToken === undefined) delete process.env.ORCHESTRATOR_API_TOKEN
    else process.env.ORCHESTRATOR_API_TOKEN = originalApiToken
    if (originalAccessToken === undefined) delete process.env.ORCHESTRATOR_ACCESS_TOKEN
    else process.env.ORCHESTRATOR_ACCESS_TOKEN = originalAccessToken

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in API guard smoke test:', err)
    process.exit(2)
})
