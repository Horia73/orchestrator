import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createBrowserManager } from '@/lib/browser-agent-runtime/browser'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-'))
const workspaceDir = path.join(root, 'workspace')
const inputDir = path.join(workspaceDir, 'files')
const inputPath = path.join(inputDir, 'Clienti_Oblio_TEST.xls')
const outsidePath = path.join(root, 'outside-secret.txt')
const secondWorkspaceDir = path.join(root, 'second-workspace')
const secondInputPath = path.join(secondWorkspaceDir, 'files', 'Produse_Oblio_TEST.xls')

fs.mkdirSync(inputDir, { recursive: true })
fs.mkdirSync(path.dirname(secondInputPath), { recursive: true })
fs.writeFileSync(inputPath, 'test workbook bytes')
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
            '<script>',
            'document.querySelector("#workbook").addEventListener("change", (event) => {',
            'document.querySelector("#selected").textContent = event.target.files[0]?.name || "";',
            '});',
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
        await session.getPage()?.evaluate('globalThis.__name ||= ((value) => value)')

        const pageElements = await session.readPage()
        assert.equal(pageElements.supported, true, pageElements.error)
        const fileInput = pageElements.elements.find((element) => element.role === 'input:file')
        assert.ok(fileInput, 'readPage should expose a hidden input[type=file]')
        assert.equal(fileInput.inViewport, false)

        const upload = await session.uploadFile('files/Clienti_Oblio_TEST.xls', fileInput.ref)
        assert.equal(upload.success, true, upload.error)
        assert.equal(upload.path, 'files/Clienti_Oblio_TEST.xls')
        assert.equal(upload.filename, 'Clienti_Oblio_TEST.xls')
        assert.equal(
            await session.getPage()?.locator('#selected').textContent(),
            'Clienti_Oblio_TEST.xls',
            'setInputFiles should trigger the page change handler without an OS picker',
        )

        const escapedUpload = await session.uploadFile(outsidePath, fileInput.ref)
        assert.equal(escapedUpload.success, false)
        assert.match(escapedUpload.error || '', /inside the active profile workspace/i)

        const secondSession = await manager.createSession({
            id: 'second_profile_upload',
            startupUrl: `data:text/html,${encodeURIComponent(html)}`,
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
