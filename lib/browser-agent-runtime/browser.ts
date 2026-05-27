import { chromium, BrowserContext, Page } from 'patchright';
import fs from 'fs';
import path from 'path';
import { DEFAULT_VIEWPORT } from './viewport';
import { createBrowserDisplayController, type BrowserDisplayController, type BrowserLiveViewState } from './display';
import {
    clampDurationMs,
    cloneDownload,
    cloneFrame,
    compressTraceFrames,
    DEFAULT_DRAG_DURATION_MS,
    DEFAULT_VIDEO_DURATION_MS,
    DEFAULT_VIDEO_FPS,
    getActionTraceFrameCount,
    getTraceCaptureInterval,
    getTraceCaptureRatios,
    MAX_AGENT_FRAME_HISTORY,
    MAX_VIDEO_DURATION_MS,
    MIN_VIDEO_DURATION_MS,
    sanitizeDownloadFilename,
    sleep,
    toFrameId,
    uniqueDownloadPath,
} from './browser-helpers';
import type {
    ActionTrace,
    ActionTraceFrame,
    BrowserCaptureMode,
    BrowserConsoleEntry,
    BrowserDiagnosticsSnapshot,
    BrowserDownloadFile,
    BrowserDownloadWaitOptions,
    BrowserFetchResult,
    BrowserFrameSnapshot,
    BrowserFrameSource,
    BrowserManager,
    BrowserManagerOptions,
    BrowserNetworkEntry,
    BrowserPageSession,
    BrowserPageSessionCapabilities,
    BrowserPageErrorEntry,
    BrowserPageSessionOptions,
    BrowserTabInfo,
    BrowserTabOrigin,
    BrowserVideoRecording,
    TracedActionResult,
} from './browser-types';
import {
    cleanupStaleBrowserProfileLocks,
    ensureBrowserProfileDir,
    formatBrowserError,
    isBrowserProfileInUseError,
    killBrowserProcessesUsingPath,
} from './profile';
export type {
    ActionTrace,
    ActionTraceFrame,
    BrowserCaptureMode,
    BrowserCoordinateSpace,
    BrowserConsoleEntry,
    BrowserDiagnosticsSnapshot,
    BrowserDownloadFile,
    BrowserDownloadWaitOptions,
    BrowserFetchResult,
    BrowserFrameSnapshot,
    BrowserFrameSource,
    BrowserManager,
    BrowserManagerOptions,
    BrowserNetworkEntry,
    BrowserPageMetrics,
    BrowserPageSession,
    BrowserPageSessionCapabilities,
    BrowserPageErrorEntry,
    BrowserPageSessionOptions,
    BrowserTabInfo,
    BrowserTabOrigin,
    BrowserVideoRecording,
    TracedActionResult,
} from './browser-types';

const MAX_DIAGNOSTIC_ENTRIES = 80;
const MAX_FETCH_BODY_CHARS = 12_000;

interface HumanMouseMoveOptions {
    durationMs?: number;
    onAfterStep?: (position: { x: number; y: number; step: number; totalSteps: number }) => Promise<void> | void;
}

interface BrowserFrameMetrics {
    viewportWidth: number;
    viewportHeight: number;
    pageWidth: number;
    pageHeight: number;
    scrollX: number;
    scrollY: number;
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
    options: HumanMouseMoveOptions = {},
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

    const steps = options.durationMs
        ? Math.max(10, Math.min(36, Math.round(options.durationMs / 40)))
        : 8 + Math.floor(Math.random() * 6);
    const baseDelay = options.durationMs ? Math.max(10, options.durationMs / steps) : null;

    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const adjustedT = t + (Math.random() - 0.5) * 0.05;
        const clampedT = Math.max(0, Math.min(1, adjustedT));

        const x = bezierCurve(clampedT, currentX, cp1x, cp2x, targetX);
        const y = bezierCurve(clampedT, currentY, cp1y, cp2y, targetY);

        await page.mouse.move(x, y);
        if (options.onAfterStep) {
            await options.onAfterStep({ x, y, step: i, totalSteps: steps });
        }

        const delay = baseDelay
            ? Math.max(8, baseDelay + (Math.random() - 0.5) * baseDelay * 0.35)
            : 4 + Math.random() * 8;
        await sleep(delay);
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
    const backend = options.backend ?? 'patchright';
    if (backend === 'official-display') {
        const { createOfficialDisplayBrowserManager } = await import('./browser-official-display');
        return createOfficialDisplayBrowserManager(options);
    }

    let context: BrowserContext | null = null;
    let sessionSequence = 0;
    let displayController: BrowserDisplayController | null = null;
    let lastLiveViewState: BrowserLiveViewState = {
        enabled: Boolean(options.liveView) || process.platform === 'darwin',
        available: false,
        ready: false,
        mode: (Boolean(options.liveView) || process.platform === 'darwin')
            ? process.platform === 'darwin'
                ? 'mac-headful'
                : process.platform === 'linux'
                    ? 'linux-vnc'
                    : 'disabled'
            : 'disabled',
        platform: process.platform,
        width: DEFAULT_VIEWPORT.width,
        height: DEFAULT_VIEWPORT.height,
    };

    type BrowserSessionState = {
        id: string;
        createdAt: string;
        pages: Page[];
        activePage: Page | null;
        lastMousePosition: { x: number; y: number } | null;
        frameSequence: number;
        latestAgentFrame: BrowserFrameSnapshot | null;
        agentFrameHistory: BrowserFrameSnapshot[];
        downloads: BrowserDownloadFile[];
        downloadTasks: Set<Promise<void>>;
        consoleMessages: BrowserConsoleEntry[];
        pageErrors: BrowserPageErrorEntry[];
        failedRequests: BrowserNetworkEntry[];
        httpErrors: BrowserNetworkEntry[];
    };

    type PageOwnership = {
        sessionId: string;
        openedAt: string;
        origin: BrowserTabOrigin;
        openerPage?: Page;
        openerUrl?: string;
    };

    const sessions = new Map<string, BrowserSessionState>();
    const sessionFacades = new Map<string, BrowserPageSession>();
    const pageOwners = new WeakMap<Page, BrowserSessionState>();
    const pageOwnership = new WeakMap<Page, PageOwnership>();
    const instrumentedPages = new WeakSet<Page>();

    const grantClipboardAccess = async (page?: Page | null) => {
        if (!context) return;

        let origin: string | undefined;
        if (page) {
            try {
                const url = page.url();
                if (url && !url.startsWith('about:')) {
                    const parsedOrigin = new URL(url).origin;
                    if (parsedOrigin && parsedOrigin !== 'null') {
                        origin = parsedOrigin;
                    }
                }
            } catch {
                origin = undefined;
            }
        }

        try {
            await context.grantPermissions(['clipboard-read', 'clipboard-write'], origin ? { origin } : undefined);
        } catch (error) {
            log(`⚠️ Could not grant browser clipboard permissions${origin ? ` for ${origin}` : ''}: ${formatBrowserError(error)}`);
        }
    };

