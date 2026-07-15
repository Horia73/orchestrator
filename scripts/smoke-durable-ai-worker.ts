import assert from 'node:assert/strict'
import http from 'node:http'

const previousUrl = process.env.ORCHESTRATOR_AI_WORKER_URL
const previousRole = process.env.ORCHESTRATOR_AI_WORKER_PROCESS
const previousUpdateToken = process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN

async function main() {
    const received: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = []
    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(Buffer.from(chunk)))
        request.on('end', () => {
            received.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: Buffer.concat(chunks).toString('utf-8'),
            })
            response.writeHead(200, {
                'Content-Type': 'text/event-stream',
                Connection: 'keep-alive',
            })
            response.end('data: {"type":"done"}\n\n')
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
        const address = server.address()
        assert(address && typeof address === 'object')
        process.env.ORCHESTRATOR_AI_WORKER_URL = `http://127.0.0.1:${address.port}`
        process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN = 'durable-worker-smoke-token'
        delete process.env.ORCHESTRATOR_AI_WORKER_PROCESS

        const worker = await import('@/lib/ai/durable-worker')
        assert.equal(worker.shouldProxyToDurableAiWorker(), true)
        assert.equal(worker.ownsDurableAiBackgroundWork(), false)

        const response = await worker.proxyToDurableAiWorker(new Request(
            'https://orchestrator.example/api/chat?smoke=1',
            {
                method: 'POST',
                headers: {
                    host: 'orchestrator.example',
                    origin: 'https://orchestrator.example',
                    cookie: 'orchestrator_profile=profile-session',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ conversationId: 'smoke' }),
            },
        ))
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'data: {"type":"done"}\n\n')
        assert.equal(received.length, 1)
        assert.equal(received[0]?.url, '/api/chat?smoke=1')
        assert.equal(received[0]?.headers.host, `127.0.0.1:${address.port}`)
        assert.equal(received[0]?.headers['x-forwarded-host'], 'orchestrator.example')
        assert.equal(received[0]?.headers['x-forwarded-proto'], 'https')
        assert.equal(received[0]?.headers.cookie, 'orchestrator_profile=profile-session')
        assert.equal(received[0]?.body, JSON.stringify({ conversationId: 'smoke' }))

        process.env.ORCHESTRATOR_AI_WORKER_PROCESS = '1'
        assert.equal(worker.shouldProxyToDurableAiWorker(), false)
        assert.equal(worker.ownsDurableAiBackgroundWork(), true)

        const control = await import('@/app/api/internal/ai-worker/control/route')
        const controlRequest = (action: 'drain' | 'resume') => new Request(
            'http://127.0.0.1:3100/api/internal/ai-worker/control',
            {
                method: 'POST',
                headers: {
                    authorization: 'Bearer durable-worker-smoke-token',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ action }),
            },
        )
        const drained = await control.POST(controlRequest('drain'))
        assert.equal(drained.status, 200)
        assert.equal((await drained.json()).draining, true)
        const { registerAgentRun } = await import('@/lib/agent-runs')
        assert.equal(registerAgentRun({
            id: 'durable-worker-blocked-run',
            kind: 'scheduled',
            conversationId: 'durable-worker-smoke',
            startedAt: Date.now(),
        }), false)
        const resumed = await control.POST(controlRequest('resume'))
        assert.equal(resumed.status, 200)
        assert.equal((await resumed.json()).draining, false)
        console.log('durable AI worker smoke passed')
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        if (previousUrl === undefined) delete process.env.ORCHESTRATOR_AI_WORKER_URL
        else process.env.ORCHESTRATOR_AI_WORKER_URL = previousUrl
        if (previousRole === undefined) delete process.env.ORCHESTRATOR_AI_WORKER_PROCESS
        else process.env.ORCHESTRATOR_AI_WORKER_PROCESS = previousRole
        if (previousUpdateToken === undefined) delete process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN
        else process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN = previousUpdateToken
    }
}

await main()
