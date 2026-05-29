import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'patchright';

import type {
    ActionTrace,
    BrowserDiagnosticsSnapshot,
    BrowserDownloadFile,
    BrowserDownloadWaitOptions,
    BrowserFetchResult,
    BrowserFrameSnapshot,
    BrowserFrameSource,
    BrowserManager,
    BrowserManagerOptions,
    BrowserPageSession,
    BrowserPageSessionCapabilities,
    BrowserTabInfo,
    BrowserVideoRecording,
    TracedActionResult,
} from './browser';
import type { BrowserLiveViewState } from './display';
import { startLinuxVncDisplay, type LinuxVncDisplayHandle } from './display-linux';
import { DEFAULT_VIEWPORT } from './viewport';

const DEFAULT_ACTION_SETTLE_MS = 300;
const DEFAULT_VIDEO_FPS = 4;
const MAX_AGENT_FRAME_HISTORY = 240;
const DEFAULT_STABILITY_INTERVAL_MS = 500;
const DEFAULT_STABILITY_TIMEOUT_MS = 4_000;
const DEFAULT_NAVIGATION_STABILITY_TIMEOUT_MS = 10_000;
const DEFAULT_STABILITY_FRAME_COUNT = 3;
const DEFAULT_STABILITY_RATIO = 0.82;

type DisplaySize = { width: number; height: number };

type OfficialDisplayState = {
    id: string;
    createdAt: string;
    launched: boolean;
    display: BrowserLiveViewState;
    displayHandle: LinuxVncDisplayHandle | null;
    chrome: ChildProcess | null;
    chromeWindowId: string | null;
    clipboardOwners: Set<ChildProcess>;
    userDataDir: string;
    downloadsDir: string;
    viewport: DisplaySize;
    latestAgentFrame: BrowserFrameSnapshot | null;
    frameHistory: BrowserFrameSnapshot[];
    frameSequence: number;
    downloads: BrowserDownloadFile[];
    currentUrl: string;
    lastMousePosition: { x: number; y: number } | null;
};

