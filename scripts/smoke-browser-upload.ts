import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createBrowserManager } from '@/lib/browser-agent-runtime/browser'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-'))
const workspaceDir = path.join(root, 'workspace')
const inputDir = path.join(workspaceDir, 'files')
const inputPath = path.join(inputDir, 'Clienti_Oblio_TEST.xls')
const secondBatchPath = path.join(inputDir, 'Produse_Oblio_TEST.xls')
const outsidePath = path.join(root, 'outside-secret.txt')
const secondWorkspaceDir = path.join(root, 'second-workspace')
const secondInputPath = path.join(secondWorkspaceDir, 'files', 'Produse_Oblio_TEST.xls')

fs.mkdirSync(inputDir, { recursive: true })
fs.mkdirSync(path.dirname(secondInputPath), { recursive: true })
fs.writeFileSync(inputPath, 'test workbook bytes')
fs.writeFileSync(secondBatchPath, 'second workbook bytes')
fs.writeFileSync(secondInputPath, 'second profile workbook bytes')
fs.writeFileSync(outsidePath, 'must not leave the workspace')

async function main(): Promise<void> {
    const manager = await createBrowserManager({
        headless: true,
        liveView: false,
        userDataDir: path.join(root, 'profile'),
        downloadsDir: path.join(workspaceDir, 'browser-downloads'),
        workspaceDir,
    })

    try {
        await manager.launch()
        const html = [
            '<title>Hidden upload smoke</title>',
            '<label for="workbook">Import workbook</label>',
            '<input id="workbook" name="workbook" type="file" style="display:none">',
            '<output id="selected"></output>',
            '<label for="batch">Import batch</label>',
            '<input id="batch" name="batch" type="file" multiple style="display:none">',
            '<output id="batch-selected"></output>',
            '<label for="category">Category</label>',
            '<select id="category"><option value="">Choose</option><option value="food">Food</option></select>',
            '<label><input id="enabled" type="checkbox"> Enabled</label>',
            '<button id="load-result">Load result</button>',
            '<div id="result" hidden>Ready now</div>',
            '<img alt="pixel asset" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">',
            '<div id="shadow-host"></div>',
            '<iframe srcdoc="<button>Framed action</button>"></iframe>',
            '<script>',
            'document.querySelector("#workbook").addEventListener("change", (event) => {',
            'document.querySelector("#selected").textContent = event.target.files[0]?.name || "";',
            '});',
            'document.querySelector("#batch").addEventListener("change", (event) => {',
            'document.querySelector("#batch-selected").textContent = Array.from(event.target.files).map(file => file.name).join(",");',
            '});',
            'document.querySelector("#load-result").addEventListener("click", () => { document.querySelector("#result").hidden = false; });',
            'document.querySelector("#shadow-host").attachShadow({ mode: "open" }).innerHTML = "<button>Shadow action</button>";',
            '</script>',
        ].join('')
        const session = await manager.createSession({
            id: 'hidden_upload',
            startupUrl: `data:text/html,${encodeURIComponent(html)}`,
            workspaceDir,
        })
        // tsx/esbuild annotates nested functions serialized into page.evaluate
        // with its small __name helper; the Next.js runtime supplies it during
        // normal app execution, so mirror that helper in this direct smoke run.
        for (const frame of session.getPage()?.frames() || []) {
            await frame.evaluate('globalThis.__name ||= ((value) => value)')
        }

        const pageElements = await session.readPage()
        assert.equal(pageElements.supported, true, pageElements.error)
        const fileInput = pageElements.elements.find((element) => element.role === 'input:file' && element.name === 'Import workbook')
        assert.ok(fileInput, 'readPage should expose a hidden input[type=file]')
        assert.equal(fileInput.inViewport, false)
        const batchInput = pageElements.elements.find((element) => element.role === 'input:file' && element.name === 'Import batch')
        assert.ok(batchInput, 'readPage should expose the hidden multiple input[type=file]')
        assert.equal(batchInput.multiple, true)

        const upload = await session.uploadFile('files/Clienti_Oblio_TEST.xls', fileInput.ref)
        assert.equal(upload.success, true, upload.error)
        assert.equal(upload.path, 'files/Clienti_Oblio_TEST.xls')
        assert.equal(upload.filename, 'Clienti_Oblio_TEST.xls')
        assert.equal(
            await session.getPage()?.locator('#selected').textContent(),
            'Clienti_Oblio_TEST.xls',
            'setInputFiles should trigger the page change handler without an OS picker',
        )

        const batchUpload = await session.uploadFile(
            ['files/Clienti_Oblio_TEST.xls', 'files/Produse_Oblio_TEST.xls'],
            batchInput.ref,
        )
        assert.equal(batchUpload.success, true, batchUpload.error)
        assert.deepEqual(batchUpload.paths, ['files/Clienti_Oblio_TEST.xls', 'files/Produse_Oblio_TEST.xls'])
        assert.deepEqual(batchUpload.filenames, ['Clienti_Oblio_TEST.xls', 'Produse_Oblio_TEST.xls'])
        assert.equal(
            await session.getPage()?.locator('#batch-selected').textContent(),
            'Clienti_Oblio_TEST.xls,Produse_Oblio_TEST.xls',
        )

        const rejectedMultiple = await session.uploadFile(
            ['files/Clienti_Oblio_TEST.xls', 'files/Produse_Oblio_TEST.xls'],
            fileInput.ref,
        )
        assert.equal(rejectedMultiple.success, false)
        assert.match(rejectedMultiple.error || '', /does not accept multiple files/i)
        assert.equal(await session.getPage()?.locator('#selected').textContent(), 'Clienti_Oblio_TEST.xls')

        const rejectedAtomicBatch = await session.uploadFile(
            ['files/Clienti_Oblio_TEST.xls', 'files/missing.xls'],
            batchInput.ref,
        )
        assert.equal(rejectedAtomicBatch.success, false)
        assert.match(rejectedAtomicBatch.error || '', /not found/i)
        assert.equal(
            await session.getPage()?.locator('#batch-selected').textContent(),
            'Clienti_Oblio_TEST.xls,Produse_Oblio_TEST.xls',
            'an invalid batch must not partially replace the input selection',
        )

        const escapedUpload = await session.uploadFile(outsidePath, fileInput.ref)
        assert.equal(escapedUpload.success, false)
        assert.match(escapedUpload.error || '', /inside the active profile workspace/i)

        const category = pageElements.elements.find((element) => element.name === 'Category')
        const enabled = pageElements.elements.find((element) => element.role === 'checkbox')
        const loadResult = pageElements.elements.find((element) => element.name === 'Load result')
        assert.ok(category && enabled && loadResult, 'readPage should expose native form controls')
        assert.equal((await session.selectOption(category.ref, ['Food'])).success, true)
        assert.equal(await session.getPage()?.locator('#category').inputValue(), 'food')
        assert.equal((await session.setChecked(enabled.ref, true)).success, true)
        assert.equal(await session.getPage()?.locator('#enabled').isChecked(), true)
        assert.equal((await session.clickRef(loadResult.ref)).success, true)
        assert.equal(
            (await session.waitFor({ kind: 'text', text: 'Ready now', state: 'visible', timeoutMs: 2_000 })).success,
            true,
        )
        assert.ok(pageElements.elements.some((element) => element.name === 'Shadow action'))
        assert.ok(pageElements.elements.some((element) => element.name === 'Framed action' && element.frame !== 'main'))

        const categoryBox = await session.getPage()?.locator('#category').boundingBox()
        assert.ok(categoryBox)
        const inspected = await session.inspectAt(
            categoryBox.x + categoryBox.width / 2,
            categoryBox.y + categoryBox.height / 2,
        )
        assert.equal(inspected.success, true, inspected.error)
        assert.equal(inspected.element?.tag, 'select')

        const assets = await session.listPageAssets()
        assert.equal(assets.supported, true, assets.error)
        const pixelAsset = assets.assets.find((asset) => asset.name === 'pixel asset')
        assert.ok(pixelAsset, 'listPageAssets should expose the page image')
        const mediaDownload = await session.downloadMedia({ assetRef: pixelAsset.ref })
        assert.equal(mediaDownload.success, true, mediaDownload.error)
        assert.equal(mediaDownload.download?.state, 'saved')
        assert.ok(mediaDownload.download?.savedPath && fs.existsSync(mediaDownload.download.savedPath))

        const secondSession = await manager.createSession({
            id: 'second_profile_upload',
            startupUrl: `data:text/html,${encodeURIComponent([
                '<label for="workbook">Import workbook</label>',
                '<input id="workbook" name="workbook" type="file" style="display:none">',
            ].join(''))}`,
            workspaceDir: secondWorkspaceDir,
        })
        const secondUpload = await secondSession.uploadFile('files/Produse_Oblio_TEST.xls')
        assert.equal(secondUpload.success, true, secondUpload.error)
        assert.equal(secondUpload.path, 'files/Produse_Oblio_TEST.xls')

        const crossProfileUpload = await secondSession.uploadFile(inputPath)
        assert.equal(crossProfileUpload.success, false)
        assert.match(crossProfileUpload.error || '', /inside the active profile workspace/i)
    } finally {
        await manager.close()
        fs.rmSync(root, { recursive: true, force: true })
    }

    console.log('smoke-browser-upload ok')
}

main().catch((error) => {
    fs.rmSync(root, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
})
