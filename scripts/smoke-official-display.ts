import fs from 'fs';
import os from 'os';
import path from 'path';

import { createBrowserManager } from '@/lib/browser-agent-runtime/browser';

const root = path.resolve(process.env.BROWSER_AGENT_SMOKE_DIR || path.join(os.tmpdir(), 'orchestrator-official-display-smoke'));
const viewport = {
    width: Number(process.env.BROWSER_AGENT_SMOKE_WIDTH || 1280),
    height: Number(process.env.BROWSER_AGENT_SMOKE_HEIGHT || 720),
};

function fileUrl(filePath: string): string {
    return `file://${filePath}`;
}

async function main() {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });

    const pagePath = path.join(root, 'page.html');
    fs.writeFileSync(
        pagePath,
        `<!doctype html>
<html>
  <head>
    <title>Official Display Smoke</title>
  </head>
  <body style="font-family: sans-serif; padding: 48px">
    <h1>Official display smoke</h1>
    <input id="field" value="initial" style="font-size: 24px; width: 360px">
    <p style="margin-top: 700px; font-size: 28px">Needle phrase for findInPage</p>
  </body>
</html>`,
    );

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
        await session.navigate(fileUrl(pagePath));
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
            viewport: frame.viewport,
            coordinateSpace: frame.coordinateSpace,
        };
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await manager.close();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
});
