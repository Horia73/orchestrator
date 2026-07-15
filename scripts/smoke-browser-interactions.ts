import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createBrowserManager } from '@/lib/browser-agent-runtime/browser'
import { browserAgentPauseKindFromContent } from '@/lib/browser-agent-run-state'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-interactions-'))
const workspaceDir = path.join(root, 'workspace')
fs.mkdirSync(workspaceDir, { recursive: true })

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const pngBytes = Buffer.from(pngDataUrl.split(',')[1], 'base64')

async function listen(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '0.0.0.0', () => {
            const address = server.address()
            if (!address || typeof address === 'string') return reject(new Error('missing test server address'))
            resolve(address.port)
        })
    })
}

async function main(): Promise<void> {
    assert.equal(browserAgentPauseKindFromContent('Session status: awaiting_user\nFinal action: ask'), 'takeover')
    assert.equal(browserAgentPauseKindFromContent('Session status: awaiting_user\nFinal action: checkpoint'), 'checkpoint')
    assert.equal(browserAgentPauseKindFromContent('Session status: completed\nFinal action: ask'), 'none')

    let port = 0
    const server = http.createServer((request, response) => {
        if (request.url === '/pixel.png') {
            response.setHeader('content-type', 'image/png')
            response.setHeader('content-length', String(pngBytes.length))
            response.end(pngBytes)
            return
        }
        if (request.url === '/frame') {
            response.setHeader('content-type', 'text/html')
            response.end([
                '<button id="frame-button" onclick="document.querySelector(\'#frame-result\').textContent=\'clicked\'">Framed action</button>',
                '<output id="frame-result"></output>',
            ].join(''))
            return
        }
        response.setHeader('content-type', 'text/html')
        response.end([
            '<button id="inspect-button" onclick="document.querySelector(\'#click-result\').textContent=event.shiftKey?\'shift\':\'plain\'">Inspect target</button>',
            '<output id="click-result"></output>',
            '<label for="name">Name</label><input id="name" value="old">',
            '<input id="secret" type="password" value="must-not-leak">',
            '<label for="choice">Choice</label><select id="choice"><option value="one">One</option><option value="two">Two</option></select>',
            '<label for="accept">Accept</label><input id="accept" type="checkbox">',
            `<img id="pixel" alt="Pixel asset" src="http://127.0.0.1:${port}/pixel.png" onclick="void 0">`,
            '<div id="shadow-host"></div>',
            `<iframe title="cross-origin controls" src="http://localhost:${port}/frame"></iframe>`,
            '<script>',
            'const root=document.querySelector("#shadow-host").attachShadow({mode:"open"});',
            'root.innerHTML="<button id=shadow-button>Shadow action</button>";',
            'setTimeout(()=>{const ready=document.createElement("div");ready.id="ready";ready.textContent="Target ready";document.body.appendChild(ready);location.hash="ready"},150);',
            '</script>',
        ].join(''))
    })
    port = await listen(server)

    const manager = await createBrowserManager({
        headless: true,
        liveView: false,
        userDataDir: path.join(root, 'profile'),
        downloadsDir: path.join(workspaceDir, 'browser-downloads'),
        workspaceDir,
    })

    try {
        await manager.launch()
        const session = await manager.createSession({ startupUrl: `http://127.0.0.1:${port}/` })
        for (const frame of session.getPage()?.frames() || []) {
            await frame.evaluate('globalThis.__name ||= ((value) => value)')
        }

        const read = await session.readPage()
        assert.equal(read.supported, true, read.error)
        const shadowButton = read.elements.find(element => element.name === 'Shadow action')
        assert.ok(shadowButton, 'readPage should traverse open shadow roots')
        const frameButton = read.elements.find(element => element.name === 'Framed action')
        assert.ok(frameButton, 'readPage should traverse child frames')
        assert.match(frameButton.frame || '', /frame/i)
        const password = read.elements.find(element => element.role === 'input:password')
        assert.ok(password)
        assert.notEqual(password.name, 'must-not-leak')
        assert.equal(password.value, undefined)

        const frameClick = await session.clickRef(frameButton.ref)
        assert.equal(frameClick.success, true, frameClick.error)
        const childFrame = session.getPage()?.frames().find(frame => frame.url().includes('/frame'))
        assert.equal(await childFrame?.locator('#frame-result').textContent(), 'clicked')

        const inspectButton = read.elements.find(element => element.name === 'Inspect target')
        assert.ok(inspectButton)
        const inspectHandle = session.getPage()?.locator('#inspect-button')
        const inspectBox = await inspectHandle?.boundingBox()
        assert.ok(inspectBox)
        const inspection = await session.inspectAt(inspectBox.x + inspectBox.width / 2, inspectBox.y + inspectBox.height / 2)
        assert.equal(inspection.success, true, inspection.error)
        assert.equal(inspection.element?.name, 'Inspect target')

        const modifiedClick = await session.clickRef(inspectButton.ref, { modifiers: ['Shift'] })
        assert.equal(modifiedClick.success, true, modifiedClick.error)
        assert.equal(await session.getPage()?.locator('#click-result').textContent(), 'shift')

        const input = read.elements.find(element => element.name === 'Name')
        assert.ok(input)
        assert.equal((await session.clickRef(input.ref)).success, true)
        await session.clear()
        await session.type('replacement')
        assert.equal(await session.getPage()?.locator('#name').inputValue(), 'replacement')

        const select = read.elements.find(element => element.name === 'Choice')
        assert.ok(select)
        const selected = await session.selectOption(select.ref, ['Two'])
        assert.equal(selected.success, true, selected.error)
        assert.equal(await session.getPage()?.locator('#choice').inputValue(), 'two')

        const checkbox = read.elements.find(element => element.name === 'Accept')
        assert.ok(checkbox)
        const checked = await session.setChecked(checkbox.ref, true)
        assert.equal(checked.success, true, checked.error)
        assert.equal(await session.getPage()?.locator('#accept').isChecked(), true)

        const textWait = await session.waitFor({ kind: 'text', text: 'Target ready', state: 'visible', timeoutMs: 3_000 })
        assert.equal(textWait.success, true, textWait.observation)
        const urlWait = await session.waitFor({ kind: 'url', url: '#ready', timeoutMs: 3_000 })
        assert.equal(urlWait.success, true, urlWait.observation)

        const assets = await session.listPageAssets()
        assert.equal(assets.supported, true, assets.error)
        const pixelAsset = assets.assets.find(asset => asset.kind === 'image' && asset.name === 'Pixel asset')
        assert.ok(pixelAsset, 'listPageAssets should inventory visible images')
        const media = await session.downloadMedia({ assetRef: pixelAsset.ref })
        assert.equal(media.success, true, media.error)
        assert.equal(media.download?.state, 'saved')
        assert.ok(media.download?.savedPath && fs.existsSync(media.download.savedPath))
        assert.ok((media.download?.size || 0) > 0)

        await session.navigate(`http://127.0.0.1:${port}/#fresh-page`)
        const staleAsset = await session.downloadMedia({ assetRef: pixelAsset.ref })
        assert.equal(staleAsset.success, false)
        assert.equal(staleAsset.stale, true)
    } finally {
        await manager.close()
        await new Promise<void>(resolve => server.close(() => resolve()))
        fs.rmSync(root, { recursive: true, force: true })
    }

    console.log('smoke-browser-interactions ok')
}

main().catch((error) => {
    fs.rmSync(root, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
})
