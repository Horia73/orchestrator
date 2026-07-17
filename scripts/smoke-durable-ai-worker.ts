import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const previousUrl = process.env.ORCHESTRATOR_AI_WORKER_URL
const previousRole = process.env.ORCHESTRATOR_AI_WORKER_PROCESS
const previousUpdateToken = process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN
const previousRegistryPath = process.env.ORCHESTRATOR_AI_WORKER_REGISTRY_PATH
const previousWorkerId = process.env.ORCHESTRATOR_AI_WORKER_ID

async function main() {
    const received: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = []
    const greenReceived: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = []
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-worker-generations-'))
    const registryPath = path.join(tempDir, 'ai-worker-generations.json')
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
            if (request.url?.startsWith('/api/chat/active')) {
                const conversationId = new URL(request.url, 'http://worker').searchParams.get('conversationId')
                response.writeHead(200, { 'Content-Type': 'application/json' })
                response.end(JSON.stringify({
                    active: conversationId === 'old-conversation',
                    conversationId,
                    followUps: [],
                }))
                return
            }
            response.writeHead(200, {
                'Content-Type': 'text/event-stream',
                Connection: 'keep-alive',
            })
            if (request.url === '/api/sync') {
                // Deliberately split a single SSE frame across network writes:
                // the relay must reassemble it before merging web-local events.
                response.write('data: {"type":')
                setImmediate(() => response.end('"done"}\n\n'))
            } else {
                response.end('data: {"type":"done"}\n\n')
            }
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const greenServer = http.createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(Buffer.from(chunk)))
        request.on('end', () => {
            greenReceived.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: Buffer.concat(chunks).toString('utf-8'),
            })
            if (request.url?.startsWith('/api/chat/active')) {
                response.writeHead(200, { 'Content-Type': 'application/json' })
                response.end(JSON.stringify({ active: false, followUps: [] }))
                return
            }
            response.writeHead(200, {
                'Content-Type': 'text/event-stream',
                Connection: 'keep-alive',
            })
            response.end('data: {"type":"green"}\n\n')
        })
    })
    await new Promise<void>(resolve => greenServer.listen(0, '127.0.0.1', resolve))

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

        const relayedFrames: Uint8Array[] = []
        const relayed = await worker.relayDurableAiWorkerEventStream(
            new Request('https://orchestrator.example/api/sync', {
                headers: {
                    host: 'orchestrator.example',
                    cookie: 'orchestrator_profile=profile-session',
                },
            }),
            frame => relayedFrames.push(frame),
        )
        assert.equal(relayed, true)
        assert.equal(
            Buffer.concat(relayedFrames.map(frame => Buffer.from(frame))).toString('utf-8'),
            'data: {"type":"done"}\n\n',
        )
        assert.equal(relayedFrames.length, 1)
        assert.equal(received.length, 2)
        assert.equal(received[1]?.method, 'GET')
        assert.equal(received[1]?.url, '/api/sync')
        assert.equal(received[1]?.headers.cookie, 'orchestrator_profile=profile-session')

        const greenAddress = greenServer.address()
        assert(greenAddress && typeof greenAddress === 'object')
        fs.writeFileSync(registryPath, JSON.stringify({
            protocolVersion: 1,
            current: {
                id: 'green',
                service: 'ai-worker-green',
                url: `http://127.0.0.1:${greenAddress.port}`,
                buildCommit: 'new-code',
            },
            draining: [{
                id: 'blue',
                service: 'ai-worker',
                url: `http://127.0.0.1:${address.port}`,
                buildCommit: 'old-code',
            }],
            backgroundOwner: null,
            updatedAt: Date.now(),
        }))
        process.env.ORCHESTRATOR_AI_WORKER_REGISTRY_PATH = registryPath

        const generationResponse = await worker.proxyToDurableAiWorker(new Request(
            'https://orchestrator.example/api/chat?generation=smoke',
            { method: 'POST', body: JSON.stringify({ conversationId: 'new-conversation' }) },
        ))
        assert.equal(generationResponse.headers.get('x-orchestrator-ai-worker'), 'green')
        assert.equal(await generationResponse.text(), 'data: {"type":"green"}\n\n')
        assert.equal(greenReceived.at(-1)?.headers['x-orchestrator-ai-worker-generation'], 'green')

        const activeResponse = await worker.durableAiFleetActiveChatResponse(new Request(
            'https://orchestrator.example/api/chat/active?conversationId=old-conversation',
        ))
        assert.deepEqual(await activeResponse.json(), {
            active: true,
            conversationId: 'old-conversation',
            followUps: [],
            workerId: 'blue',
        })
        const stopResponse = await worker.proxyToConversationOwner(new Request(
            'https://orchestrator.example/api/chat/stop',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ conversationId: 'old-conversation' }),
            },
        ), 'old-conversation')
        assert.equal(stopResponse.headers.get('x-orchestrator-ai-worker'), 'blue')
        assert.equal(received.at(-1)?.url, '/api/chat/stop')

        // The fleet EventSource must listen to both generations at once, so an
        // old completion and a new-code turn can update the same browser.
        const fleetFrames: string[] = []
        const fleetController = new AbortController()
        const fleetRelay = worker.relayDurableAiWorkerFleetEventStreams(
            new Request('https://orchestrator.example/api/sync', {
                headers: { cookie: 'orchestrator_profile=profile-session' },
            }),
            frame => fleetFrames.push(Buffer.from(frame).toString('utf-8')),
            fleetController.signal,
        )
        const relayDeadline = Date.now() + 3_000
        while (
            Date.now() < relayDeadline
            && (!fleetFrames.some(frame => frame.includes('"done"'))
                || !fleetFrames.some(frame => frame.includes('"green"')))
        ) {
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        fleetController.abort()
        await fleetRelay
        assert(fleetFrames.some(frame => frame.includes('"done"')), JSON.stringify(fleetFrames))
        assert(fleetFrames.some(frame => frame.includes('"green"')), JSON.stringify(fleetFrames))

        // Returning to the single-process control assertions must not inherit
        // the web fleet registry from the preceding routing checks.
        delete process.env.ORCHESTRATOR_AI_WORKER_REGISTRY_PATH

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
        await new Promise<void>((resolve, reject) => greenServer.close(error => error ? reject(error) : resolve()))
        fs.rmSync(tempDir, { recursive: true, force: true })
        if (previousUrl === undefined) delete process.env.ORCHESTRATOR_AI_WORKER_URL
        else process.env.ORCHESTRATOR_AI_WORKER_URL = previousUrl
        if (previousRole === undefined) delete process.env.ORCHESTRATOR_AI_WORKER_PROCESS
        else process.env.ORCHESTRATOR_AI_WORKER_PROCESS = previousRole
        if (previousUpdateToken === undefined) delete process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN
        else process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN = previousUpdateToken
        if (previousRegistryPath === undefined) delete process.env.ORCHESTRATOR_AI_WORKER_REGISTRY_PATH
        else process.env.ORCHESTRATOR_AI_WORKER_REGISTRY_PATH = previousRegistryPath
        if (previousWorkerId === undefined) delete process.env.ORCHESTRATOR_AI_WORKER_ID
        else process.env.ORCHESTRATOR_AI_WORKER_ID = previousWorkerId
    }
}

await main()