    const readClipboardByPaste = async (page: Page): Promise<string | null> => {
        const marker = `ai-clipboard-reader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

        try {
            await page.evaluate((id) => {
                const textarea = document.createElement('textarea');
                textarea.id = id;
                textarea.setAttribute('aria-hidden', 'true');
                textarea.style.position = 'fixed';
                textarea.style.left = '-10000px';
                textarea.style.top = '0';
                textarea.style.width = '1px';
                textarea.style.height = '1px';
                textarea.style.opacity = '0';
                document.documentElement.appendChild(textarea);
                textarea.focus();
            }, marker);
            await page.keyboard.down(modifier);
            await page.keyboard.press('v');
            await page.keyboard.up(modifier);
            await sleep(100);
            return await page.evaluate((id) => {
                const textarea = document.getElementById(id) as HTMLTextAreaElement | null;
                const value = textarea?.value ?? '';
                textarea?.remove();
                return value;
            }, marker);
        } catch (error) {
            log(`⚠️ Clipboard paste fallback failed: ${formatBrowserError(error)}`);
            try {
                await page.keyboard.up(modifier);
            } catch {
                // Ignore cleanup errors when the page closed mid-action.
            }
            try {
                await page.evaluate((id) => document.getElementById(id)?.remove(), marker);
            } catch {
                // Ignore cleanup errors when the page closed mid-action.
            }
            return null;
        }
    };

    const pressShortcut = async (page: Page, key: string) => {
        const parts = key.split('+').map(part => part.trim()).filter(Boolean);
        const modifierParts = parts.slice(0, -1);
        const finalKey = parts[parts.length - 1];
        if (!finalKey) return;

        try {
            for (const modifier of modifierParts) {
                await page.keyboard.down(modifier);
            }
            await page.keyboard.press(finalKey);
        } finally {
            for (const modifier of modifierParts.reverse()) {
                try {
                    await page.keyboard.up(modifier);
                } catch {
                    // Ignore cleanup errors if the page closed while pressing a shortcut.
                }
            }
        }
    };

    const insertTextDirectly = async (page: Page, text: string) => {
        await page.evaluate((textToPaste) => {
            const active = document.activeElement;
            if (
                active instanceof HTMLInputElement ||
                active instanceof HTMLTextAreaElement
            ) {
                const start = active.selectionStart ?? active.value.length;
                const end = active.selectionEnd ?? active.value.length;
                active.value = `${active.value.slice(0, start)}${textToPaste}${active.value.slice(end)}`;
                const cursor = start + textToPaste.length;
                active.setSelectionRange(cursor, cursor);
                active.dispatchEvent(new InputEvent('input', { bubbles: true, data: textToPaste, inputType: 'insertText' }));
                active.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }

            document.execCommand('insertText', false, textToPaste);
        }, text);
    };

    const pasteTextIntoPage = async (page: Page, text: string) => {
        await page.bringToFront();
        await grantClipboardAccess(page);
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

        try {
            await page.evaluate(async (textToPaste) => {
                if (!navigator.clipboard?.writeText) {
                    throw new Error('navigator.clipboard.writeText is unavailable');
                }
                await navigator.clipboard.writeText(textToPaste);
            }, text);
            await pressShortcut(page, `${modifier}+v`);
            return;
        } catch (error) {
            log(`⚠️ Clipboard paste failed; falling back to direct text insertion: ${formatBrowserError(error)}`);
        }

        await insertTextDirectly(page, text);
    };

    const createSessionState = (requestedId?: string): BrowserSessionState => {
        const id = requestedId?.trim() || `browser_session_${++sessionSequence}`;
        if (sessions.has(id)) {
            throw new Error(`Browser session already exists: ${id}`);
        }

        const state: BrowserSessionState = {
            id,
            createdAt: new Date().toISOString(),
            pages: [],
            activePage: null,
            lastMousePosition: null,
            frameSequence: 0,
            latestAgentFrame: null,
            agentFrameHistory: [],
            downloads: [],
            downloadTasks: new Set(),
            consoleMessages: [],
            pageErrors: [],
            failedRequests: [],
            httpErrors: [],
        };
        sessions.set(id, state);
        return state;
    };

    const defaultSessionState = createSessionState('default');

    const userDataDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), options.userDataDir || 'user-data-patchright');
    const downloadsDir = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        options.downloadsDir || path.join(userDataDir, 'downloads')
    );
    const log = (message: string) => {
        if (typeof options.onLog === 'function') {
            options.onLog(message);
            return;
        }

        console.log(message);
    };
    const logError = (message: string, error?: unknown) => {
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
        '--hide-crash-restore-bubble',
        '--disable-session-crashed-bubble',
    ];
    const launchArgs = options.launchArgs && options.launchArgs.length > 0
        ? options.launchArgs
        : defaultLaunchArgs;

    const getOpenOwnedPages = (session: BrowserSessionState): Page[] => {
        if (!context) {
            session.pages = [];
            session.activePage = null;
            return [];
        }

        const openPages = new Set(context.pages());
        session.pages = session.pages.filter((ownedPage) => openPages.has(ownedPage));
        if (session.activePage && !openPages.has(session.activePage)) {
            session.activePage = session.pages[session.pages.length - 1] || null;
            session.lastMousePosition = null;
        }
        return session.pages;
    };

    const getSessionPageIndex = (session: BrowserSessionState, targetPage?: Page): number | undefined => {
        if (!targetPage) return undefined;
        const pages = getOpenOwnedPages(session);
        const index = pages.indexOf(targetPage);
        return index >= 0 ? index : undefined;
    };

    const pushBounded = <T>(items: T[], item: T) => {
        items.push(item);
        if (items.length > MAX_DIAGNOSTIC_ENTRIES) {
            items.splice(0, items.length - MAX_DIAGNOSTIC_ENTRIES);
        }
    };

    const pageUrl = (page: Page): string => {
        try {
            return page.url();
        } catch {
            return '';
        }
    };

    const resolveSameOriginFetchUrl = (currentUrl: string, targetUrl: string): string => {
        let current: URL;
        let target: URL;
        try {
            current = new URL(currentUrl);
        } catch {
            throw new Error('Cannot fetch from the browser context because the active page has no valid URL.');
        }
        try {
            target = new URL(targetUrl, current);
        } catch {
            throw new Error(`Invalid fetch URL: ${targetUrl}`);
        }
        if (!/^https?:$/.test(current.protocol) || !/^https?:$/.test(target.protocol)) {
            throw new Error('Browser fetch supports http(s) pages only.');
        }
        if (target.origin !== current.origin) {
            throw new Error(`Browser fetch is limited to the active page origin (${current.origin}).`);
        }
        return target.toString();
    };

    const attachPageToSession = (
        session: BrowserSessionState,
        ownedPage: Page,
        ownership: Omit<PageOwnership, 'sessionId' | 'openedAt'> & { openedAt?: string },
    ) => {
        const previousOwner = pageOwners.get(ownedPage);
        if (previousOwner && previousOwner !== session) {
            previousOwner.pages = previousOwner.pages.filter((candidate) => candidate !== ownedPage);
            if (previousOwner.activePage === ownedPage) {
                previousOwner.activePage = previousOwner.pages[previousOwner.pages.length - 1] || null;
                previousOwner.lastMousePosition = null;
            }
        }

        if (!session.pages.includes(ownedPage)) {
            session.pages.push(ownedPage);
        }

        session.activePage = ownedPage;
        session.lastMousePosition = null;
        pageOwners.set(ownedPage, session);
        pageOwnership.set(ownedPage, {
            sessionId: session.id,
            openedAt: ownership.openedAt || new Date().toISOString(),
            origin: ownership.origin,
            openerPage: ownership.openerPage,
            openerUrl: ownership.openerUrl,
        });

        if (options.viewport) {
            void ownedPage.setViewportSize(options.viewport).catch(() => {
                // Ignore resize failures from browser-internal pages.
            });
        }

        if (instrumentedPages.has(ownedPage)) {
            return;
        }
        instrumentedPages.add(ownedPage);

        ownedPage.on('console', (message) => {
            const owner = pageOwners.get(ownedPage) || session;
            const location = message.location();
            pushBounded(owner.consoleMessages, {
                timestamp: new Date().toISOString(),
                level: message.type(),
                text: message.text(),
                url: location.url || pageUrl(ownedPage),
                lineNumber: location.lineNumber,
                columnNumber: location.columnNumber,
            });
        });

        ownedPage.on('pageerror', (error) => {
            const owner = pageOwners.get(ownedPage) || session;
            pushBounded(owner.pageErrors, {
                timestamp: new Date().toISOString(),
                message: error.message,
                stack: error.stack,
                url: pageUrl(ownedPage),
            });
        });

        ownedPage.on('requestfailed', (request) => {
            const owner = pageOwners.get(ownedPage) || session;
            pushBounded(owner.failedRequests, {
                timestamp: new Date().toISOString(),
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                failureText: request.failure()?.errorText || 'request failed',
            });
        });

        ownedPage.on('response', (response) => {
            const status = response.status();
            if (status < 400) return;

            const owner = pageOwners.get(ownedPage) || session;
            const request = response.request();
            pushBounded(owner.httpErrors, {
                timestamp: new Date().toISOString(),
                url: response.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                status,
                statusText: response.statusText(),
            });
        });

        ownedPage.on('popup', (popupPage) => {
            const openerOwner = pageOwners.get(ownedPage) || session;
            attachPageToSession(openerOwner, popupPage, {
                origin: 'popup',
                openerPage: ownedPage,
                openerUrl: ownedPage.url(),
            });
            log(`🔔 Popup attached to session "${openerOwner.id}" from ${ownedPage.url() || '(unknown URL)'}`);
            void popupPage.bringToFront().catch(() => {
                // Ignore if the popup closes before it can be focused.
            });
        });

        ownedPage.on('download', (download) => {
            const owner = pageOwners.get(ownedPage) || session;
            let sourceUrl = ownedPage.url();
            try {
                sourceUrl = download.url() || sourceUrl;
            } catch {
                // Keep the page URL as the best available source.
            }

            let suggestedFilename = '';
            try {
                suggestedFilename = download.suggestedFilename();
            } catch {
                suggestedFilename = '';
            }

            fs.mkdirSync(downloadsDir, { recursive: true });
            const filename = sanitizeDownloadFilename(suggestedFilename);
            const savedPath = uniqueDownloadPath(downloadsDir, filename);
            const record: BrowserDownloadFile = {
                id: `download_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
                url: sourceUrl,
                suggestedFilename: path.basename(savedPath),
                savedPath,
                state: 'pending',
            };