export async function createOfficialDisplayBrowserManager(options: BrowserManagerOptions = {}): Promise<BrowserManager> {
    if (process.platform !== 'linux') {
        throw new Error('official-display browser backend is only supported on Linux.');
    }

    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    const rootUserDataDir = path.resolve(process.cwd(), options.userDataDir || 'user-data-chromium');
    const downloadsDir = path.resolve(process.cwd(), options.downloadsDir || path.join(rootUserDataDir, 'downloads'));
    const log = (message: string) => options.onLog?.(message) ?? console.log(message);

    const state: OfficialDisplayState = {
        id: 'default',
        createdAt: new Date().toISOString(),
        launched: false,
        display: {
            enabled: true,
            available: false,
            ready: false,
            mode: 'linux-vnc',
            platform: process.platform,
            width: viewport.width,
            height: viewport.height,
            reason: 'Official Chromium display has not been started yet.',
        },
        displayHandle: null,
        chrome: null,
        chromeWindowId: null,
        clipboardOwners: new Set(),
        userDataDir: rootUserDataDir,
        downloadsDir,
        viewport: { width: viewport.width, height: viewport.height },
        latestAgentFrame: null,
        frameHistory: [],
        frameSequence: 0,
        downloads: [],
        currentUrl: '',
        lastMousePosition: null,
    };

    const capabilities: BrowserPageSessionCapabilities = {
        backend: 'official-display',
        coordinateSpace: 'normalized-display',
        domInspection: false,
        overviewCapture: false,
        tabEnumeration: false,
        downloadEvents: false,
        displayCapture: true,
        osClipboard: true,
        diagnostics: false,
        browserFetch: false,
    };

    const run = (command: string, args: string[], input?: string): Buffer => {
        const result = spawnSync(command, args, {
            env: displayEnv(state.display.display),
            input,
            maxBuffer: 64 * 1024 * 1024,
        });
        if (result.error) {
            throw new Error(`${command} is unavailable: ${result.error.message}`);
        }
        if (result.status !== 0) {
            const stderr = result.stderr.toString('utf8').trim();
            const stdout = result.stdout.toString('utf8').trim();
            const detail = stderr || stdout;
            throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
        }
        return result.stdout;
    };

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const xdotool = async (args: string[]) => {
        run('xdotool', args);
        await sleep(20);
    };

    const clampDisplayCoordinate = (x: number, y: number): [number, number] => {
        const roundedX = Number.isFinite(x) ? Math.round(x) : 0;
        const roundedY = Number.isFinite(y) ? Math.round(y) : 0;
        const safeX = Math.max(0, Math.min(roundedX, state.viewport.width - 1));
        const safeY = Math.max(0, Math.min(roundedY, state.viewport.height - 1));
        if (safeX !== roundedX || safeY !== roundedY) {
            log(`⚠️ Clamping display coordinates from [${x}, ${y}] to [${safeX}, ${safeY}] (${state.viewport.width}x${state.viewport.height})`);
        }
        return [safeX, safeY];
    };

    const findChromeWindow = (): string | null => {
        const found = spawnSync('xdotool', ['search', '--onlyvisible', '--class', 'chrom'], {
            env: displayEnv(state.display.display),
            encoding: 'utf8',
        });
        if (found.status !== 0) return null;
        return found.stdout.trim().split(/\s+/)[0] || null;
    };

    const activateChromeWindow = async () => {
        const windowId = state.chromeWindowId || findChromeWindow();
        if (!windowId) return;
        state.chromeWindowId = windowId;
        let lastError: unknown = null;
        let focused = false;
        try {
            run('xdotool', ['windowraise', windowId]);
        } catch (error) {
            lastError = error;
        }
        for (const args of [['windowactivate', '--sync', windowId], ['windowfocus', windowId]]) {
            try {
                run('xdotool', args);
                focused = true;
            } catch (error) {
                lastError = error;
            }
        }
        if (!focused) {
            state.chromeWindowId = null;
            log(`⚠️ Could not activate Chromium window before input: ${formatError(lastError)}`);
            return;
        }
        await sleep(40);
    };

    const closeClipboardOwners = () => {
        for (const owner of state.clipboardOwners) {
            if (owner.exitCode === null && !owner.killed) {
                try { owner.kill('SIGTERM'); } catch {}
            }
        }
        state.clipboardOwners.clear();
    };

    const setClipboard = async (text: string) => {
        closeClipboardOwners();
        const owner = spawn('xclip', ['-selection', 'clipboard', '-i', '-quiet'], {
            env: displayEnv(state.display.display),
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        let spawnError: Error | null = null;
        state.clipboardOwners.add(owner);
        owner.once('exit', () => {
            state.clipboardOwners.delete(owner);
        });
        owner.once('error', error => {
            spawnError = error;
            state.clipboardOwners.delete(owner);
            log(`⚠️ xclip failed: ${error.message}`);
        });
        owner.stderr?.on('data', chunk => {
            const message = chunk.toString('utf8').trim();
            if (message) {
                stderr = `${stderr ? `${stderr}\n` : ''}${message}`.slice(-2_000);
            }
        });
        owner.stdin.end(text);
        await sleep(150);
        if (spawnError) {
            throw spawnError;
        }
        if (owner.exitCode !== null && owner.exitCode !== 0) {
            throw new Error(`xclip exited with code ${owner.exitCode}${stderr ? `: ${stderr}` : ''}`);
        }
        if (owner.signalCode !== null) {
            throw new Error(`xclip exited with signal ${owner.signalCode}${stderr ? `: ${stderr}` : ''}`);
        }
    };

    const pressShortcut = async (key: string) => {
        await activateChromeWindow();
        await xdotool(['key', '--clearmodifiers', normalizeXdotoolKey(key)]);
    };

    const waitForDisplayStability = async (timeoutMs = DEFAULT_STABILITY_TIMEOUT_MS) => {
        if (!state.display.ready || !state.display.display) return;

        const intervalMs = intEnv('BROWSER_AGENT_DISPLAY_STABILITY_INTERVAL_MS', DEFAULT_STABILITY_INTERVAL_MS);
        const requiredFrames = intEnv('BROWSER_AGENT_DISPLAY_STABILITY_FRAMES', DEFAULT_STABILITY_FRAME_COUNT);
        const stableRatio = floatEnv('BROWSER_AGENT_DISPLAY_STABILITY_RATIO', DEFAULT_STABILITY_RATIO);
        const deadline = Date.now() + Math.max(intervalMs, timeoutMs);
        let stableTransitions = 0;
        let previous: Buffer;

        try {
            previous = captureRawDisplay(run);
        } catch (error) {
            log(`⚠️ Display stability check skipped: ${formatError(error)}`);
            return;
        }

        while (Date.now() < deadline) {
            await sleep(intervalMs);
            let current: Buffer;
            try {
                current = captureRawDisplay(run);
            } catch (error) {
                log(`⚠️ Display stability check failed: ${formatError(error)}`);
                return;
            }

            const similarity = getFrameSimilarity(previous, current);
            if (similarity >= stableRatio) {
                stableTransitions++;
                if (stableTransitions >= Math.max(1, requiredFrames - 1)) {
                    return;
                }
            } else {
                stableTransitions = 0;
            }
            previous = current;
        }
    };

    const settleAfterAction = async (timeoutMs = intEnv('BROWSER_AGENT_DISPLAY_STABILITY_TIMEOUT_MS', DEFAULT_STABILITY_TIMEOUT_MS)) => {
        await sleep(DEFAULT_ACTION_SETTLE_MS);
        await waitForDisplayStability(timeoutMs);
    };

    const waitForChromeWindow = async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            if (state.chrome && (state.chrome.exitCode !== null || state.chrome.signalCode !== null)) {
                throw new Error(`Chromium exited early with code ${state.chrome.exitCode ?? state.chrome.signalCode}.`);
            }
            const windowId = findChromeWindow();
            if (windowId) {
                state.chromeWindowId = windowId;
                spawnSync('xdotool', ['windowmove', '--sync', windowId, '0', '0'], { env: displayEnv(state.display.display) });
                spawnSync('xdotool', ['windowsize', '--sync', windowId, String(state.viewport.width), String(state.viewport.height)], { env: displayEnv(state.display.display) });
                spawnSync('xdotool', ['windowraise', windowId], { env: displayEnv(state.display.display) });
                spawnSync('xdotool', ['windowactivate', '--sync', windowId], { env: displayEnv(state.display.display) });
                spawnSync('xdotool', ['windowfocus', windowId], { env: displayEnv(state.display.display) });
                return;
            }
            await sleep(200);
        }
        throw new Error('Chromium did not open a visible window on the virtual display.');
    };

    const launchChromium = async (startupUrl?: string) => {
        const executable = findExecutable([
            options.chromeExecutablePath,
            process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH,
            process.env.CHROME_EXECUTABLE_PATH,
            'chromium',
            'chromium-browser',
            'google-chrome-stable',
            'google-chrome',
        ]);
        if (!executable) {
            throw new Error('No Chromium/Chrome executable found. Install chromium or set BROWSER_AGENT_CHROME_EXECUTABLE_PATH.');
        }
        ensureRequiredDisplayTools();

        prepareProfileDir({
            userDataDir: state.userDataDir,
            baseProfileDir: options.baseProfileDir,
            profileMode: options.profileMode || 'isolated',
            log,
        });
        writeChromePreferences(state.userDataDir, state.downloadsDir);

        const url = startupUrl || 'about:blank';
        const chromeArgs = [
            `--user-data-dir=${state.userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
            '--hide-crash-restore-bubble',
            '--disable-session-crashed-bubble',
            `--window-position=0,0`,
            `--window-size=${state.viewport.width},${state.viewport.height}`,
            '--force-device-scale-factor=1',
            ...(options.launchArgs || []),
            '--new-window',
        ];

        const spawnChrome = (extraArgs: string[] = []) => spawn(executable, [...chromeArgs, ...extraArgs, url], {
            env: displayEnv(state.display.display),
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        state.chrome = spawnChrome();
        pipeProcessLogs(state.chrome, log, 'chromium');
        try {
            await waitForChromeWindow();
        } catch (error) {
            const allowNoSandbox = parseBooleanEnv(process.env.BROWSER_AGENT_ALLOW_NO_SANDBOX, true);
            if (!allowNoSandbox) throw error;
            log('⚠️ Chromium did not start cleanly; retrying with --no-sandbox because BROWSER_AGENT_ALLOW_NO_SANDBOX is enabled.');
            await closeProcess(state.chrome);
            state.chrome = spawnChrome(['--no-sandbox']);
            pipeProcessLogs(state.chrome, log, 'chromium');
            await waitForChromeWindow();
        }

        state.currentUrl = url === 'about:blank' ? '' : url;
    };

    const captureFrame = async (source: BrowserFrameSource, trackHistory: boolean): Promise<BrowserFrameSnapshot> => {
        const buffer = run('import', ['-window', 'root', '-quality', '90', 'jpg:-']);
        const frame: BrowserFrameSnapshot = {
            id: `frame_${Date.now().toString(36)}_${(++state.frameSequence).toString(36)}`,
            source,
            timestamp: new Date().toISOString(),
            imageBase64: buffer.toString('base64'),
            url: state.currentUrl,
            captureMode: 'viewport',
            coordinateSpace: 'normalized-display',
            viewport: { ...state.viewport },
            page: {
                width: state.viewport.width,
                height: state.viewport.height,
                scrollX: 0,
                scrollY: 0,
            },
        };
        if (trackHistory) {
            state.latestAgentFrame = frame;
            state.frameHistory.push(frame);
            state.frameHistory = state.frameHistory.slice(-MAX_AGENT_FRAME_HISTORY);
        }
        return frame;
    };

    const scanDownloads = () => {
        fs.mkdirSync(state.downloadsDir, { recursive: true });
        const existing = new Set(state.downloads.map(download => download.savedPath).filter(Boolean));
        for (const entry of fs.readdirSync(state.downloadsDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            if (entry.name.endsWith('.crdownload')) continue;
            const savedPath = path.join(state.downloadsDir, entry.name);
            if (existing.has(savedPath)) continue;
            const stat = fs.statSync(savedPath);
            state.downloads.push({
                id: `download_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date(stat.mtimeMs).toISOString(),
                url: state.currentUrl,
                suggestedFilename: entry.name,
                savedPath,
                state: 'saved',
                size: stat.size,
            });
        }
    };

    const facade = (idGetter: () => string): BrowserPageSession => ({
        get id() { return idGetter(); },
        get createdAt() { return state.createdAt; },
        capabilities,

        async screenshot(source: BrowserFrameSource = 'agent') {
            return (await captureFrame(source, source === 'agent')).imageBase64;
        },
        async captureAgentFrame() {
            return captureFrame('agent', true);
        },
        async captureLiveFrame() {
            return captureFrame('live', false);
        },
        async captureOverviewFrame() {
            return captureFrame('agent', false);
        },
        async recordVideo(durationMs = 5000): Promise<BrowserVideoRecording> {
            const ffmpeg = findExecutable(['ffmpeg']);
            if (!ffmpeg) throw new Error('ffmpeg is required for official-display video recording.');
            const outputPath = path.join(state.downloadsDir, `browser-recording-${Date.now()}.webm`);
            const seconds = Math.max(1, Math.min(60, durationMs / 1000));
            run(ffmpeg, [
                '-y',
                '-video_size', `${state.viewport.width}x${state.viewport.height}`,
                '-f', 'x11grab',
                '-i', `${state.display.display}.0`,
                '-t', String(seconds),
                '-r', String(DEFAULT_VIDEO_FPS),
                outputPath,
            ]);
            const bytes = fs.readFileSync(outputPath);
            return {
                id: `video_${Date.now().toString(36)}`,
                timestamp: new Date().toISOString(),
                mimeType: 'video/webm',
                videoBase64: bytes.toString('base64'),
                url: state.currentUrl,
                durationMs,
                fps: DEFAULT_VIDEO_FPS,
                frameCount: Math.max(1, Math.round((durationMs / 1000) * DEFAULT_VIDEO_FPS)),
                viewport: { ...state.viewport },
                page: { width: state.viewport.width, height: state.viewport.height, scrollX: 0, scrollY: 0 },
            };
        },
        async clickCoordinate(x: number, y: number, count = 1) {
            await activateChromeWindow();
            const [safeX, safeY] = clampDisplayCoordinate(x, y);
            const repeat = Number.isFinite(count) ? Math.max(1, Math.round(count)) : 1;
            await xdotool(['mousemove', '--sync', String(safeX), String(safeY)]);
            state.lastMousePosition = { x: safeX, y: safeY };
            for (let i = 0; i < repeat; i++) {
                await xdotool(['mousedown', '1']);
                await sleep(45);
                await xdotool(['mouseup', '1']);
                if (i < repeat - 1) {
                    await sleep(80);
                }
            }
            await settleAfterAction();
            return true;
        },
        async dragCoordinate(startX: number, startY: number, endX: number, endY: number, durationMs = 900): Promise<TracedActionResult> {
            await activateChromeWindow();
            const [safeStartX, safeStartY] = clampDisplayCoordinate(startX, startY);
            const [safeEndX, safeEndY] = clampDisplayCoordinate(endX, endY);
            const steps = Math.max(8, Math.min(40, Math.round(durationMs / 35)));
            await xdotool(['mousemove', '--sync', String(safeStartX), String(safeStartY), 'mousedown', '1']);
            state.lastMousePosition = { x: safeStartX, y: safeStartY };
            for (let step = 1; step <= steps; step++) {
                const ratio = step / steps;
                const x = Math.round(safeStartX + (safeEndX - safeStartX) * ratio);
                const y = Math.round(safeStartY + (safeEndY - safeStartY) * ratio);
                await xdotool(['mousemove', '--sync', String(x), String(y)]);
                await sleep(Math.max(5, durationMs / steps));
            }
            state.lastMousePosition = { x: safeEndX, y: safeEndY };
            await xdotool(['mouseup', '1']);
            await settleAfterAction();
            return { success: true, trace: emptyTrace('drag') };
        },
        async holdCoordinate(x: number, y: number, durationMs = 10000): Promise<TracedActionResult> {
            await activateChromeWindow();
            const [safeX, safeY] = clampDisplayCoordinate(x, y);
            await xdotool(['mousemove', '--sync', String(safeX), String(safeY), 'mousedown', '1']);
            state.lastMousePosition = { x: safeX, y: safeY };
            await sleep(Math.max(200, durationMs));
            await xdotool(['mouseup', '1']);
            await settleAfterAction();
            return { success: true, trace: emptyTrace('hold') };
        },
        async hoverCoordinate(x: number, y: number) {
            await activateChromeWindow();
            const [safeX, safeY] = clampDisplayCoordinate(x, y);
            await xdotool(['mousemove', '--sync', String(safeX), String(safeY)]);
            state.lastMousePosition = { x: safeX, y: safeY };
        },
        async type(text: string) {
            await setClipboard(text);
            await pressShortcut('Control+V');
            await settleAfterAction();
        },
        async paste(text: string) {
            await setClipboard(text);
            await pressShortcut('Control+V');
            await settleAfterAction();
        },
        async readClipboard(): Promise<string | null> {
            try {
                return run('xclip', ['-selection', 'clipboard', '-o']).toString('utf8');
            } catch (error) {
                log(`⚠️ Could not read clipboard: ${formatError(error)}`);
                return null;
            }
        },
        async clear() {
            await pressShortcut('Control+A');
            await pressShortcut('Backspace');
            await settleAfterAction();
        },
        async pressKey(key: string) {
            await pressShortcut(key);
            await settleAfterAction();
        },
        async findInPage(query: string, next = false) {
            await pressShortcut('Control+F');
            await sleep(80);
            await pressShortcut('Control+A');
            await setClipboard(query);
            await pressShortcut('Control+V');
            if (next) {
                await pressShortcut('Enter');
            }
            await settleAfterAction();
        },
        async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 500) {
            await activateChromeWindow();
            const target = state.lastMousePosition ?? { x: state.viewport.width / 2, y: state.viewport.height / 2 };
            const [targetX, targetY] = clampDisplayCoordinate(target.x, target.y);
            await xdotool(['mousemove', '--sync', String(targetX), String(targetY)]);
            state.lastMousePosition = { x: targetX, y: targetY };
            const button = direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
            const repeats = Math.max(1, Math.min(20, Math.ceil(amount / 120)));
            for (let i = 0; i < repeats; i++) {
                await xdotool(['click', button]);
            }
            await settleAfterAction();
        },
        async scrollToBottom() {
            await activateChromeWindow();
            await pressShortcut('End');
            await settleAfterAction();
        },
        async undo() {
            await pressShortcut('Control+Z');
            await settleAfterAction();
        },
        async navigate(url: string) {
            await pressShortcut('Control+L');
            await setClipboard(url);
            await pressShortcut('Control+V');
            await pressShortcut('Enter');
            state.currentUrl = url;
            await settleAfterAction(DEFAULT_NAVIGATION_STABILITY_TIMEOUT_MS);
        },
        async goBack() {
            await pressShortcut('Alt+Left');
            await settleAfterAction(DEFAULT_NAVIGATION_STABILITY_TIMEOUT_MS);
        },
        async goForward() {
            await pressShortcut('Alt+Right');
            await settleAfterAction(DEFAULT_NAVIGATION_STABILITY_TIMEOUT_MS);
        },
        async reloadPage() {
            await pressShortcut('Control+R');
            await settleAfterAction(DEFAULT_NAVIGATION_STABILITY_TIMEOUT_MS);
        },
        async closeTab() {
            await pressShortcut('Control+W');
            await settleAfterAction();
            return true;
        },
        async listTabs(): Promise<BrowserTabInfo[]> {
            return [];
        },
        async switchTab(index: number) {
            if (index < 0 || index > 7) return false;
            await pressShortcut(`Control+${index + 1}`);
            await settleAfterAction();
            return true;
        },
        async newTab(url?: string) {
            await pressShortcut('Control+T');
            if (url) await this.navigate(url);
            else await settleAfterAction();
            return true;
        },
        async getHrefAt() {
            return null;
        },
        getPage(): Page | null {
            return null;
        },
        getPageUrl() {
            return state.currentUrl;
        },
        async getOpenTabCount() {
            return 1;
        },
        async getViewport() {
            return { ...state.viewport };
        },
        getDownloads() {
            scanDownloads();
            return state.downloads.map(download => ({ ...download }));
        },
        async waitForDownloads(timeoutMs = 5000, waitOptions: BrowserDownloadWaitOptions = {}) {
            const deadline = Date.now() + Math.max(0, timeoutMs);
            const baseline = waitOptions.baselineCount ?? state.downloads.length;
            do {
                scanDownloads();
                if (!waitOptions.waitForNew || state.downloads.length > baseline) break;
                await sleep(250);
            } while (Date.now() < deadline);
            return state.downloads.map(download => ({ ...download }));
        },
        getDiagnostics(): BrowserDiagnosticsSnapshot {
            return {
                supported: false,
                capturedAt: new Date().toISOString(),
                currentUrl: state.currentUrl,
                consoleMessages: [],
                pageErrors: [],
                failedRequests: [],
                httpErrors: [],
            };
        },
        async fetchUrl(url: string): Promise<BrowserFetchResult> {
            return {
                supported: false,
                requestedUrl: url,
                finalUrl: url,
                ok: false,
                status: 0,
                statusText: '',
                contentType: '',
                redirected: false,
                bodyLength: 0,
                bodySnippet: '',
                error: 'Browser fetch is unavailable on the official-display backend.',
            };
        },
        getLatestAgentFrame() {
            return state.latestAgentFrame ? { ...state.latestAgentFrame } : null;
        },
        getAgentFrameHistory(limit = 240) {
            return state.frameHistory.slice(-limit).map(frame => ({ ...frame }));
        },
        clearAgentFrameHistory() {
            state.latestAgentFrame = null;
            state.frameHistory = [];
        },
        async closeOwnedPages() {
            await pressShortcut('Control+W').catch(() => {});
        },
    });

    const defaultFacade = facade(() => state.id);

    const manager: BrowserManager = {
        ...defaultFacade,
        async launch() {
            if (state.launched) return;
            fs.mkdirSync(state.downloadsDir, { recursive: true });
            const displayResult = await startLinuxVncDisplay({
                viewport: state.viewport,
                previousState: state.display,
                onLog: log,
            });
            state.display = displayResult.state;
            state.displayHandle = displayResult.handle;
            if (!state.display.ready || !state.display.display) {
                throw new Error(state.display.reason || 'Virtual display failed to start.');
            }
            try {
                await launchChromium();
                await waitForDisplayStability(DEFAULT_NAVIGATION_STABILITY_TIMEOUT_MS);
                state.launched = true;
                log('✅ Official Chromium display browser ready');
            } catch (error) {
                await closeProcess(state.chrome);
                state.chrome = null;
                await state.displayHandle?.close();
                state.displayHandle = null;
                state.display = {
                    ...state.display,
                    available: false,
                    ready: false,
                    reason: `Official Chromium launch failed: ${formatError(error)}`,
                };
                throw error;
            }
        },
        async close() {
            await closeProcess(state.chrome);
            state.chrome = null;
            state.chromeWindowId = null;
            closeClipboardOwners();
            await state.displayHandle?.close();
            state.displayHandle = null;
            state.launched = false;
            state.display = {
                ...state.display,
                available: false,
                ready: false,
                reason: 'Official Chromium display stopped.',
            };
        },
        async createSession(sessionOptions = {}) {
            if (!state.launched) await manager.launch();
            state.id = sessionOptions.id?.trim() || state.id;
            if (sessionOptions.startupUrl) {
                await defaultFacade.navigate(sessionOptions.startupUrl);
            }
            return facade(() => state.id);
        },
        getSession(id: string) {
            return id === state.id ? facade(() => state.id) : null;
        },
        async closeSession(id: string) {
            if (id !== state.id) return false;
            await defaultFacade.closeOwnedPages();
            return true;
        },
        async listAllTabs() {
            return [];
        },
        getContext(): BrowserContext | null {
            return null;
        },
        getLiveViewState(): BrowserLiveViewState {
            return { ...state.display };
        },
    };

    return manager;
}

