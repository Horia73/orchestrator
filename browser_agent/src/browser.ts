import { chromium, BrowserContext, Page } from 'patchright';
import path from 'path';
import fs from 'fs';
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from './prompts.js';

export interface BrowserManagerOptions {
    userDataDir?: string;
    headless?: boolean;
    viewport?: { width: number; height: number } | null;
    launchArgs?: string[];
}

export type BrowserFrameSource = 'agent' | 'live';

export interface BrowserFrameSnapshot {
    id: string;
    source: BrowserFrameSource;
    timestamp: string;
    imageBase64: string;
    url: string;
    viewport: { width: number; height: number };
}

export interface BrowserManager {
    launch(): Promise<void>;
    close(): Promise<void>;
    screenshot(source?: BrowserFrameSource): Promise<string>;
    captureLiveFrame(): Promise<BrowserFrameSnapshot>;
    clickCoordinate(x: number, y: number, count?: number): Promise<boolean>;
    holdCoordinate(x: number, y: number, durationMs?: number): Promise<boolean>;
    hoverCoordinate(x: number, y: number): Promise<void>;
    type(text: string): Promise<void>;
    paste(text: string): Promise<void>;
    clear(): Promise<void>;
    pressKey(key: string): Promise<void>;
    scroll(direction: 'up' | 'down'): Promise<void>;
    navigate(url: string): Promise<void>;
    goBack(): Promise<void>;
    goForward(): Promise<void>;
    reloadPage(): Promise<void>;
    closeCurrentTab(): Promise<void>;
    getHrefAt(x: number, y: number): Promise<string | null>;
    getPage(): Page | null;
    getPageUrl(): string;
    getOpenTabCount(): Promise<number>;
    getViewport(): Promise<{ width: number; height: number }>;
    getLatestAgentFrame(): BrowserFrameSnapshot | null;
    getAgentFrameHistory(limit?: number): BrowserFrameSnapshot[];
    clearAgentFrameHistory(): void;
}

const MAX_AGENT_FRAME_HISTORY = 240;