            owner.downloads.push(record);
            log(`⬇️ Browser download started: ${record.suggestedFilename}`);

            const task = download.saveAs(savedPath)
                .then(() => {
                    record.state = 'saved';
                    try {
                        record.size = fs.statSync(savedPath).size;
                    } catch {
                        record.size = undefined;
                    }
                    log(`✅ Browser download saved: ${savedPath}`);
                })
                .catch((error: unknown) => {
                    record.state = 'failed';
                    record.error = formatBrowserError(error);
                    logError(`⚠️ Browser download failed (${record.suggestedFilename}):`, error);
                });

            owner.downloadTasks.add(task);
            void task.finally(() => {
                owner.downloadTasks.delete(task);
            });
        });

        ownedPage.on('close', () => {
            const owner = pageOwners.get(ownedPage);
            if (!owner) return;

            owner.pages = owner.pages.filter((candidate) => candidate !== ownedPage);
            if (owner.activePage === ownedPage) {
                owner.activePage = owner.pages[owner.pages.length - 1] || null;
                owner.lastMousePosition = null;
            }
            pageOwners.delete(ownedPage);
            pageOwnership.delete(ownedPage);
        });
    };

    const ensureActivePage = async (session: BrowserSessionState): Promise<Page> => {
        if (!context) {
            throw new Error('Browser not launched');
        }

        const pages = getOpenOwnedPages(session);
        if (session.activePage && pages.includes(session.activePage)) {
            return session.activePage;
        }

        if (pages.length > 0) {
            session.activePage = pages[pages.length - 1];
            session.lastMousePosition = null;
            return session.activePage;
        }

        const newPage = await context.newPage();
        attachPageToSession(session, newPage, { origin: 'recovered' });
        return newPage;
    };

    const getFrameMetrics = async (activePage: Page): Promise<BrowserFrameMetrics> => {
        return activePage.evaluate(() => {
            const doc = document.documentElement;
            const body = document.body;

            const pageWidth = Math.max(
                window.innerWidth,
                doc?.scrollWidth || 0,
                doc?.clientWidth || 0,
                body?.scrollWidth || 0,
                body?.clientWidth || 0,
            );
            const pageHeight = Math.max(
                window.innerHeight,
                doc?.scrollHeight || 0,
                doc?.clientHeight || 0,
                body?.scrollHeight || 0,
                body?.clientHeight || 0,
            );

            return {
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                pageWidth,
                pageHeight,
                scrollX: window.scrollX,
                scrollY: window.scrollY,
            };
        });
    };

    const withViewportOverlay = async <T>(activePage: Page, work: () => Promise<T>): Promise<T> => {
        const overlayId = `__ai_browser_agent_viewport_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

        try {
            await activePage.evaluate((id) => {
                document.getElementById(id)?.remove();

                const overlay = document.createElement('div');
                overlay.id = id;
                overlay.setAttribute('data-ai-browser-agent-overlay', 'viewport');
                overlay.style.position = 'absolute';
                overlay.style.left = `${window.scrollX}px`;
                overlay.style.top = `${window.scrollY}px`;
                overlay.style.width = `${window.innerWidth}px`;
                overlay.style.height = `${window.innerHeight}px`;
                overlay.style.boxSizing = 'border-box';
                overlay.style.border = '4px solid rgba(255, 59, 48, 0.95)';
                overlay.style.background = 'rgba(255, 59, 48, 0.08)';
                overlay.style.pointerEvents = 'none';
                overlay.style.zIndex = '2147483647';
                overlay.style.borderRadius = '2px';

                (document.body || document.documentElement).appendChild(overlay);
            }, overlayId);

            return await work();
        } finally {
            try {
                await activePage.evaluate((id) => {
                    document.getElementById(id)?.remove();
                }, overlayId);
            } catch {
                // Ignore cleanup errors when the page changes mid-capture.
            }
        }
    };

    const captureFrame = async (
        session: BrowserSessionState,
        source: BrowserFrameSource,
        quality: number,
        trackInHistory: boolean,
        captureMode: BrowserCaptureMode = 'viewport',
        options: { fullPage?: boolean; highlightViewport?: boolean } = {},
    ): Promise<BrowserFrameSnapshot> => {
        const activePage = await ensureActivePage(session);
        const metrics = await getFrameMetrics(activePage);

        if (source === 'agent') {
            const captureLabel = captureMode === 'overview'
                ? `overview ${metrics.pageWidth}x${metrics.pageHeight}`
                : `viewport ${metrics.viewportWidth}x${metrics.viewportHeight}`;
            log(`📸 Screenshot ${captureLabel} (${source})`);
        }

        const takeScreenshot = () => activePage.screenshot({
            type: 'jpeg',
            quality,
            fullPage: options.fullPage ?? false,
        });
        const buffer = options.highlightViewport
            ? await withViewportOverlay(activePage, takeScreenshot)
            : await takeScreenshot();
        const frame: BrowserFrameSnapshot = {
            id: toFrameId(++session.frameSequence),
            source,
            timestamp: new Date().toISOString(),
            imageBase64: buffer.toString('base64'),
            url: activePage.url(),
            captureMode,
            coordinateSpace: 'normalized-viewport',
            viewport: {
                width: metrics.viewportWidth,
                height: metrics.viewportHeight,
            },
            page: {
                width: metrics.pageWidth,
                height: metrics.pageHeight,
                scrollX: metrics.scrollX,
                scrollY: metrics.scrollY,
            },
        };

        if (trackInHistory) {
            session.latestAgentFrame = frame;
            session.agentFrameHistory.push(frame);
            if (session.agentFrameHistory.length > MAX_AGENT_FRAME_HISTORY) {
                session.agentFrameHistory = session.agentFrameHistory.slice(-MAX_AGENT_FRAME_HISTORY);
            }
        }

        return frame;
    };

    const captureTraceFrame = async (session: BrowserSessionState, frames: ActionTraceFrame[], label: string): Promise<void> => {
        try {
            const frame = await captureFrame(session, 'live', 78, false);
            frames.push({
                ...frame,
                label,
            });
        } catch (error) {
            logError(`⚠️ Trace frame skipped (${label}):`, error);
        }
    };

    // Fire-and-forget version: captures screenshot in background without blocking the action.
    // Returns a promise that resolves to the frame (or null on error).
    // Caller collects promises and awaits them all at the end.
    const captureTraceFrameAsync = (session: BrowserSessionState, label: string): Promise<ActionTraceFrame | null> => {
        return captureFrame(session, 'live', 78, false)
            .then(frame => ({ ...frame, label } as ActionTraceFrame))
            .catch(error => {
                logError(`⚠️ Trace frame skipped (${label}):`, error);
                return null;
            });
    };

    const buildTraceResult = (
        action: ActionTrace['action'],
        intervalMs: number,
        frames: ActionTraceFrame[],
    ): ActionTrace => ({
        action,
        intervalMs,
        frames: compressTraceFrames(frames),
    });

    const startVideoEncoder = async (
        width: number,
        height: number,
        fps: number,
    ): Promise<Page> => {
        if (!context) {
            throw new Error('Browser not launched');
        }

        const encoderPage = await context.newPage();
        await encoderPage.setViewportSize({ width, height });
        await encoderPage.setContent('<!doctype html><html><body style="margin:0;background:#000"></body></html>');
        await encoderPage.evaluate(({ canvasWidth, canvasHeight, framesPerSecond }) => {
            type RecorderState = {
                canvas: HTMLCanvasElement;
                ctx: CanvasRenderingContext2D;
                recorder: MediaRecorder;
                chunks: Blob[];
                stopped: Promise<{ mimeType: string; videoBase64: string }>;
            };
            const global = window as typeof window & { __browserAgentVideoRecorder?: RecorderState };
            const candidates = [
                'video/webm;codecs=vp9',
                'video/webm;codecs=vp8',
                'video/webm',
            ];
            const mimeType = candidates.find(candidate => MediaRecorder.isTypeSupported(candidate)) || 'video/webm';
            const canvas = document.createElement('canvas');
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            document.body.appendChild(canvas);
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                throw new Error('Unable to create video canvas context');
            }
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const stream = canvas.captureStream(framesPerSecond);
            const chunks: Blob[] = [];
            const recorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 2_500_000,
            });
            const stopped = new Promise<{ mimeType: string; videoBase64: string }>((resolve, reject) => {
                recorder.ondataavailable = event => {
                    if (event.data.size > 0) chunks.push(event.data);
                };
                recorder.onerror = () => reject(new Error('Browser video recorder failed'));
                recorder.onstop = async () => {
                    try {
                        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
                        const bytes = new Uint8Array(await blob.arrayBuffer());
                        let binary = '';
                        const chunkSize = 0x8000;
                        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                            binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
                        }
                        resolve({
                            mimeType: blob.type || 'video/webm',
                            videoBase64: btoa(binary),
                        });
                    } catch (error) {
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                };
            });
            recorder.start();
            global.__browserAgentVideoRecorder = { canvas, ctx, recorder, chunks, stopped };
        }, { canvasWidth: width, canvasHeight: height, framesPerSecond: fps });

        return encoderPage;
    };

    const appendVideoFrame = async (encoderPage: Page, imageBase64: string): Promise<void> => {
        await encoderPage.evaluate(async (jpegBase64) => {
            type RecorderState = {
                canvas: HTMLCanvasElement;
                ctx: CanvasRenderingContext2D;
                recorder: MediaRecorder;
                chunks: Blob[];
                stopped: Promise<{ mimeType: string; videoBase64: string }>;
            };
            const global = window as typeof window & { __browserAgentVideoRecorder?: RecorderState };
            const state = global.__browserAgentVideoRecorder;
            if (!state) {
                throw new Error('Browser video recorder is not active');
            }

            const image = new Image();
            await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error('Unable to decode browser video frame'));
                image.src = `data:image/jpeg;base64,${jpegBase64}`;
            });
            state.ctx.drawImage(image, 0, 0, state.canvas.width, state.canvas.height);
        }, imageBase64);
    };

    const stopVideoEncoder = async (encoderPage: Page): Promise<{ mimeType: string; videoBase64: string }> => {
        return encoderPage.evaluate(async () => {
            type RecorderState = {
                canvas: HTMLCanvasElement;
                ctx: CanvasRenderingContext2D;
                recorder: MediaRecorder;
                chunks: Blob[];
                stopped: Promise<{ mimeType: string; videoBase64: string }>;
            };
            const global = window as typeof window & { __browserAgentVideoRecorder?: RecorderState };
            const state = global.__browserAgentVideoRecorder;
            if (!state) {
                throw new Error('Browser video recorder is not active');
            }

            const resultPromise = state.stopped;
            state.recorder.stop();
            return resultPromise;
        });
    };

    const describeTabs = async (session: BrowserSessionState): Promise<BrowserTabInfo[]> => {
        const pages = getOpenOwnedPages(session);
        const results: BrowserTabInfo[] = [];

        for (let i = 0; i < pages.length; i++) {
            const ownedPage = pages[i];
            const ownership = pageOwnership.get(ownedPage);
            let title = '';
            try {
                title = await ownedPage.title();
            } catch {
                title = '(unknown)';
            }

            results.push({
                index: i,
                title,
                url: ownedPage.url(),
                isActive: ownedPage === session.activePage,
                sessionId: session.id,
                openedAt: ownership?.openedAt || session.createdAt,
                origin: ownership?.origin || 'recovered',
                openerTabIndex: ownership?.openerPage ? getSessionPageIndex(session, ownership.openerPage) : undefined,
                openerUrl: ownership?.openerUrl,
            });
        }

        return results;
    };

    const waitForSessionDownloads = async (
        session: BrowserSessionState,
        timeoutMs = 5000,
        options: BrowserDownloadWaitOptions = {},
    ): Promise<void> => {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        const baselineCount = typeof options.baselineCount === 'number' && Number.isFinite(options.baselineCount)
            ? Math.max(0, Math.floor(options.baselineCount))
            : session.downloads.length;
        const waitForNew = options.waitForNew === true;
        let sawNewDownload = session.downloads.length > baselineCount;

        for (;;) {
            const tasks = [...session.downloadTasks];
            const remainingMs = deadline - Date.now();
            if (tasks.length === 0) {
                sawNewDownload = sawNewDownload || session.downloads.length > baselineCount;
                if (!waitForNew || sawNewDownload || remainingMs <= 0) return;
                await sleep(Math.min(remainingMs, 250));
                continue;
            }

            if (remainingMs <= 0) return;
            await Promise.race([
                Promise.allSettled(tasks),
                sleep(Math.min(remainingMs, 250)),
            ]);
        }
    };

    const isReusableInitialBlankPage = (candidatePage: Page): boolean => {
        const ownership = pageOwnership.get(candidatePage);
        if (ownership?.sessionId !== defaultSessionState.id || ownership.origin !== 'initial') {
            return false;
        }

        const url = candidatePage.url();
        return url === ''
            || url === 'about:blank'
            || url.startsWith('chrome://new-tab')
            || url.startsWith('chrome://newtab');
    };

    const takeReusableInitialBlankPage = (): Page | null => {
        const pages = getOpenOwnedPages(defaultSessionState);
        return pages.find(isReusableInitialBlankPage) ?? null;
    };

    const createSessionFacade = (session: BrowserSessionState): BrowserPageSession => {
        const capabilities: BrowserPageSessionCapabilities = {
            backend,
            coordinateSpace: 'normalized-viewport',
            domInspection: true,
            overviewCapture: true,
            tabEnumeration: true,
            downloadEvents: true,
            displayCapture: false,
            osClipboard: false,
            diagnostics: true,
            browserFetch: true,
        };
        const facade: BrowserPageSession = {
            id: session.id,
            createdAt: session.createdAt,
            capabilities,

            async screenshot(source: BrowserFrameSource = 'agent'): Promise<string> {
                const frame = await captureFrame(session, source, 90, source === 'agent');
                return frame.imageBase64;
            },

            async captureAgentFrame(): Promise<BrowserFrameSnapshot> {
                return captureFrame(session, 'agent', 90, true);
            },

            async captureLiveFrame(): Promise<BrowserFrameSnapshot> {
                return captureFrame(session, 'live', 80, false);
            },

            async captureOverviewFrame(): Promise<BrowserFrameSnapshot> {
                return captureFrame(session, 'agent', 60, false, 'overview', {
                    fullPage: true,
                    highlightViewport: true,
                });
            },

            async recordVideo(durationMs?: number): Promise<BrowserVideoRecording> {
                const activePage = await ensureActivePage(session);
                const metrics = await getFrameMetrics(activePage);
                const recordingDurationMs = clampDurationMs(
                    durationMs,
                    DEFAULT_VIDEO_DURATION_MS,
                    MIN_VIDEO_DURATION_MS,
                    MAX_VIDEO_DURATION_MS,
                );
                const fps = DEFAULT_VIDEO_FPS;
                const intervalMs = Math.round(1000 / fps);
                const width = Math.max(1, Math.round(metrics.viewportWidth));
                const height = Math.max(1, Math.round(metrics.viewportHeight));
                const url = activePage.url();
                let frameCount = 0;
                let encoderPage: Page | null = null;

                log(`🎥 Recording visible viewport for ${Math.round(recordingDurationMs / 1000)}s...`);

                try {
                    encoderPage = await startVideoEncoder(width, height, fps);
                    const startedAt = Date.now();
                    let nextCaptureAt = startedAt;

                    do {
                        const buffer = await activePage.screenshot({
                            type: 'jpeg',
                            quality: 78,
                            fullPage: false,
                        });
                        await appendVideoFrame(encoderPage, buffer.toString('base64'));
                        frameCount += 1;

                        nextCaptureAt += intervalMs;
                        const delay = nextCaptureAt - Date.now();
                        if (delay > 0) {
                            await sleep(delay);
                        }
                    } while (Date.now() - startedAt < recordingDurationMs);

                    const encoded = await stopVideoEncoder(encoderPage);
                    return {
                        id: `video_${Date.now().toString(36)}_${frameCount.toString(36)}`,
                        timestamp: new Date().toISOString(),
                        mimeType: encoded.mimeType.split(';')[0] || 'video/webm',
                        videoBase64: encoded.videoBase64,
                        url,
                        durationMs: Date.now() - startedAt,
                        fps,
                        frameCount,
                        viewport: { width, height },
                        page: {
                            width: metrics.pageWidth,
                            height: metrics.pageHeight,
                            scrollX: metrics.scrollX,
                            scrollY: metrics.scrollY,
                        },
                    };
                } finally {
                    if (encoderPage) {
                        try {
                            await encoderPage.close();
                        } catch {
                            // Ignore cleanup errors from the temporary encoder tab.
                        }
                    }
                    try {
                        await activePage.bringToFront();
                    } catch {
                        // Ignore if the recorded page closed while recording.
                    }
                }
            },

            async clickCoordinate(x: number, y: number, count: number = 1): Promise<boolean> {
                const activePage = await ensureActivePage(session);

                const { width: maxX, height: maxY } = await activePage.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight
                }));

                const safeX = Math.max(0, Math.min(x, maxX - 1));
                const safeY = Math.max(0, Math.min(y, maxY - 1));

                if (safeX !== x || safeY !== y) {
                    log(`⚠️ Clamping coordinates from [${x}, ${y}] to [${safeX}, ${safeY}] (Viewport: ${maxX}x${maxY})`);
                }

                try {
                    log(`🖱️ Clicking at ${safeX}, ${safeY} (Count: ${count})`);

                    await humanMouseMove(
                        activePage,
                        safeX,
                        safeY,
                        session.lastMousePosition?.x,
                        session.lastMousePosition?.y,
                    );
                    await activePage.mouse.move(safeX, safeY);
                    session.lastMousePosition = { x: safeX, y: safeY };

                    await sleep(12 + Math.random() * 16);

                    if (count === 2) {
                        await activePage.mouse.click(safeX, safeY, { clickCount: 2, delay: 70 });
                    } else {
                        await activePage.mouse.click(safeX, safeY, { delay: 24 });
                    }

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

                                const parent = document.fullscreenElement || document.documentElement || document.body;
                                if (parent) parent.appendChild(div);

                                setTimeout(() => div.remove(), 2000);
                            } catch {
                                // Ignore internal DOM errors
                            }
                        }, { x: safeX, y: safeY });
                    } catch {
                        // Navigation happened.
                    }

                    return true;
                } catch (e) {
                    logError('Click failed:', e);
                    return false;
                }
            },

            async dragCoordinate(
                startX: number,
                startY: number,
                endX: number,
                endY: number,
                durationMs: number = DEFAULT_DRAG_DURATION_MS,
            ): Promise<TracedActionResult> {
                const activePage = await ensureActivePage(session);
                const traceFrames: ActionTraceFrame[] = [];

                const { width: maxX, height: maxY } = await activePage.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight
                }));

                const safeStartX = Math.max(0, Math.min(startX, maxX - 1));
                const safeStartY = Math.max(0, Math.min(startY, maxY - 1));
                const safeEndX = Math.max(0, Math.min(endX, maxX - 1));
                const safeEndY = Math.max(0, Math.min(endY, maxY - 1));

                if (safeStartX !== startX || safeStartY !== startY) {
                    log(`⚠️ Clamping drag start from [${startX}, ${startY}] to [${safeStartX}, ${safeStartY}] (Viewport: ${maxX}x${maxY})`);
                }
                if (safeEndX !== endX || safeEndY !== endY) {
                    log(`⚠️ Clamping drag end from [${endX}, ${endY}] to [${safeEndX}, ${safeEndY}] (Viewport: ${maxX}x${maxY})`);
                }

                try {
                    log(`🖱️ Dragging from [${safeStartX}, ${safeStartY}] to [${safeEndX}, ${safeEndY}] (${durationMs}ms)`);
                    const dragDuration = Math.max(200, durationMs);
                    const traceFrameCount = getActionTraceFrameCount(dragDuration);

                    await humanMouseMove(activePage, safeStartX, safeStartY, session.lastMousePosition?.x, session.lastMousePosition?.y);
                    await activePage.mouse.move(safeStartX, safeStartY);
                    session.lastMousePosition = { x: safeStartX, y: safeStartY };

                    await sleep(80 + Math.random() * 60);

                    let mouseIsDown = false;
                    let success = false;
                    await activePage.mouse.down();
                    mouseIsDown = true;
                    const traceRatios = getTraceCaptureRatios(traceFrameCount);
                    const traceIntervalMs = getTraceCaptureInterval(dragDuration, traceFrameCount);
                    const pendingCaptures: Promise<ActionTraceFrame | null>[] = [
                        captureTraceFrameAsync(session, `drag-1/${traceFrameCount}`),
                    ];
                    let nextTraceCaptureIndex = 1;

                    await sleep(100 + Math.random() * 80);

                    try {
                        await activePage.evaluate(({ x, y }) => {
                            try {
                                const old = document.getElementById('ai-drag-marker');
                                if (old) old.remove();

                                const div = document.createElement('div');
                                div.style.position = 'fixed';
                                div.style.left = `${x - 10}px`;
                                div.style.top = `${y - 10}px`;
                                div.style.width = '20px';
                                div.style.height = '20px';
                                div.style.borderRadius = '50%';
                                div.style.backgroundColor = 'rgba(128, 0, 128, 0.7)';
                                div.style.border = '3px solid white';
                                div.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
                                div.style.zIndex = '2147483647';
                                div.style.pointerEvents = 'none';
                                div.id = 'ai-drag-marker';

                                const parent = document.fullscreenElement || document.documentElement || document.body;
                                if (parent) parent.appendChild(div);
                            } catch {}
                        }, { x: safeStartX, y: safeStartY });
                    } catch {}

                    try {
                        await humanMouseMove(activePage, safeEndX, safeEndY, safeStartX, safeStartY, {
                            durationMs: dragDuration,
                            onAfterStep: async ({ x, y, step, totalSteps }) => {
                                try {
                                    await activePage.evaluate(({ currentX, currentY }) => {
                                        const div = document.getElementById('ai-drag-marker');
                                        if (div) {
                                            div.style.left = `${currentX - 10}px`;
                                            div.style.top = `${currentY - 10}px`;
                                        }
                                    }, { currentX: x, currentY: y });
                                } catch {}

                                const progress = step / totalSteps;
                                while (
                                    nextTraceCaptureIndex < traceRatios.length &&
                                    progress >= traceRatios[nextTraceCaptureIndex]
                                ) {
                                    pendingCaptures.push(
                                        captureTraceFrameAsync(session, `drag-${nextTraceCaptureIndex + 1}/${traceFrameCount}`)
                                    );
                                    nextTraceCaptureIndex++;
                                }
                            },
                        });
                        await activePage.mouse.move(safeEndX, safeEndY);
                        session.lastMousePosition = { x: safeEndX, y: safeEndY };

                        await sleep(60 + Math.random() * 40);
                        success = true;
                    } finally {
                        try {
                            await activePage.evaluate(() => {
                                const div = document.getElementById('ai-drag-marker');
                                if (div) div.remove();
                            });
                        } catch {}

                        if (mouseIsDown) {
                            try {
                                await activePage.mouse.up();
                            } catch (releaseError) {
                                logError('Drag release failed:', releaseError);
                                success = false;
                            }
                        }
                    }

                    const capturedDragFrames = await Promise.all(pendingCaptures);
                    traceFrames.push(...capturedDragFrames.filter((f): f is ActionTraceFrame => f !== null));
                    return {
                        success,
                        trace: buildTraceResult('drag', traceIntervalMs, traceFrames),
                    };
                } catch (e) {
                    logError('Drag failed:', e);
                    await captureTraceFrame(session, traceFrames, 'drag-error');
                    return {
                        success: false,
                        trace: buildTraceResult('drag', getTraceCaptureInterval(Math.max(200, durationMs)), traceFrames),
                    };
                }
            },

            async holdCoordinate(x: number, y: number, durationMs: number = 10000): Promise<TracedActionResult> {
                const activePage = await ensureActivePage(session);
                const traceFrames: ActionTraceFrame[] = [];

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

                    await humanMouseMove(
                        activePage,
                        safeX,
                        safeY,
                        session.lastMousePosition?.x,
                        session.lastMousePosition?.y,
                    );
                    await activePage.mouse.move(safeX, safeY);
                    session.lastMousePosition = { x: safeX, y: safeY };
                    await sleep(120 + Math.random() * 80);

                    const holdDuration = Math.max(200, durationMs);
                    const traceFrameCount = getActionTraceFrameCount(holdDuration);
                    const traceIntervalMs = getTraceCaptureInterval(holdDuration, traceFrameCount);
                    let mouseIsDown = false;
                    let success = false;

                    const pendingCaptures: Promise<ActionTraceFrame | null>[] = [];
                    try {
                        await activePage.mouse.down();
                        mouseIsDown = true;

                        try {
                            await activePage.evaluate(({ x, y, durationMs }) => {
                                try {
                                    const div = document.createElement('div');
                                    div.style.position = 'fixed';
                                    div.style.left = `${x - 10}px`;
                                    div.style.top = `${y - 10}px`;
                                    div.style.width = '20px';
                                    div.style.height = '20px';
                                    div.style.borderRadius = '50%';
                                    div.style.backgroundColor = 'rgba(255, 165, 0, 0.7)';
                                    div.style.border = '3px solid white';
                                    div.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
                                    div.style.zIndex = '2147483647';
                                    div.style.pointerEvents = 'none';
                                    div.id = `ai-hold-${Date.now()}`;

                                    const parent = document.fullscreenElement || document.documentElement || document.body;
                                    if (parent) parent.appendChild(div);

                                    const holdDurationForMarker = Math.max(200, durationMs || 10000);
                                    setTimeout(() => div.remove(), holdDurationForMarker);
                                } catch {}
                            }, { x: safeX, y: safeY, durationMs: holdDuration });
                        } catch {}

                        pendingCaptures.push(captureTraceFrameAsync(session, `hold-1/${traceFrameCount}`));

                        const startedAt = Date.now();
                        for (let captureIndex = 1; captureIndex < traceFrameCount; captureIndex++) {
                            const targetElapsedMs = Math.round(
                                (holdDuration * captureIndex) / (traceFrameCount - 1)
                            );
                            const elapsedMs = Date.now() - startedAt;
                            const waitMs = Math.max(0, targetElapsedMs - elapsedMs);
                            await sleep(waitMs);
                            pendingCaptures.push(
                                captureTraceFrameAsync(session, `hold-${captureIndex + 1}/${traceFrameCount}`)
                            );
                        }

                        success = true;
                    } finally {
                        if (mouseIsDown) {
                            try {
                                await activePage.mouse.up();
                            } catch (releaseError) {
                                logError('Hold release failed:', releaseError);
                                success = false;
                            }
                        }
                    }

                    const capturedHoldFrames = await Promise.all(pendingCaptures);
                    traceFrames.push(...capturedHoldFrames.filter((f): f is ActionTraceFrame => f !== null));
                    return {
                        success,
                        trace: buildTraceResult('hold', traceIntervalMs, traceFrames),
                    };
                } catch (e) {
                    logError('Hold failed:', e);
                    await captureTraceFrame(session, traceFrames, 'hold-error');
                    return {
                        success: false,
                        trace: buildTraceResult('hold', getTraceCaptureInterval(Math.max(200, durationMs)), traceFrames),
                    };
                }
            },

            async hoverCoordinate(x: number, y: number): Promise<void> {
                const activePage = await ensureActivePage(session);
                const { width, height } = await activePage.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight,
                }));
                const safeX = Math.max(0, Math.min(x, width - 1));
                const safeY = Math.max(0, Math.min(y, height - 1));

                log(`🖱️ Hovering at ${safeX}, ${safeY}`);
                await humanMouseMove(
                    activePage,
                    safeX,
                    safeY,
                    session.lastMousePosition?.x,
                    session.lastMousePosition?.y,
                );
                await activePage.mouse.move(safeX, safeY);
                session.lastMousePosition = { x: safeX, y: safeY };
            },

            async type(text: string) {
                const activePage = await ensureActivePage(session);
                await activePage.bringToFront();
                await activePage.keyboard.type(text, { delay: 32 });
            },

            async paste(text: string) {
                const activePage = await ensureActivePage(session);
                await pasteTextIntoPage(activePage, text);
            },

            async readClipboard(): Promise<string | null> {
                const activePage = await ensureActivePage(session);
                await activePage.bringToFront();
                await grantClipboardAccess(activePage);

                try {
                    const value = await activePage.evaluate(async () => {
                        if (!navigator.clipboard?.readText) {
                            return null;
                        }
                        return navigator.clipboard.readText();
                    });
                    if (typeof value === 'string') {
                        return value;
                    }
                } catch (error) {
                    log(`⚠️ navigator.clipboard.readText failed: ${formatBrowserError(error)}`);
                }

                return readClipboardByPaste(activePage);
            },

            async clear() {
                const activePage = await ensureActivePage(session);
                await selectAllAndClear(activePage);
            },

            async pressKey(key: string) {
                const activePage = await ensureActivePage(session);
                await activePage.keyboard.press(key);
            },

            async findInPage(query: string, next: boolean = false) {
                const activePage = await ensureActivePage(session);
                const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

                await activePage.keyboard.down(modifier);
                await activePage.keyboard.press('f');
                await activePage.keyboard.up(modifier);
                await sleep(80);
                await activePage.keyboard.down(modifier);
                await activePage.keyboard.press('a');
                await activePage.keyboard.up(modifier);
                await activePage.keyboard.type(query);
                if (next) {
                    await activePage.keyboard.press('Enter');
                }
            },

            async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number = 500) {
                const activePage = await ensureActivePage(session);
                const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
                const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
                await activePage.mouse.wheel(deltaX, deltaY);
            },

            async scrollToBottom() {
                const activePage = await ensureActivePage(session);
                const pointer = session.lastMousePosition;
                await activePage.evaluate((lastPointer) => {
                    const maxScrollTop = (element: Element) => Math.max(0, element.scrollHeight - element.clientHeight);
                    const canScrollVertically = (element: Element) => {
                        if (!(element instanceof HTMLElement)) return false;
                        return maxScrollTop(element) > 1;
                    };
                    const scrollElementToBottom = (element: Element) => {
                        if (element instanceof HTMLElement) {
                            element.scrollTop = element.scrollHeight;
                            element.dispatchEvent(new Event('scroll', { bubbles: true }));
                        }
                    };
                    const scrollAncestorToBottom = (start: Element | null) => {
                        let current: Element | null = start;
                        while (current && current !== document.documentElement) {
                            if (current === document.body && document.scrollingElement !== document.body) {
                                current = current.parentElement;
                                continue;
                            }
                            if (canScrollVertically(current)) {
                                scrollElementToBottom(current);
                                return true;
                            }
                            current = current.parentElement;
                        }
                        return false;
                    };

                    const candidates: Element[] = [];
                    if (lastPointer) {
                        const pointed = document.elementFromPoint(lastPointer.x, lastPointer.y);
                        if (pointed) candidates.push(pointed);
                    }
                    if (document.activeElement) {
                        candidates.push(document.activeElement);
                    }

                    for (const candidate of candidates) {
                        if (scrollAncestorToBottom(candidate)) return;
                    }

                    const root = document.scrollingElement || document.documentElement;
                    root.scrollTop = root.scrollHeight;
                    window.scrollTo(0, Math.max(
                        document.documentElement.scrollHeight,
                        document.body?.scrollHeight || 0,
                    ));
                }, pointer);
            },

            async undo() {
                const activePage = await ensureActivePage(session);
                const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
                await pressShortcut(activePage, `${modifier}+z`);
            },

            async navigate(url: string) {
                const activePage = await ensureActivePage(session);
                await activePage.goto(url, { waitUntil: 'domcontentloaded' });
                await grantClipboardAccess(activePage);
            },

            async goBack() {
                const activePage = await ensureActivePage(session);
                await activePage.goBack();
            },

            async goForward() {
                const activePage = await ensureActivePage(session);
                await activePage.goForward();
            },

            async reloadPage() {
                const activePage = await ensureActivePage(session);
                await activePage.reload();
            },

            async closeTab(index?: number): Promise<boolean> {
                if (!context) {
                    return false;
                }

                const pages = getOpenOwnedPages(session);
                if (pages.length <= 1) {
                    log(`⚠️ Refusing to close the last remaining tab in session "${session.id}"`);
                    return false;
                }

                const activeIndex = session.activePage ? pages.indexOf(session.activePage) : -1;
                const targetIndex = index ?? activeIndex;
                if (targetIndex < 0 || targetIndex >= pages.length) {
                    log(`⚠️ Tab index ${targetIndex} out of range for session "${session.id}" (0-${pages.length - 1})`);
                    return false;
                }

                const targetPage = pages[targetIndex];
                const wasActive = targetPage === session.activePage;

                await targetPage.close();

                if (wasActive) {
                    const remainingPages = getOpenOwnedPages(session);
                    session.activePage = remainingPages[Math.min(targetIndex, remainingPages.length - 1)] ?? remainingPages[remainingPages.length - 1] ?? null;
                    if (session.activePage) {
                        await session.activePage.bringToFront();
                    }
                    session.lastMousePosition = null;
                }

                log(`🗑️ Closed tab ${targetIndex} in session "${session.id}"${wasActive ? ' (active)' : ''}`);
                return true;
            },

            async listTabs(): Promise<BrowserTabInfo[]> {
                return describeTabs(session);
            },

            async switchTab(index: number): Promise<boolean> {
                if (!context) return false;
                const pages = getOpenOwnedPages(session);
                if (index < 0 || index >= pages.length) {
                    log(`⚠️ Tab index ${index} out of range for session "${session.id}" (0-${pages.length - 1})`);
                    return false;
                }
                session.activePage = pages[index];
                await session.activePage.bringToFront();
                session.lastMousePosition = null;
                log(`🔀 Switched session "${session.id}" to tab ${index}: ${session.activePage.url()}`);
                return true;
            },

            async newTab(url?: string): Promise<boolean> {
                if (!context) return false;
                try {
                    const newPage = await context.newPage();
                    attachPageToSession(session, newPage, { origin: 'newTab' });
                    if (url) {
                        await newPage.goto(url, { waitUntil: 'domcontentloaded' });
                    }
                    await newPage.bringToFront();
                    log(`➕ New tab opened in session "${session.id}"${url ? `: ${url}` : ''}`);
                    return true;
                } catch (e) {
                    logError('Failed to open new tab:', e);
                    return false;
                }
            },

            async getHrefAt(x: number, y: number): Promise<string | null> {
                const activePage = await ensureActivePage(session);
                const { width: maxX, height: maxY } = await activePage.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight
                }));
                const safeX = Math.max(0, Math.min(x, maxX - 1));
                const safeY = Math.max(0, Math.min(y, maxY - 1));

                return activePage.evaluate(({ x: pointX, y: pointY }) => {
                    const element = document.elementFromPoint(pointX, pointY);
                    if (!element) return null;
                    const anchor = element.closest('a');
                    return anchor ? anchor.href : null;
                }, { x: safeX, y: safeY });
            },

            getPage(): Page | null {
                getOpenOwnedPages(session);
                return session.activePage;
            },

            getPageUrl(): string {
                getOpenOwnedPages(session);
                return session.activePage ? session.activePage.url() : '';
            },

            getOpenTabCount(): Promise<number> {
                return Promise.resolve(getOpenOwnedPages(session).length);
            },

            async getViewport(): Promise<{ width: number; height: number }> {
                try {
                    const activePage = await ensureActivePage(session);
                    return await activePage.evaluate(() => ({
                        width: window.innerWidth,
                        height: window.innerHeight
                    }));
                } catch {
                    return { ...DEFAULT_VIEWPORT };
                }
            },

            getDownloads(): BrowserDownloadFile[] {
                return session.downloads.map((download) => cloneDownload(download));
            },

            async waitForDownloads(timeoutMs?: number, options?: BrowserDownloadWaitOptions): Promise<BrowserDownloadFile[]> {
                await waitForSessionDownloads(session, timeoutMs, options);
                return session.downloads.map((download) => cloneDownload(download));
            },

            getDiagnostics(): BrowserDiagnosticsSnapshot {
                return {
                    supported: true,
                    capturedAt: new Date().toISOString(),
                    currentUrl: session.activePage ? pageUrl(session.activePage) : '',
                    consoleMessages: session.consoleMessages.map((entry) => ({ ...entry })),
                    pageErrors: session.pageErrors.map((entry) => ({ ...entry })),
                    failedRequests: session.failedRequests.map((entry) => ({ ...entry })),
                    httpErrors: session.httpErrors.map((entry) => ({ ...entry })),
                };
            },

            async fetchUrl(url: string): Promise<BrowserFetchResult> {
                const activePage = await ensureActivePage(session);
                const requestedUrl = resolveSameOriginFetchUrl(activePage.url(), url);

                try {
                    const result = await activePage.evaluate(async ({ targetUrl, maxBodyChars }) => {
                        const response = await fetch(targetUrl, {
                            method: 'GET',
                            credentials: 'include',
                            cache: 'no-store',
                            headers: {
                                Accept: 'application/json, text/plain, */*',
                            },
                        });
                        const body = await response.text();
                        return {
                            finalUrl: response.url,
                            ok: response.ok,
                            status: response.status,
                            statusText: response.statusText,
                            contentType: response.headers.get('content-type') || '',
                            redirected: response.redirected,
                            bodyLength: body.length,
                            bodySnippet: body.slice(0, maxBodyChars),
                        };
                    }, { targetUrl: requestedUrl, maxBodyChars: MAX_FETCH_BODY_CHARS });

                    return {
                        supported: true,
                        requestedUrl,
                        ...result,
                    };
                } catch (error) {
                    return {
                        supported: true,
                        requestedUrl,
                        finalUrl: requestedUrl,
                        ok: false,
                        status: 0,
                        statusText: '',
                        contentType: '',
                        redirected: false,
                        bodyLength: 0,
                        bodySnippet: '',
                        error: formatBrowserError(error),
                    };
                }
            },

            getLatestAgentFrame(): BrowserFrameSnapshot | null {
                return session.latestAgentFrame ? cloneFrame(session.latestAgentFrame) : null;
            },

            getAgentFrameHistory(limit: number = MAX_AGENT_FRAME_HISTORY): BrowserFrameSnapshot[] {
                const safeLimit = Number.isFinite(limit) && limit > 0
                    ? Math.min(Math.floor(limit), MAX_AGENT_FRAME_HISTORY)
                    : MAX_AGENT_FRAME_HISTORY;
                return session.agentFrameHistory
                    .slice(-safeLimit)
                    .map((frame) => cloneFrame(frame));
            },

            clearAgentFrameHistory(): void {
                session.latestAgentFrame = null;
                session.agentFrameHistory = [];
            },

            async closeOwnedPages(): Promise<void> {
                const pages = [...getOpenOwnedPages(session)];
                await Promise.allSettled(pages.map((ownedPage) => ownedPage.close()));
                session.pages = [];
                session.activePage = null;
                session.lastMousePosition = null;
                session.latestAgentFrame = null;
                session.agentFrameHistory = [];
            },
        };

        return facade;
    };

    const getOrCreateSessionFacade = (session: BrowserSessionState): BrowserPageSession => {
        const existing = sessionFacades.get(session.id);
        if (existing) return existing;

        const facade = createSessionFacade(session);
        sessionFacades.set(session.id, facade);
        return facade;
    };

    const defaultSession = getOrCreateSessionFacade(defaultSessionState);

    const manager: BrowserManager = {
        ...defaultSession,

        async launch() {
            if (context) {
                return;
            }

            ensureBrowserProfileDir(userDataDir, log, logError);
            fs.mkdirSync(downloadsDir, { recursive: true });

            const liveViewEnabled = Boolean(options.liveView) || process.platform === 'darwin';
            if (liveViewEnabled && !displayController) {
                displayController = createBrowserDisplayController({
                    enabled: liveViewEnabled,
                    viewport: options.viewport ?? DEFAULT_VIEWPORT,
                    onLog: log,
                });
            }

            if (displayController) {
                try {
                    lastLiveViewState = await displayController.ensureStarted();
                } catch (err) {
                    const reason = `Live display failed to start: ${formatBrowserError(err)}`;
                    log(`⚠️ ${reason}`);
                    await displayController.close().catch(() => {});
                    lastLiveViewState = {
                        enabled: liveViewEnabled,
                        available: false,
                        ready: false,
                        mode: process.platform === 'darwin'
                            ? 'mac-headful'
                            : process.platform === 'linux'
                                ? 'linux-vnc'
                                : 'disabled',
                        platform: process.platform,
                        width: options.viewport?.width ?? DEFAULT_VIEWPORT.width,
                        height: options.viewport?.height ?? DEFAULT_VIEWPORT.height,
                        reason,
                    };
                }
            }

            const hasVirtualDisplay = lastLiveViewState.ready && lastLiveViewState.display;
            const requestedHeadless = options.headless ?? process.platform !== 'darwin';
            const hasHostDisplay = Boolean(process.env.DISPLAY);
            const headless = hasVirtualDisplay
                ? false
                : requestedHeadless
                    ? true
                    : process.platform === 'linux' && !hasHostDisplay
                        ? true
                        : false;
            if (!hasVirtualDisplay && !requestedHeadless && process.platform === 'linux' && !hasHostDisplay) {
                log('⚠️ Live display unavailable on Linux; falling back to headless Patchright.');
            }
            if (hasVirtualDisplay && lastLiveViewState.display) {
                process.env.DISPLAY = lastLiveViewState.display;
                log(`🖥️ Using virtual display ${lastLiveViewState.display}`);
            }

            const displayLaunchArgs = hasVirtualDisplay
                ? [
                    `--window-size=${lastLiveViewState.width ?? DEFAULT_VIEWPORT.width},${lastLiveViewState.height ?? DEFAULT_VIEWPORT.height}`,
                    '--force-device-scale-factor=1',
                ]
                : [];

            const orphaned = killBrowserProcessesUsingPath(userDataDir);
            if (orphaned > 0) {
                log(`🧹 Closed ${orphaned} stale browser process${orphaned === 1 ? '' : 'es'} using the managed browser profile before launch.`);
                await sleep(1_000);
            }

            cleanupStaleBrowserProfileLocks(userDataDir);

            const launchPersistentContext = () => chromium.launchPersistentContext(userDataDir, {
                headless,
                viewport: headless ? (options.viewport ?? DEFAULT_VIEWPORT) : null,
                acceptDownloads: true,
                downloadsPath: downloadsDir,
                args: [...launchArgs, ...displayLaunchArgs],
            });

            log('🚀 Launching Patchright Browser...');
            log(`📂 User Data Dir: ${userDataDir}`);
            log(`📥 Downloads Dir: ${downloadsDir}`);

            try {
                context = await launchPersistentContext();
            } catch (err) {
                if (!isBrowserProfileInUseError(err)) {
                    throw err;
                }

                const killed = killBrowserProcessesUsingPath(userDataDir);
                if (killed > 0) {
                    log(`🧹 Closed ${killed} stale browser process${killed === 1 ? '' : 'es'} using the managed browser profile; retrying.`);
                    await sleep(1_000);
                }
                const removedLocks = cleanupStaleBrowserProfileLocks(userDataDir);
                if (removedLocks > 0) {
                    log(`🧹 Removed ${removedLocks} stale Chromium profile lock${removedLocks === 1 ? '' : 's'}; retrying.`);
                }

                context = await launchPersistentContext();
            }

            defaultSessionState.pages = [];
            defaultSessionState.activePage = null;
            defaultSessionState.lastMousePosition = null;

            const existingPages = context.pages();
            const initialPage = existingPages[0] ?? await context.newPage();
            const extraPages = existingPages.slice(1);
            if (extraPages.length > 0) {
                await Promise.allSettled(extraPages.map(page => page.close()));
            }
            attachPageToSession(defaultSessionState, initialPage, { origin: 'initial' });

            log('✅ Patchright Browser ready');
        },

        async close() {
            if (context) {
                await context.close();
                context = null;
            }
            await displayController?.close();

            for (const session of sessions.values()) {
                session.pages = [];
                session.activePage = null;
                session.lastMousePosition = null;
                session.latestAgentFrame = null;
                session.agentFrameHistory = [];
            }
        },

        async createSession(sessionOptions: BrowserPageSessionOptions = {}): Promise<BrowserPageSession> {
            if (!context) {
                await this.launch();
            }
            if (!context) {
                throw new Error('Browser not launched');
            }

            const session = createSessionState(sessionOptions.id);
            const newPage = takeReusableInitialBlankPage() ?? await context.newPage();
            attachPageToSession(session, newPage, { origin: 'initial' });
            if (sessionOptions.startupUrl) {
                await newPage.goto(sessionOptions.startupUrl, { waitUntil: 'domcontentloaded' });
                await grantClipboardAccess(newPage);
            }
            await newPage.bringToFront();

            return getOrCreateSessionFacade(session);
        },

        getSession(id: string): BrowserPageSession | null {
            const session = sessions.get(id);
            return session ? getOrCreateSessionFacade(session) : null;
        },

        async closeSession(id: string): Promise<boolean> {
            const session = sessions.get(id);
            if (!session || session === defaultSessionState) {
                return false;
            }

            await getOrCreateSessionFacade(session).closeOwnedPages();
            sessions.delete(id);
            sessionFacades.delete(id);
            return true;
        },

        async listAllTabs(): Promise<BrowserTabInfo[]> {
            const tabGroups = await Promise.all(
                [...sessions.values()].map((session) => describeTabs(session))
            );
            return tabGroups.flat();
        },

        getContext(): BrowserContext | null {
            return context;
        },

        getLiveViewState(): BrowserLiveViewState {
            return displayController?.getState() ?? { ...lastLiveViewState };
        },
    };

    return manager;
}
