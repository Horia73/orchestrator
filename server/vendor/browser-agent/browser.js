/* eslint-disable no-undef */
import { chromium } from 'patchright';
import path from 'path';
import fs from 'fs';
import { DEFAULT_VIEWPORT } from './viewport.js';
const MAX_AGENT_FRAME_HISTORY = 240;
function toFrameId(sequence) {
    return `frame_${Date.now().toString(36)}_${sequence.toString(36)}`;
}
function cloneFrame(frame) {
    return {
        id: frame.id,
        source: frame.source,
        timestamp: frame.timestamp,
        imageBase64: frame.imageBase64,
        url: frame.url,
        viewport: {
            width: frame.viewport.width,
            height: frame.viewport.height,
        },
    };
}
function cloneVideoFile(file) {
    return {
        id: file.id,
        path: file.path,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        pageUrl: file.pageUrl,
        recordedAt: file.recordedAt,
    };
}
// Bezier curve helper
function bezierCurve(t, p0, p1, p2, p3) {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
// Human mouse movement
async function humanMouseMove(page, targetX, targetY, startX, startY) {
    if (!page)
        return;
    const viewport = page.viewportSize();
    const fallbackWidth = viewport?.width || 1980;
    const fallbackHeight = viewport?.height || 1080;
    const currentX = typeof startX === 'number' && Number.isFinite(startX)
        ? startX
        : Math.random() * fallbackWidth;
    const currentY = typeof startY === 'number' && Number.isFinite(startY)
        ? startY
        : Math.random() * fallbackHeight;
    const cp1x = currentX + (targetX - currentX) * 0.25 + (Math.random() - 0.5) * 100;
    const cp1y = currentY + (targetY - currentY) * 0.25 + (Math.random() - 0.5) * 100;
    const cp2x = currentX + (targetX - currentX) * 0.75 + (Math.random() - 0.5) * 100;
    const cp2y = currentY + (targetY - currentY) * 0.75 + (Math.random() - 0.5) * 100;
    const steps = 8 + Math.floor(Math.random() * 6);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const adjustedT = t + (Math.random() - 0.5) * 0.05;
        const clampedT = Math.max(0, Math.min(1, adjustedT));
        const x = bezierCurve(clampedT, currentX, cp1x, cp2x, targetX);
        const y = bezierCurve(clampedT, currentY, cp1y, cp2y, targetY);
        await page.mouse.move(x, y);
        const delay = 4 + Math.random() * 8;
        await new Promise(r => setTimeout(r, delay));
    }
}
async function selectAllAndClear(page) {
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';
    await page.keyboard.down(modifier);
    await page.keyboard.press('a');
    await page.keyboard.up(modifier);
    await new Promise(r => setTimeout(r, 100));
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 100));
}
export async function createBrowserManager(options = {}) {
    let context = null;
    let page = null;
    let lastMousePosition = null;
    let frameSequence = 0;
    let latestAgentFrame = null;
    let agentFrameHistory = [];
    let liveCdpSession = null;
    let liveCdpPage = null;
    let liveScreencastActive = false;
    let latestLiveFrame = null;
    let pendingLiveFrameWaiters = [];
    const liveFrameSubscribers = new Set();
    let savedVideoFiles = [];
    const userDataDir = path.resolve(process.cwd(), options.userDataDir || 'user-data-patchright');
    const log = (message) => {
        if (typeof options.onLog === 'function') {
            options.onLog(message);
            return;
        }
        console.log(message);
    };
    const logError = (message, error) => {
        if (typeof options.onLog === 'function') {
            if (error instanceof Error) {
                options.onLog(`${message} ${error.message}`);
                return;
            }
            if (error !== undefined) {
                options.onLog(`${message} ${String(error)}`);
                return;
            }
            options.onLog(message);
            return;
        }
        if (error !== undefined) {
            console.error(message, error);
            return;
        }
        console.error(message);
    };
    const defaultLaunchArgs = [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
    ];
    const launchArgs = options.launchArgs && options.launchArgs.length > 0
        ? options.launchArgs
        : defaultLaunchArgs;
    const ensureActivePage = async () => {
        if (!context || !page) {
            throw new Error('Browser not launched');
        }
        const pages = context.pages();
        page = pages[pages.length - 1] || page;
        return page;
    };
    const resolveLiveWaiters = (frame) => {
        const waiters = pendingLiveFrameWaiters;
        pendingLiveFrameWaiters = [];
        for (const waiter of waiters) {
            clearTimeout(waiter.timeoutId);
            waiter.resolve(cloneFrame(frame));
        }
    };
    const notifyLiveFrameSubscribers = (frame) => {
        if (!frame || liveFrameSubscribers.size === 0) {
            return;
        }

        const snapshot = cloneFrame(frame);
        for (const subscriber of [...liveFrameSubscribers]) {
            try {
                subscriber(snapshot);
            }
            catch (error) {
                logError('Live frame subscriber failed:', error);
            }
        }
    };
    const rejectLiveWaiters = (error) => {
        const waiters = pendingLiveFrameWaiters;
        pendingLiveFrameWaiters = [];
        for (const waiter of waiters) {
            clearTimeout(waiter.timeoutId);
            waiter.reject(error);
        }
    };
    const teardownLiveCdpSession = async () => {
        if (!liveCdpSession) {
            liveScreencastActive = false;
            liveCdpPage = null;
            return;
        }
        try {
            if (liveScreencastActive) {
                await liveCdpSession.send('Page.stopScreencast');
            }
        }
        catch {
            // Ignore stop failures during teardown.
        }
        try {
            liveCdpSession.off?.('Page.screencastFrame', handleScreencastFrame);
        }
        catch {
            // ignore emitter cleanup failures
        }
        try {
            await liveCdpSession.detach?.();
        }
        catch {
            // ignore detach failures
        }
        liveCdpSession = null;
        liveCdpPage = null;
        liveScreencastActive = false;
        latestLiveFrame = null;
    };
    const handleScreencastFrame = async (event) => {
        if (!event || !liveCdpSession) {
            return;
        }
        try {
            await liveCdpSession.send('Page.screencastFrameAck', { sessionId: event.sessionId });
        }
        catch {
            // Ignore ack failures; next bind will refresh the session.
        }
        const frame = {
            id: toFrameId(++frameSequence),
            source: 'live',
            timestamp: new Date().toISOString(),
            imageBase64: String(event.data ?? ''),
            url: liveCdpPage ? liveCdpPage.url() : '',
            viewport: {
                width: Math.round(Number(event.metadata?.deviceWidth) || DEFAULT_VIEWPORT.width),
                height: Math.round(Number(event.metadata?.deviceHeight) || DEFAULT_VIEWPORT.height),
            },
        };
        latestLiveFrame = frame;
        resolveLiveWaiters(frame);
        notifyLiveFrameSubscribers(frame);
    };
    const ensureLiveCdpSession = async () => {
        const activePage = await ensureActivePage();
        if (liveCdpSession && liveCdpPage === activePage) {
            return liveCdpSession;
        }
        await teardownLiveCdpSession();
        liveCdpSession = await context.newCDPSession(activePage);
        liveCdpPage = activePage;
        liveCdpSession.on('Page.screencastFrame', handleScreencastFrame);
        return liveCdpSession;
    };
    const startLiveScreencast = async () => {
        const cdpSession = await ensureLiveCdpSession();
        if (liveScreencastActive) {
            return;
        }
        await cdpSession.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 55,
            maxWidth: DEFAULT_VIEWPORT.width,
            maxHeight: DEFAULT_VIEWPORT.height,
            everyNthFrame: 1,
        });
        liveScreencastActive = true;
    };
    const captureFrame = async (source, quality, trackInHistory) => {
        const activePage = await ensureActivePage();
        const viewport = await activePage.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
        }));
        if (source === 'agent') {
            log(`📸 Screenshot viewport: ${viewport.width}x${viewport.height} (${source})`);
        }
        const buffer = await activePage.screenshot({ type: 'jpeg', quality });
        const frame = {
            id: toFrameId(++frameSequence),
            source,
            timestamp: new Date().toISOString(),
            imageBase64: buffer.toString('base64'),
            url: activePage.url(),
            viewport: {
                width: viewport.width,
                height: viewport.height,
            },
        };
        if (trackInHistory) {
            latestAgentFrame = frame;
            agentFrameHistory.push(frame);
            if (agentFrameHistory.length > MAX_AGENT_FRAME_HISTORY) {
                agentFrameHistory = agentFrameHistory.slice(-MAX_AGENT_FRAME_HISTORY);
            }
        }
        return frame;
    };
    const manager = {
        async launch() {
            // Ensure user data directory exists
            if (!fs.existsSync(userDataDir)) {
                try {
                    fs.mkdirSync(userDataDir, { recursive: true });
                    log(`📂 Created User Data Dir: ${userDataDir}`);
                }
                catch (err) {
                    logError(`❌ Failed to create User Data Dir: ${userDataDir}`, err);
                }
            }
            log('🚀 Launching Patchright Browser...');
            log(`📂 User Data Dir: ${userDataDir}`);
            savedVideoFiles = [];
            context = await chromium.launchPersistentContext(userDataDir, {
                headless: options.headless ?? true,
                viewport: options.viewport === undefined ? null : options.viewport,
                args: launchArgs,
                ...(options.env && typeof options.env === 'object'
                    ? { env: { ...process.env, ...options.env } }
                    : {}),
                ...(options.recordVideo?.dir
                    ? {
                        recordVideo: {
                            dir: options.recordVideo.dir,
                            ...(options.recordVideo.size ? { size: options.recordVideo.size } : {}),
                        },
                    }
                    : {}),
            });
            const pages = context.pages();
            page = pages.length > 0 ? pages[0] : await context.newPage();
            lastMousePosition = null;
            if (options.viewport) {
                for (const existingPage of context.pages()) {
                    try {
                        await existingPage.setViewportSize(options.viewport);
                    }
                    catch {
                        // Ignore pages that do not support resizing in this context.
                    }
                }
            }
            log('✅ Patchright Browser ready');
        },
        async close() {
            if (context) {
                const pagesForVideo = context.pages().map((candidatePage, index) => ({
                    handle: candidatePage.video?.() ?? null,
                    order: index,
                    isActive: candidatePage === page,
                    pageUrl: candidatePage.url(),
                }));
                rejectLiveWaiters(new Error('Browser closed.'));
                await teardownLiveCdpSession();
                await context.close();
                const collectedVideoFiles = [];
                for (const candidate of pagesForVideo) {
                    if (!candidate.handle) {
                        continue;
                    }

                    try {
                        const savedPath = await candidate.handle.path();
                        if (!savedPath) {
                            continue;
                        }

                        let sizeBytes = 0;
                        let recordedAt = new Date().toISOString();
                        try {
                            const stats = fs.statSync(savedPath);
                            sizeBytes = Number(stats.size) || 0;
                            recordedAt = new Date(stats.mtimeMs).toISOString();
                        }
                        catch {
                            // ignore missing stat metadata
                        }

                        collectedVideoFiles.push({
                            id: `video_${Date.now().toString(36)}_${candidate.order.toString(36)}`,
                            path: savedPath,
                            fileName: path.basename(savedPath),
                            mimeType: 'video/webm',
                            sizeBytes,
                            pageUrl: candidate.pageUrl || '',
                            recordedAt,
                            order: candidate.order,
                            isActive: candidate.isActive,
                        });
                    }
                    catch (error) {
                        logError('Could not resolve recorded video path:', error);
                    }
                }

                savedVideoFiles = collectedVideoFiles
                    .sort((left, right) => {
                        const activeDelta = Number(right.isActive) - Number(left.isActive);
                        if (activeDelta !== 0) {
                            return activeDelta;
                        }
                        return left.order - right.order;
                    })
                    .map((videoFile) => ({
                        id: videoFile.id,
                        path: videoFile.path,
                        fileName: videoFile.fileName,
                        mimeType: videoFile.mimeType,
                        sizeBytes: videoFile.sizeBytes,
                        pageUrl: videoFile.pageUrl,
                        recordedAt: videoFile.recordedAt,
                    }));
                context = null;
                page = null;
                lastMousePosition = null;
                latestAgentFrame = null;
                agentFrameHistory = [];
                latestLiveFrame = null;
                liveFrameSubscribers.clear();
            }
        },
        async screenshot(source = 'agent') {
            const frame = await captureFrame(source, 90, source === 'agent');
            return frame.imageBase64;
        },
        async captureScreenshot(options = {}) {
            const source = String(options?.source ?? 'tool').trim() || 'tool';
            const quality = Number(options?.quality);
            const frame = await captureFrame(
                source,
                Number.isFinite(quality) && quality > 0 && quality <= 100 ? Math.trunc(quality) : 88,
                source === 'agent',
            );
            return cloneFrame(frame);
        },
        async captureLiveFrame(options = {}) {
            const waitForNext = options?.waitForNext === true;
            const timeoutMs = Number(options?.timeoutMs);
            await startLiveScreencast();
            if (!waitForNext && latestLiveFrame) {
                return cloneFrame(latestLiveFrame);
            }
            return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    pendingLiveFrameWaiters = pendingLiveFrameWaiters.filter((waiter) => waiter.timeoutId !== timeoutId);
                    reject(new Error('Timed out waiting for live frame.'));
                }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 2000);
                pendingLiveFrameWaiters.push({ resolve, reject, timeoutId });
            });
        },
        async subscribeLiveFrames(onFrame) {
            if (typeof onFrame !== 'function') {
                throw new Error('A live frame handler is required.');
            }

            await startLiveScreencast();

            const subscriber = (frame) => {
                onFrame(cloneFrame(frame));
            };
            liveFrameSubscribers.add(subscriber);

            if (latestLiveFrame) {
                queueMicrotask(() => {
                    if (liveFrameSubscribers.has(subscriber)) {
                        subscriber(latestLiveFrame);
                    }
                });
            }

            return () => {
                liveFrameSubscribers.delete(subscriber);
            };
        },
        async clickCoordinate(x, y, count = 1) {
            const activePage = await ensureActivePage();
            // Get ACTUAL viewport size from the window state
            const { width: maxX, height: maxY } = await activePage.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight
            }));
            // Clamp coordinates to be visible
            const safeX = Math.max(0, Math.min(x, maxX - 1));
            const safeY = Math.max(0, Math.min(y, maxY - 1));
            if (safeX !== x || safeY !== y) {
                log(`⚠️ Clamping coordinates from [${x}, ${y}] to [${safeX}, ${safeY}] (Viewport: ${maxX}x${maxY})`);
            }
            try {
                log(`🖱️ Clicking at ${safeX}, ${safeY} (Count: ${count})`);
                // Move mouse to target
                await humanMouseMove(activePage, safeX, safeY, lastMousePosition?.x, lastMousePosition?.y);
                // Ensure final pointer position is exact for reliable targeting.
                await activePage.mouse.move(safeX, safeY);
                lastMousePosition = { x: safeX, y: safeY };
                // Brief hesitation before click to mimic natural interaction.
                await new Promise(r => setTimeout(r, 12 + Math.random() * 16));
                // Perform click(s)
                if (count === 2) {
                    await activePage.mouse.click(safeX, safeY, { clickCount: 2, delay: 70 });
                }
                else {
                    await activePage.mouse.click(safeX, safeY, { delay: 24 });
                }
                // Visualization logic
                try {
                    await activePage.evaluate(({ x, y }) => {
                        try {
                            const div = document.createElement('div');
                            div.style.position = 'fixed';
                            div.style.left = `${x - 10}px`;
                            div.style.top = `${y - 10}px`;
                            div.style.width = '20px';
                            div.style.height = '20px';
                            div.style.borderRadius = '50%';
                            div.style.backgroundColor = 'rgba(255, 0, 0, 0.7)';
                            div.style.border = '3px solid white';
                            div.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
                            div.style.zIndex = '2147483647';
                            div.style.pointerEvents = 'none';
                            div.id = `ai-click-${Date.now()}`;
                            // Use safe appender
                            const parent = document.fullscreenElement || document.documentElement || document.body;
                            if (parent)
                                parent.appendChild(div);
                            // Remove after 3 seconds
                            setTimeout(() => div.remove(), 2500);
                        }
                        catch {
                            // Ignore internal DOM errors
                        }
                    }, { x: safeX, y: safeY });
                }
                catch {
                    // navigation happened
                }
                return true;
            }
            catch (e) {
                logError('Click failed:', e);
                return false;
            }
        },
        async holdCoordinate(x, y, durationMs = 1200) {
            const activePage = await ensureActivePage();
            const { width: maxX, height: maxY } = await activePage.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight
            }));
            const safeX = Math.max(0, Math.min(x, maxX - 1));
            const safeY = Math.max(0, Math.min(y, maxY - 1));
            if (safeX !== x || safeY !== y) {
                log(`⚠️ Clamping hold coordinates from [${x}, ${y}] to [${safeX}, ${safeY}] (Viewport: ${maxX}x${maxY})`);
            }
            try {
                log(`🖱️ Holding at ${safeX}, ${safeY} (${durationMs}ms)`);
                await humanMouseMove(activePage, safeX, safeY, lastMousePosition?.x, lastMousePosition?.y);
                await activePage.mouse.move(safeX, safeY);
                lastMousePosition = { x: safeX, y: safeY };
                await new Promise(r => setTimeout(r, 120 + Math.random() * 80));
                await activePage.mouse.down();
                await new Promise(r => setTimeout(r, Math.max(200, durationMs)));
                await activePage.mouse.up();
                return true;
            }
            catch (e) {
                logError('Hold failed:', e);
                return false;
            }
        },
        async hoverCoordinate(x, y) {
            const activePage = await ensureActivePage();
            const { width, height } = await this.getViewport();
            const safeX = Math.max(0, Math.min(x, width - 1));
            const safeY = Math.max(0, Math.min(y, height - 1));
            log(`🖱️ Hovering at ${safeX}, ${safeY}`);
            await humanMouseMove(activePage, safeX, safeY, lastMousePosition?.x, lastMousePosition?.y);
            await activePage.mouse.move(safeX, safeY);
            lastMousePosition = { x: safeX, y: safeY };
        },
        async type(text) {
            const activePage = await ensureActivePage();
            await activePage.bringToFront();
            await activePage.keyboard.type(text, { delay: 32 });
        },
        async paste(text) {
            const activePage = await ensureActivePage();
            await activePage.evaluate((textToPaste) => {
                // @ts-ignore
                document.execCommand('insertText', false, textToPaste);
            }, text);
        },
        async clear() {
            const activePage = await ensureActivePage();
            await selectAllAndClear(activePage);
        },
        async pressKey(key) {
            const activePage = await ensureActivePage();
            await activePage.keyboard.press(key);
        },
        async scroll(direction) {
            const activePage = await ensureActivePage();
            await activePage.mouse.wheel(0, direction === 'down' ? 500 : -500);
        },
        async navigate(url) {
            const activePage = await ensureActivePage();
            await activePage.goto(url, { waitUntil: 'domcontentloaded' });
        },
        async goBack() {
            const activePage = await ensureActivePage();
            await activePage.goBack();
        },
        async goForward() {
            const activePage = await ensureActivePage();
            await activePage.goForward();
        },
        async reloadPage() {
            const activePage = await ensureActivePage();
            await activePage.reload();
        },
        async closeCurrentTab() {
            if (!context) {
                return;
            }
            const pages = context.pages();
            if (pages.length > 1) {
                await page?.close();
                const newPages = context.pages();
                page = newPages[newPages.length - 1];
            }
        },
        async getHrefAt(x, y) {
            const activePage = await ensureActivePage();
            const { width: maxX, height: maxY } = await activePage.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight
            }));
            const safeX = Math.max(0, Math.min(x, maxX - 1));
            const safeY = Math.max(0, Math.min(y, maxY - 1));
            // Try to find a link (closest anchor)
            return activePage.evaluate(({ x: pointX, y: pointY }) => {
                const element = document.elementFromPoint(pointX, pointY);
                if (!element)
                    return null;
                const anchor = element.closest('a');
                return anchor ? anchor.href : null;
            }, { x: safeX, y: safeY });
        },
        getPage() { return page; },
        getPageUrl() { return page ? page.url() : ''; },
        getOpenTabCount() { return context ? Promise.resolve(context.pages().length) : Promise.resolve(0); },
        async getViewport() {
            if (!page)
                return { ...DEFAULT_VIEWPORT };
            try {
                return await page.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight
                }));
            }
            catch {
                return { ...DEFAULT_VIEWPORT };
            }
        },
        getLatestAgentFrame() {
            return latestAgentFrame ? cloneFrame(latestAgentFrame) : null;
        },
        getAgentFrameHistory(limit = MAX_AGENT_FRAME_HISTORY) {
            const safeLimit = Number.isFinite(limit) && limit > 0
                ? Math.min(Math.floor(limit), MAX_AGENT_FRAME_HISTORY)
                : MAX_AGENT_FRAME_HISTORY;
            return agentFrameHistory
                .slice(-safeLimit)
                .map((frame) => cloneFrame(frame));
        },
        clearAgentFrameHistory() {
            latestAgentFrame = null;
            agentFrameHistory = [];
        },
        getSavedVideoFiles() {
            return savedVideoFiles.map((file) => cloneVideoFile(file));
        },
    };
    return manager;
}