function displayEnv(display: string | undefined): NodeJS.ProcessEnv {
    return {
        ...process.env,
        DISPLAY: display || process.env.DISPLAY || ':99',
    };
}

function findExecutable(candidates: Array<string | undefined>): string | null {
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (candidate.includes(path.sep) && fs.existsSync(candidate)) return candidate;
        const found = spawnSync('sh', ['-lc', `command -v ${shellQuote(candidate)}`], { encoding: 'utf8' });
        const value = found.stdout.trim();
        if (found.status === 0 && value) return value;
    }
    return null;
}

function prepareProfileDir(options: {
    userDataDir: string;
    baseProfileDir?: string;
    profileMode: string;
    log: (message: string) => void;
}) {
    if (options.profileMode === 'clone-base' && options.baseProfileDir && fs.existsSync(options.baseProfileDir) && !directoryHasEntries(options.userDataDir)) {
        fs.mkdirSync(options.userDataDir, { recursive: true });
        const reflink = spawnSync('cp', ['-a', '--reflink=auto', `${options.baseProfileDir}/.`, options.userDataDir], { encoding: 'utf8' });
        if (reflink.status !== 0) {
            options.log('⚠️ Profile reflink clone failed; falling back to regular cp -a.');
            const copied = spawnSync('cp', ['-a', `${options.baseProfileDir}/.`, options.userDataDir], { encoding: 'utf8' });
            if (copied.status !== 0) {
                throw new Error(`Failed to clone browser base profile: ${copied.stderr.trim()}`);
            }
        }
        return;
    }
    fs.mkdirSync(options.userDataDir, { recursive: true });
}

