/**
 * MANUAL live smoke for the Codex vision backend (consumes ChatGPT quota).
 *
 * Renders a synthetic 1980x1080 frame with a red square at a known position,
 * then drives the real `codex app-server` pipeline end-to-end:
 * spawn → initialize → thread/start → turn/start (localImage + outputSchema)
 * → parse → pixel-coordinate calibration check → dispose.
 *
 * Run: npx tsx scripts/smoke-browser-vision-codex-live.ts
 * Requires a logged-in Codex CLI. NOT part of `npm test`.
 */

import assert from 'node:assert/strict'
import sharp from 'sharp'

import { createCodexVisionService } from '@/lib/browser-agent-runtime/vision-codex'
import type { BrowserFrameSnapshot } from '@/lib/browser-agent-runtime/browser'

const WIDTH = 1980
const HEIGHT = 1080
const SQUARE = { x: 1500, y: 300, size: 80 }
const TOLERANCE_PX = 60

async function buildSyntheticFrame(): Promise<BrowserFrameSnapshot> {
    const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
        <text x="60" y="80" font-size="32" font-family="Arial" fill="#222">Calibration page</text>
        <rect x="${SQUARE.x - SQUARE.size / 2}" y="${SQUARE.y - SQUARE.size / 2}" width="${SQUARE.size}" height="${SQUARE.size}" fill="#d62828"/>
        <text x="${SQUARE.x}" y="${SQUARE.y + SQUARE.size}" font-size="24" font-family="Arial" fill="#222" text-anchor="middle">Submit</text>
    </svg>`

    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer()

    return {
        id: 'frame_calibration_1',
        source: 'agent',
        timestamp: new Date().toISOString(),
        imageBase64: jpeg.toString('base64'),
        url: 'https://calibration.local/test',
        captureMode: 'viewport',
        coordinateSpace: 'normalized-viewport',
        viewport: { width: WIDTH, height: HEIGHT },
        page: { width: WIDTH, height: HEIGHT, scrollX: 0, scrollY: 0 },
    } as BrowserFrameSnapshot
}

async function main() {
    const frame = await buildSyntheticFrame()
    const usages: Array<{ model: string; totalTokens: number; promptTokens: number; outputTokens: number }> = []
    const vision = createCodexVisionService(
        { model: 'gpt-5.5', thinkingLevel: 'low', mediaResolution: 'medium' },
        (usage) => usages.push(usage),
    )

    const startedAt = Date.now()
    try {
        const actions = await vision.analyzeScreenshot(
            frame,
            'Click the red square Submit button.',
            [],
            [],
            null,
            [],
            false,
            [],
            false,
            [],
            false,
        )
        const elapsedMs = Date.now() - startedAt
        console.log(`actions (${elapsedMs}ms):`, JSON.stringify(actions, null, 2))
        console.log('usage:', JSON.stringify(usages))

        assert.ok(actions.length >= 1, 'expected at least one action')
        const click = actions.find((a) => a.action === 'click')
        assert.ok(click, `expected a click action, got: ${actions.map(a => a.action).join(', ')}`)
        assert.ok(click!.coordinate, 'click action is missing coordinates')

        const [x, y] = click!.coordinate!
        const dx = Math.abs(x - SQUARE.x)
        const dy = Math.abs(y - SQUARE.y)
        console.log(`calibration: model clicked [${x}, ${y}], target [${SQUARE.x}, ${SQUARE.y}] (Δx=${dx}, Δy=${dy})`)

        // Pixel-space sanity: coordinates must be in viewport pixels, not 0-1000
        // normalized (1500 px target would be ~758 in normalized space).
        assert.ok(dx <= TOLERANCE_PX && dy <= TOLERANCE_PX,
            `click [${x}, ${y}] is outside ±${TOLERANCE_PX}px of the red square center [${SQUARE.x}, ${SQUARE.y}] — ` +
            'if it looks like ~[758, 278], the model answered in normalized 0-1000 space')

        assert.ok(usages.length >= 1 && usages[0].totalTokens > 0, 'expected nonzero token usage from thread/tokenUsage/updated')

        console.log('smoke-browser-vision-codex-live ok')
    } finally {
        await vision.dispose?.()
    }
}

main().catch((error) => {
    console.error('smoke-browser-vision-codex-live FAILED:', error)
    process.exitCode = 1
})
