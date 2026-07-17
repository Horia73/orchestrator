import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface ChildMessage {
    type: 'acquired' | 'released' | 'error'
    workerId: string
    error?: string
}

async function childMain() {
    const { acquireFleetRun } = await import('@/lib/ai/fleet-concurrency')
    const workerId = process.env.ORCHESTRATOR_AI_WORKER_ID || 'unknown'
    try {
        const permit = await acquireFleetRun({
            topLevel: true,
            provider: 'claude',
            limits: { total: 1, main: 1, provider: 1 },
        })
        process.send?.({ type: 'acquired', workerId } satisfies ChildMessage)
        await new Promise<void>(resolve => {
            process.once('message', message => {
                if (message === 'release') resolve()
            })
        })
        permit.dispose()
        process.send?.({ type: 'released', workerId } satisfies ChildMessage)
    } catch (error) {
        process.send?.({
            type: 'error',
            workerId,
            error: error instanceof Error ? error.stack || error.message : String(error),
        } satisfies ChildMessage)
        process.exitCode = 1
    } finally {
        process.disconnect?.()
    }
}

function spawnWorker(workerId: 'blue' | 'green', gatePath: string): ChildProcess {
    return fork(fileURLToPath(import.meta.url), [], {
        execArgv: ['--import', 'tsx'],
        env: {
            ...process.env,
            ORCHESTRATOR_FLEET_SMOKE_CHILD: '1',
            ORCHESTRATOR_AI_WORKER_PROCESS: '1',
            ORCHESTRATOR_AI_WORKER_ID: workerId,
            ORCHESTRATOR_AI_FLEET_GATE_PATH: gatePath,
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
}

function nextMessage(child: ChildProcess, timeoutMs = 5_000): Promise<ChildMessage> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for fleet smoke child.')), timeoutMs)
        child.once('message', raw => {
            clearTimeout(timer)
            const message = raw as ChildMessage
            if (message.type === 'error') reject(new Error(message.error || 'Fleet smoke child failed.'))
            else resolve(message)
        })
        child.once('exit', code => {
            if (code && code !== 0) {
                clearTimeout(timer)
                reject(new Error(`Fleet smoke child exited with ${code}.`))
            }
        })
    })
}

async function parentMain() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-fleet-gate-'))
    const gatePath = path.join(tempDir, 'fleet.db')
    let blue: ChildProcess | null = null
    let green: ChildProcess | null = null
    try {
        blue = spawnWorker('blue', gatePath)
        assert.deepEqual(await nextMessage(blue), { type: 'acquired', workerId: 'blue' })

        green = spawnWorker('green', gatePath)
        let greenAcquired = false
        const greenFirst = nextMessage(green).then(message => {
            greenAcquired = true
            return message
        })
        await new Promise(resolve => setTimeout(resolve, 350))
        assert.equal(greenAcquired, false, 'green bypassed the fleet-wide total/provider/main cap')

        blue.send('release')
        assert.deepEqual(await nextMessage(blue), { type: 'released', workerId: 'blue' })
        blue = null
        assert.deepEqual(await greenFirst, { type: 'acquired', workerId: 'green' })
        green.send('release')
        assert.deepEqual(await nextMessage(green), { type: 'released', workerId: 'green' })
        green = null
        console.log('AI fleet concurrency smoke passed')
    } finally {
        if (blue?.connected) blue.send('release')
        if (green?.connected) green.send('release')
        blue?.kill()
        green?.kill()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
}

if (process.env.ORCHESTRATOR_FLEET_SMOKE_CHILD === '1') {
    await childMain()
} else {
    await parentMain()
}