function directoryHasEntries(dir: string): boolean {
    try {
        return fs.readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

function writeChromePreferences(userDataDir: string, downloadsDir: string) {
    const defaultDir = path.join(userDataDir, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    const preferencesPath = path.join(defaultDir, 'Preferences');
    let preferences: Record<string, unknown> = {};
    try {
        preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) as Record<string, unknown>;
    } catch {}
    preferences.download = {
        ...(typeof preferences.download === 'object' && preferences.download ? preferences.download : {}),
        default_directory: downloadsDir,
        prompt_for_download: false,
        directory_upgrade: true,
    };
    fs.writeFileSync(preferencesPath, JSON.stringify(preferences));
}

function ensureRequiredDisplayTools() {
    const missing = [
        ['xdotool', 'xdotool'],
        ['xclip', 'xclip'],
        ['import', 'ImageMagick'],
    ].filter(([command]) => !findExecutable([command]));

    if (missing.length > 0) {
        throw new Error(`official-display requires missing Linux packages: ${missing.map(([, pkg]) => pkg).join(', ')}.`);
    }
}

function captureRawDisplay(run: (command: string, args: string[], input?: string) => Buffer): Buffer {
    return run('import', [
        '-window', 'root',
        '-resize', '320x180!',
        '-depth', '8',
        'rgba:-',
    ]);
}

function getFrameSimilarity(previous: Buffer, current: Buffer): number {
    const length = Math.min(previous.length, current.length);
    if (length <= 0) return 0;

    let compared = 0;
    let similar = 0;
    for (let offset = 0; offset + 3 < length; offset += 4) {
        compared++;
        const diff =
            Math.abs(previous[offset] - current[offset]) +
            Math.abs(previous[offset + 1] - current[offset + 1]) +
            Math.abs(previous[offset + 2] - current[offset + 2]);
        if (diff <= 36) {
            similar++;
        }
    }

    return compared > 0 ? similar / compared : 0;
}

function intEnv(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function floatEnv(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeXdotoolKey(key: string): string {
    const parts = key.split('+').map(part => part.trim()).filter(Boolean);
    return parts.map(part => {
        const lower = part.toLowerCase();
        if (lower === 'control') return 'ctrl';
        if (lower === 'meta' || lower === 'command') return 'super';
        if (lower === 'enter') return 'Return';
        if (lower === 'backspace') return 'BackSpace';
        if (lower === 'escape') return 'Escape';
        if (lower === 'delete') return 'Delete';
        if (lower === 'arrowleft') return 'Left';
        if (lower === 'arrowright') return 'Right';
        if (lower === 'arrowup') return 'Up';
        if (lower === 'arrowdown') return 'Down';
        return part.length === 1 ? part.toLowerCase() : part;
    }).join('+');
}

function emptyTrace(action: ActionTrace['action']): ActionTrace {
    return { action, intervalMs: 0, frames: [] };
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function pipeProcessLogs(proc: ChildProcess, log: (message: string) => void, label: string) {
    const write = (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) log(`[${label}] ${text}`);
    };
    proc.stdout?.on('data', write);
    proc.stderr?.on('data', write);
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);
        timer.unref?.();
        const onExit = () => {
            cleanup();
            resolve(true);
        };
        const cleanup = () => {
            clearTimeout(timer);
            proc.off('exit', onExit);
            proc.off('close', onExit);
        };
        proc.once('exit', onExit);
        proc.once('close', onExit);
    });
}

async function closeProcess(proc: ChildProcess | null) {
    if (!proc || proc.exitCode !== null || proc.killed) return;
    try {
        proc.kill('SIGTERM');
    } catch {
        return;
    }
    const exited = await waitForExit(proc, 1_000);
    if (!exited && proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch {}
        await waitForExit(proc, 1_000);
    }
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