function toFrameId(sequence: number): string {
    return `frame_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

function cloneFrame(frame: BrowserFrameSnapshot): BrowserFrameSnapshot {
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

// Bezier curve helper
function bezierCurve(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// Human mouse movement
async function humanMouseMove(
    page: Page,
    targetX: number,
    targetY: number,
    startX?: number,
    startY?: number,
) {
    if (!page) return;
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

async function selectAllAndClear(page: Page) {
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';

    await page.keyboard.down(modifier);
    await page.keyboard.press('a');
    await page.keyboard.up(modifier);

    await new Promise(r => setTimeout(r, 100));
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 100));
}

export async function createBrowserManager(options: BrowserManagerOptions = {}): Promise<BrowserManager> {
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let lastMousePosition: { x: number; y: number } | null = null;
    let frameSequence = 0;
    let latestAgentFrame: BrowserFrameSnapshot | null = null;
    let agentFrameHistory: BrowserFrameSnapshot[] = [];

    const userDataDir = path.resolve(process.cwd(), options.userDataDir || 'user-data-patchright');
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

    const ensureActivePage = async (): Promise<Page> => {
        if (!context || !page) {
            throw new Error('Browser not launched');
        }

        const pages = context.pages();
        page = pages[pages.length - 1] || page;
        return page;
    };

    const captureFrame = async (
        source: BrowserFrameSource,
        quality: number,
        trackInHistory: boolean,
    ): Promise<BrowserFrameSnapshot> => {
        const activePage = await ensureActivePage();
        const viewport = await activePage.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
        }));

        console.log(`📸 Screenshot viewport: ${viewport.width}x${viewport.height} (${source})`);

        const buffer = await activePage.screenshot({ type: 'jpeg', quality });
        const frame: BrowserFrameSnapshot = {
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

    const manager: BrowserManager = {
        async launch() {
            // Ensure user data directory exists
            if (!fs.existsSync(userDataDir)) {
                try {
                    fs.mkdirSync(userDataDir, { recursive: true });
                    console.log(`📂 Created User Data Dir: ${userDataDir}`);
                } catch (err) {
                    console.error(`❌ Failed to create User Data Dir: ${userDataDir}`, err);
                }
            }

            console.log('🚀 Launching Patchright Browser...');
            console.log(`📂 User Data Dir: ${userDataDir}`);

            context = await chromium.launchPersistentContext(userDataDir, {
                headless: options.headless ?? true,
                viewport: options.viewport === undefined ? null : options.viewport,
                args: launchArgs,
            });

            const pages = context.pages();
            page = pages.length > 0 ? pages[0] : await context.newPage();
            lastMousePosition = null;

            if (options.viewport) {
                for (const existingPage of context.pages()) {
                    try {
                        await existingPage.setViewportSize(options.viewport);
                    } catch {
                        // Ignore pages that do not support resizing in this context.
                    }
                }
            }

            console.log('✅ Patchright Browser ready');
        },

        async close() {
            if (context) {
                await context.close();
                context = null;
                page = null;
                lastMousePosition = null;
                latestAgentFrame = null;
                agentFrameHistory = [];
            }
        },

        async screenshot(source: BrowserFrameSource = 'agent'): Promise<string> {
            const frame = await captureFrame(source, 90, source === 'agent');
            return frame.imageBase64;
        },

        async captureLiveFrame(): Promise<BrowserFrameSnapshot> {
            return captureFrame('live', 80, false);
        },

        async clickCoordinate(x: number, y: number, count: number = 1): Promise<boolean> {
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
                console.log(`⚠️ Clamping coordinates from [${x}, ${y}] to [${safeX}, ${safeY}] (Viewport: ${maxX}x${maxY})`);
            }

            try {
                console.log(`🖱️ Clicking at ${safeX}, ${safeY} (Count: ${count})`);

                // Move mouse to target
                await humanMouseMove(
                    activePage,
                    safeX,
                    safeY,
                    lastMousePosition?.x,
                    lastMousePosition?.y,
                );
                // Ensure final pointer position is exact for reliable targeting.
                await activePage.mouse.move(safeX, safeY);
                lastMousePosition = { x: safeX, y: safeY };

                // Brief hesitation before click to mimic natural interaction.
                await new Promise(r => setTimeout(r, 12 + Math.random() * 16));

                // Perform click(s)
                if (count === 2) {
                    await activePage.mouse.click(safeX, safeY, { clickCount: 2, delay: 70 });
                } else {
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
                            if (parent) parent.appendChild(div);

                            // Remove after 3 seconds
                            setTimeout(() => div.remove(), 2500);
                        } catch {
                            // Ignore internal DOM errors
                        }
                    }, { x: safeX, y: safeY });
                } catch {
                    // navigation happened
                }

                return true;
            } catch (e) {
                console.error('Click failed:', e);
                return false;
            }
        },

        async holdCoordinate(x: number, y: number, durationMs: number = 1200): Promise<boolean> {
            const activePage = await ensureActivePage();

            const { width: maxX, height: maxY } = await activePage.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight
            }));

            const safeX = Math.max(0, Math.min(x, maxX - 1));
            const safeY = Math.max(0, Math.min(y, maxY - 1));

            if (safeX !== x || safeY !== y) {
                console.log(`⚠️ Clamping hold coordinates from [${x}, ${y}] to [${safeX}, ${safeY}] (Viewport: ${maxX}x${maxY})`);
            }

            try {
                console.log(`🖱️ Holding at ${safeX}, ${safeY} (${durationMs}ms)`);

                await humanMouseMove(
                    activePage,
                    safeX,
                    safeY,
                    lastMousePosition?.x,
                    lastMousePosition?.y,
                );
                await activePage.mouse.move(safeX, safeY);
                lastMousePosition = { x: safeX, y: safeY };
                await new Promise(r => setTimeout(r, 120 + Math.random() * 80));

                await activePage.mouse.down();
                await new Promise(r => setTimeout(r, Math.max(200, durationMs)));
                await activePage.mouse.up();

                return true;
            } catch (e) {
                console.error('Hold failed:', e);
                return false;
            }
        },

        async hoverCoordinate(x: number, y: number): Promise<void> {
            const activePage = await ensureActivePage();
            const { width, height } = await this.getViewport();
            const safeX = Math.max(0, Math.min(x, width - 1));
            const safeY = Math.max(0, Math.min(y, height - 1));

            console.log(`🖱️ Hovering at ${safeX}, ${safeY}`);
            await humanMouseMove(
                activePage,
                safeX,
                safeY,
                lastMousePosition?.x,
                lastMousePosition?.y,
            );
            await activePage.mouse.move(safeX, safeY);
            lastMousePosition = { x: safeX, y: safeY };
        },

        async type(text: string) {
            const activePage = await ensureActivePage();
            await activePage.bringToFront();
            await activePage.keyboard.type(text, { delay: 32 });
        },

        async paste(text: string) {
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

        async pressKey(key: string) {
            const activePage = await ensureActivePage();
            await activePage.keyboard.press(key);
        },

        async scroll(direction: 'up' | 'down') {
            const activePage = await ensureActivePage();
            await activePage.mouse.wheel(0, direction === 'down' ? 500 : -500);
        },

        async navigate(url: string) {
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

        async getHrefAt(x: number, y: number): Promise<string | null> {
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
                if (!element) return null;
                const anchor = element.closest('a');
                return anchor ? anchor.href : null;
            }, { x: safeX, y: safeY });
        },

        getPage(): Page | null { return page; },
        getPageUrl(): string { return page ? page.url() : ''; },
        getOpenTabCount(): Promise<number> { return context ? Promise.resolve(context.pages().length) : Promise.resolve(0); },
        async getViewport(): Promise<{ width: number; height: number }> {
            if (!page) return { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
            try {
                return await page.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight
                }));
            } catch {
                return { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
            }
        },
        getLatestAgentFrame(): BrowserFrameSnapshot | null {
            return latestAgentFrame ? cloneFrame(latestAgentFrame) : null;
        },
        getAgentFrameHistory(limit: number = MAX_AGENT_FRAME_HISTORY): BrowserFrameSnapshot[] {
            const safeLimit = Number.isFinite(limit) && limit > 0
                ? Math.min(Math.floor(limit), MAX_AGENT_FRAME_HISTORY)
                : MAX_AGENT_FRAME_HISTORY;
            return agentFrameHistory
                .slice(-safeLimit)
                .map((frame) => cloneFrame(frame));
        },
        clearAgentFrameHistory(): void {
            latestAgentFrame = null;
            agentFrameHistory = [];
        },
    };

    return manager;
}
