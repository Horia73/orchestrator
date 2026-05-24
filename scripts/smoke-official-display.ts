import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { createBrowserManager } from '@/lib/browser-agent-runtime/browser';

const root = path.resolve(process.env.BROWSER_AGENT_SMOKE_DIR || path.join(os.tmpdir(), 'orchestrator-official-display-smoke'));
const viewport = {
    width: Number(process.env.BROWSER_AGENT_SMOKE_WIDTH || 1280),
    height: Number(process.env.BROWSER_AGENT_SMOKE_HEIGHT || 720),
};

function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (condition()) {
                resolve();
                return;
            }
            if (Date.now() - started >= timeoutMs) {
                reject(new Error('Timed out waiting for official-display click event.'));
                return;
            }
            setTimeout(tick, 50);
        };
        tick();
    });
}

async function main() {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });

    let clickCount = 0;
    const copiedText = `official-display-copy-${Date.now()}`;
    const pagePath = path.join(root, 'page.html');
    const pageHtml = `<!doctype html>
<html>
  <head>
    <title>Official Display Smoke</title>
  </head>
  <body style="font-family: sans-serif; margin: 0">
    <button
      id="click-target"
      style="position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; background: #0f766e; color: white; font-size: 42px"
      onclick="navigator.clipboard.writeText('${copiedText}').then(() => fetch('/clicked', { method: 'POST' })).then(() => { this.textContent = 'Clicked'; this.style.background = '#166534'; })"
    >Click target</button>
    <p style="margin-top: 700px; font-size: 28px">Needle phrase for findInPage</p>
  </body>
</html>`;
    fs.writeFileSync(pagePath, pageHtml);
    const server = http.createServer((request, response) => {
        if (request.method === 'POST' && request.url === '/clicked') {
            clickCount++;
            response.writeHead(204);
            response.end();
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(pageHtml);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Smoke HTTP server did not expose a TCP port.');
    }

    const manager = await createBrowserManager({
        backend: 'official-display',
        userDataDir: path.join(root, 'profile'),
        downloadsDir: path.join(root, 'downloads'),
        chromeExecutablePath: process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH || '/usr/bin/chromium',
        liveView: true,
        viewport,
        launchArgs: [],
        onLog: (message) => console.log(`[browser] ${message}`),
    });

    try {
        await manager.launch();
        const session = await manager.createSession({ id: 'smoke' });
        await session.navigate(`http://127.0.0.1:${address.port}/`);
        await session.clickCoordinate(viewport.width / 2, viewport.height / 2);
        await waitFor(() => clickCount > 0);
        const clipboard = await session.readClipboard();
        if (clipboard !== copiedText) {
            throw new Error(`official-display clipboard mismatch: expected ${copiedText}, got ${clipboard ?? '(unreadable)'}`);
        }
        await session.findInPage('Needle phrase');
        const frame = await session.captureAgentFrame();
        const screenshotPath = path.join(root, 'frame.jpg');
        fs.writeFileSync(screenshotPath, Buffer.from(frame.imageBase64, 'base64'));

        const result = {
            display: manager.getLiveViewState().display,
            wsPort: manager.getLiveViewState().wsPort,
            capabilities: session.capabilities,
            screenshotPath,
            frameBytes: fs.statSync(screenshotPath).size,
            clickCount,
            viewport: frame.viewport,
            coordinateSpace: frame.coordinateSpace,
        };
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await manager.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
});
