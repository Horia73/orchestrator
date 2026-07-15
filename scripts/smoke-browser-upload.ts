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
            '<title>UI-first upload smoke</title>',
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
            '<button id="open-import">Open client import</button>',
            '<section id="import-dialog" role="dialog" hidden>',
            '<h2>Client import</h2>',
            '<button id="choose-dialog-file">Choose client workbook</button>',
            '<input id="dialog-file" name="dialog-file" type="file" style="display:none">',
            '<output id="dialog-selected"></output>',
            '</section>',
            ...Array.from({ length: 10 }, (_, index) => [
                `<button id="choose-slot-${index + 1}">Choose slot ${index + 1}</button>`,
                `<input id="slot-${index + 1}" type="file" style="display:none">`,
                `<output id="slot-result-${index + 1}"></output>`,
            ]).flat(),
            '<button id="choose-dynamic">Choose dynamic file</button>',
            '<output id="dynamic-selected"></output>',
            '<div id="dropzone" role="button" tabindex="0" style="width:240px;height:60px;border:1px solid">Drop workbook here</div>',
            '<output id="dropped"></output>',
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
            'document.querySelector("#open-import").addEventListener("click", () => { document.querySelector("#import-dialog").hidden = false; });',
            'document.querySelector("#choose-dialog-file").addEventListener("click", () => document.querySelector("#dialog-file").click());',
            'document.querySelector("#dialog-file").addEventListener("change", (event) => { document.querySelector("#dialog-selected").textContent = event.target.files[0]?.name || ""; });',
            ...Array.from({ length: 10 }, (_, index) => {
                const slot = index + 1
                return `document.querySelector("#choose-slot-${slot}").addEventListener("click", () => document.querySelector("#slot-${slot}").click());document.querySelector("#slot-${slot}").addEventListener("change", (event) => { document.querySelector("#slot-result-${slot}").textContent = event.target.files[0]?.name || ""; });`
            }),
            'document.querySelector("#choose-dynamic").addEventListener("click", () => { const input = document.createElement("input"); input.type = "file"; input.addEventListener("change", (event) => { document.querySelector("#dynamic-selected").textContent = event.target.files[0]?.name || ""; input.remove(); }); document.body.appendChild(input); input.click(); });',
            'document.querySelector("#dropzone").addEventListener("dragover", (event) => event.preventDefault());',
            'document.querySelector("#dropzone").addEventListener("drop", (event) => { event.preventDefault(); document.querySelector("#dropped").textContent = Array.from(event.dataTransfer.files).map(file => file.name).join(","); });',
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
        assert.equal(batchInput.uploadReady, true)
        assert.equal(
            pageElements.elements.some((element) => element.role === 'input:file' && element.name === 'dialog-file'),
            false,
            'readPage must not expose a dormant file input inside a closed dialog',
        )

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

        const openImport = pageElements.elements.find((element) => element.name === 'Open client import')
        assert.ok(openImport)
        assert.equal((await session.clickRef(openImport.ref)).success, true)
        const openDialogElements = await session.readPage()
        const dialogChooser = openDialogElements.elements.find((element) => element.name === 'Choose client workbook')
        const dialogInput = openDialogElements.elements.find((element) => element.role === 'input:file' && element.name === 'dialog-file')
        assert.ok(dialogChooser && dialogInput, 'opening the visible dialog should expose its chooser and upload-ready input')
        assert.equal(dialogInput.uploadReady, true)
        const chooserUpload = await session.chooseFile('files/Clienti_Oblio_TEST.xls', { ref: dialogChooser.ref }, 2_000)
        assert.equal(chooserUpload.success, true, chooserUpload.error)
        assert.equal(chooserUpload.method, 'chooser')
        assert.equal(await session.getPage()?.locator('#dialog-selected').textContent(), 'Clienti_Oblio_TEST.xls')

        const manyInputElements = await session.readPage()
        const slotSevenChooser = manyInputElements.elements.find((element) => element.name === 'Choose slot 7')
        assert.ok(slotSevenChooser)
        const slotUpload = await session.chooseFile('files/Produse_Oblio_TEST.xls', { ref: slotSevenChooser.ref }, 2_000)
        assert.equal(slotUpload.success, true, slotUpload.error)
        assert.equal(await session.getPage()?.locator('#slot-result-7').textContent(), 'Produse_Oblio_TEST.xls')
        for (const slot of [1, 2, 3, 4, 5, 6, 8, 9, 10]) {
            assert.equal(await session.getPage()?.locator(`#slot-result-${slot}`).textContent(), '')
        }

        const dynamicElements = await session.readPage()
        const dynamicChooser = dynamicElements.elements.find((element) => element.name === 'Choose dynamic file')
        assert.ok(dynamicChooser)
        const dynamicUpload = await session.chooseFile('files/Clienti_Oblio_TEST.xls', { ref: dynamicChooser.ref }, 2_000)
        assert.equal(dynamicUpload.success, true, dynamicUpload.error)
        assert.equal(await session.getPage()?.locator('#dynamic-selected').textContent(), 'Clienti_Oblio_TEST.xls')

        const dropElements = await session.readPage()
        const dropzone = dropElements.elements.find((element) => element.name === 'Drop workbook here')
        assert.ok(dropzone)
        const dropped = await session.dropFiles(
            ['files/Clienti_Oblio_TEST.xls', 'files/Produse_Oblio_TEST.xls'],
            dropzone.ref,
        )
        assert.equal(dropped.success, true, dropped.error)
        assert.equal(dropped.method, 'drop')
        assert.equal(await session.getPage()?.locator('#dropped').textContent(), 'Clienti_Oblio_TEST.xls,Produse_Oblio_TEST.xls')

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

        const rejectedEmptyBatchPath = await session.uploadFile(
            ['files/Clienti_Oblio_TEST.xls', ''],
            batchInput.ref,
        )
        assert.equal(rejectedEmptyBatchPath.success, false)
        assert.match(rejectedEmptyBatchPath.error || '', /non-empty/i)
        assert.equal(
            await session.getPage()?.locator('#batch-selected').textContent(),
            'Clienti_Oblio_TEST.xls,Produse_Oblio_TEST.xls',
            'an empty item must reject the complete batch before attachment',
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
        for (const frame of secondSession.getPage()?.frames() || []) {
            await frame.evaluate('globalThis.__name ||= ((value) => value)')
        }
        const secondElements = await secondSession.readPage()
        const secondInput = secondElements.elements.find((element) => element.role === 'input:file')
        assert.ok(secondInput)
        const secondUpload = await secondSession.uploadFile('files/Produse_Oblio_TEST.xls', secondInput.ref)
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
