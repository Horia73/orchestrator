import { chromium, BrowserContext, ElementHandle, Page } from 'patchright';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DEFAULT_VIEWPORT, VIEWPORT_PRESETS, type ViewportPreset } from './viewport';
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
    BrowserCurrentUrlResult,
    BrowserManager,
    BrowserManagerOptions,
    BrowserNetworkEntry,
    BrowserClickRefResult,
    BrowserPageElementRef,
    BrowserPageSettleOptions,
    BrowserPageSettleResult,
    BrowserPageSession,
    BrowserPageSessionCapabilities,
    BrowserPageErrorEntry,
    BrowserPageSessionOptions,
    BrowserReadPageResult,
    BrowserSetViewportResult,
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
    BrowserCurrentUrlResult,
    BrowserManager,
    BrowserManagerOptions,
    BrowserNetworkEntry,
    BrowserClickRefResult,
    BrowserPageElementRef,
    BrowserPageMetrics,
    BrowserPageSession,
    BrowserPageSessionCapabilities,
    BrowserPageErrorEntry,
    BrowserPageSessionOptions,
    BrowserReadPageResult,
    BrowserSetViewportResult,
    BrowserTabInfo,
    BrowserTabOrigin,
    BrowserVideoRecording,
    TracedActionResult,
} from './browser-types';

const MAX_DIAGNOSTIC_ENTRIES = 80;
const MAX_READ_PAGE_ELEMENTS = 150;
const MAX_FETCH_BODY_CHARS = 12_000;
const INTERNAL_BROWSER_URL_PREFIXES = [
    'about:',
    'chrome-error://',
    'chrome://',
    'edge://',
    'devtools://',
];

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

interface BrowserPageSettleSignature extends BrowserFrameMetrics {
    url: string;
    readyState: string;
}

const DISPLAY_AUTOMATION_COMMANDS = ['import', 'xdotool'] as const;
const DISPLAY_CLIPBOARD_COMMANDS = [
    {
        command: 'xclip',
        readArgs: ['-selection', 'clipboard', '-out'],
        writeArgs: ['-selection', 'clipboard', '-in'],
    },
    {
        command: 'xsel',
        readArgs: ['--clipboard', '--output'],
        writeArgs: ['--clipboard', '--input'],
    },
] as const;
const DISPLAY_COMMAND_DEFAULT_TIMEOUT_MS = 5_000;
const DISPLAY_COMMAND_LOOKUP_TIMEOUT_MS = 1_000;
const DISPLAY_COMMAND_KEY_TIMEOUT_MS = 1_500;
const DISPLAY_COMMAND_CLIPBOARD_TIMEOUT_MS = 1_500;
const DISPLAY_COMMAND_SCREENSHOT_TIMEOUT_MS = 10_000;
const executableCache = new Map<string, boolean>();

interface DisplayCommandOptions {
    input?: string;
    timeoutMs?: number;
}

function commandExists(command: string): boolean {
    const cached = executableCache.get(command);
    if (cached !== undefined) return cached;
    const result = spawnSync('sh', ['-lc', `command -v ${command} >/dev/null 2>&1`], {
        stdio: 'ignore',
        timeout: DISPLAY_COMMAND_LOOKUP_TIMEOUT_MS,
        killSignal: 'SIGKILL',
    });
    const exists = result.status === 0;
    executableCache.set(command, exists);
    return exists;
}

function displayEnv(display: string | undefined): NodeJS.ProcessEnv {
    return {
        ...process.env,
        DISPLAY: display || process.env.DISPLAY || ':99',
    };
}

function runDisplayCommand(
    display: string | undefined,
    command: string,
    args: string[],
    options: DisplayCommandOptions = {},
): Buffer {
    const timeoutMs = Math.max(250, Math.floor(options.timeoutMs ?? DISPLAY_COMMAND_DEFAULT_TIMEOUT_MS));
    const result = spawnSync(command, args, {
        env: displayEnv(display),
        input: options.input,
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
    });
    if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        if (code === 'ETIMEDOUT') {
            throw new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`);
        }
        throw new Error(`${command} is unavailable: ${result.error.message}`);
    }
    if (result.signal) {
        throw new Error(`${command} ${args.join(' ')} was killed by ${result.signal}`);
    }
    if (result.status !== 0) {
        const stderr = result.stderr.toString('utf8').trim();
        const stdout = result.stdout.toString('utf8').trim();
        const detail = stderr || stdout;
        throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout;
}

function readDisplayClipboard(display: string | undefined): string | null {
    for (const candidate of DISPLAY_CLIPBOARD_COMMANDS) {
        if (!commandExists(candidate.command)) continue;
        try {
            return runDisplayCommand(display, candidate.command, [...candidate.readArgs], {
                timeoutMs: DISPLAY_COMMAND_CLIPBOARD_TIMEOUT_MS,
            }).toString('utf8');
        } catch {
            // Try the next clipboard tool.
        }
    }
    return null;
}

function writeDisplayClipboard(display: string | undefined, text: string): boolean {
    for (const candidate of DISPLAY_CLIPBOARD_COMMANDS) {
        if (!commandExists(candidate.command)) continue;
        try {
            runDisplayCommand(display, candidate.command, [...candidate.writeArgs], {
                input: text,
                timeoutMs: DISPLAY_COMMAND_CLIPBOARD_TIMEOUT_MS,
            });
            return true;
        } catch {
            // Try the next clipboard tool.
        }
    }
    return false;
}

function isInternalBrowserUrl(url: string | undefined): boolean {
    const normalized = String(url || '').trim().toLowerCase();
    if (!normalized) return true;
    return INTERNAL_BROWSER_URL_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function normalizeAddressBarText(value: string | null | undefined): string | null {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.includes('\n') || normalized.includes('\r')) return null;
    if (normalized.length > 8192) return null;

    // Full URLs and browser-internal URLs are copied exactly by Chromium.
    if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return normalized;

    // Chrome can also copy a bare host/path for some omnibox states.
    if (/^[^\s/]+\.[^\s/]+(?:[/?#:]|$)/.test(normalized) || /^localhost(?::\d+)?(?:[/?#]|$)/i.test(normalized)) {
        return normalized;
    }

    return null;
}

type CdpSessionLike = {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    detach?: () => Promise<void>;
};

type NavigationHistoryEntry = {
    url?: string;
    userTypedURL?: string;
};

function navigationHistoryCandidate(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null;
    const record = result as { currentIndex?: unknown; entries?: unknown };
    if (!Array.isArray(record.entries) || record.entries.length === 0) return null;
    const rawIndex = Number(record.currentIndex);
    const currentIndex = Number.isInteger(rawIndex)
        ? Math.max(0, Math.min(rawIndex, record.entries.length - 1))
        : record.entries.length - 1;
    const entries = record.entries as NavigationHistoryEntry[];
    const orderedCandidates = [
        entries[currentIndex]?.userTypedURL,
        entries[currentIndex]?.url,
        ...entries.slice(0, currentIndex).reverse().flatMap(entry => [entry.userTypedURL, entry.url]),
    ];

    for (const candidate of orderedCandidates) {
        const normalized = normalizeAddressBarText(candidate);
        if (normalized && !isInternalBrowserUrl(normalized)) return normalized;
    }

    return null;
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
    const fallbackWidth = viewport?.width || 1920;
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
    let displayAutomationWarningLogged = false;

    const getDisplayDimensions = (): { width: number; height: number } => ({
        width: lastLiveViewState.width ?? DEFAULT_VIEWPORT.width,
        height: lastLiveViewState.height ?? DEFAULT_VIEWPORT.height,
    });

    const getDisplayAutomationMissingCommands = (): string[] => (
        DISPLAY_AUTOMATION_COMMANDS.filter(command => !commandExists(command))
    );

    const shouldUseDisplayAutomation = (): boolean => {
        if (process.platform !== 'linux' || !lastLiveViewState.ready || !lastLiveViewState.display) {
            return false;
        }

        const missing = getDisplayAutomationMissingCommands();
        if (missing.length > 0) {
            if (!displayAutomationWarningLogged) {
                log(`⚠️ Patchright live display is available but display automation is disabled because these commands are missing: ${missing.join(', ')}`);
                displayAutomationWarningLogged = true;
            }
            return false;
        }

        return true;
    };

    const xdotool = async (args: string[]) => {
        runDisplayCommand(lastLiveViewState.display, 'xdotool', args, {
            timeoutMs: DISPLAY_COMMAND_KEY_TIMEOUT_MS,
        });
        await sleep(20);
    };

    const getNavigationHistoryUrl = async (page: Page): Promise<string | null> => {
        if (!context) return null;
        const newSession = (context as unknown as {
            newCDPSession?: (target: Page) => Promise<CdpSessionLike>;
        }).newCDPSession;
        if (typeof newSession !== 'function') return null;

        let cdpSession: CdpSessionLike | null = null;
        try {
            cdpSession = await newSession.call(context, page);
            const history = await cdpSession.send('Page.getNavigationHistory');
            return navigationHistoryCandidate(history);
        } catch (error) {
            log(`⚠️ Could not read browser navigation history: ${formatBrowserError(error)}`);
            return null;
        } finally {
            if (cdpSession?.detach) {
                await cdpSession.detach().catch(() => {});
            }
        }
    };

    const copyAddressBarUrl = async (page: Page): Promise<string | null> => {
        if (!shouldUseDisplayAutomation()) return null;

        try {
            await page.bringToFront();
        } catch {
            // xdotool operates on the visible browser window; continue best-effort.
        }

        const marker = `orchestrator-address-bar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const canWriteClipboard = writeDisplayClipboard(lastLiveViewState.display, marker);

        try {
            await xdotool(['key', '--clearmodifiers', normalizeXdotoolKey('Control+L')]);
            await sleep(60);
            await xdotool(['key', '--clearmodifiers', normalizeXdotoolKey('Control+C')]);
            await sleep(120);

            const copied = readDisplayClipboard(lastLiveViewState.display);
            if (canWriteClipboard && copied === marker) {
                return null;
            }
            return normalizeAddressBarText(copied);
        } catch (error) {
            log(`⚠️ Could not copy browser address bar URL: ${formatBrowserError(error)}`);
            return null;
        } finally {
            try {
                await xdotool(['key', '--clearmodifiers', normalizeXdotoolKey('Escape')]);
            } catch {
                // Ignore focus restoration failures.
            }
        }
    };

    const clampDisplayCoordinate = (x: number, y: number): [number, number] => {
        const display = getDisplayDimensions();
        const roundedX = Number.isFinite(x) ? Math.round(x) : 0;
        const roundedY = Number.isFinite(y) ? Math.round(y) : 0;
        const safeX = Math.max(0, Math.min(roundedX, display.width - 1));
        const safeY = Math.max(0, Math.min(roundedY, display.height - 1));
        if (safeX !== roundedX || safeY !== roundedY) {
            log(`⚠️ Clamping display coordinates from [${x}, ${y}] to [${safeX}, ${safeY}] (${display.width}x${display.height})`);
        }
        return [safeX, safeY];
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
        elementRefs: {
            page: Page;
            url: string;
            byRef: Map<string, { handle: ElementHandle; label: string }>;
        } | null;
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

    const isPageVisible = async (page: Page): Promise<boolean> => {
        try {
            return await page.evaluate(() => document.visibilityState === 'visible');
        } catch {
            return false;
        }
    };

    const pasteTextIntoPage = async (page: Page, text: string) => {
        if (!await isPageVisible(page)) {
            await page.bringToFront();
        }

        try {
            await page.keyboard.insertText(text);
            return;
        } catch (error) {
            log(`⚠️ Direct text insert failed; falling back to clipboard paste: ${formatBrowserError(error)}`);
        }

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
            elementRefs: null,
        };
        sessions.set(id, state);
        return state;
    };

    const disposeElementRefs = (session: BrowserSessionState) => {
        const store = session.elementRefs;
        session.elementRefs = null;
        if (!store) return;
        for (const entry of store.byRef.values()) {
            void entry.handle.dispose().catch(() => {});
        }
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

    const syncActivePageWithVisibleTab = async (
        session: BrowserSessionState,
        pages: Page[] = getOpenOwnedPages(session),
    ): Promise<Page | null> => {
        if (pages.length === 0) return null;

        if (pages.length === 1) {
            if (session.activePage !== pages[0]) {
                session.activePage = pages[0];
                session.lastMousePosition = null;
            }
            return pages[0];
        }

        if (session.activePage && pages.includes(session.activePage) && await isPageVisible(session.activePage)) {
            return session.activePage;
        }

        const visibility = await Promise.all(
            pages.map(async page => ({
                page,
                visible: await isPageVisible(page),
            })),
        );
        const visiblePage = visibility.find(result => result.visible)?.page ?? null;
        if (!visiblePage) return null;

        if (session.activePage !== visiblePage) {
            session.activePage = visiblePage;
            session.lastMousePosition = null;
            log(`🔀 Synced session "${session.id}" to visible tab ${pages.indexOf(visiblePage)}: ${pageUrl(visiblePage)}`);
        }

        return visiblePage;
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
        const visiblePage = await syncActivePageWithVisibleTab(session, pages);
        if (visiblePage) {
            return visiblePage;
        }

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

    const getPageSettleSignature = async (activePage: Page): Promise<BrowserPageSettleSignature> => {
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
                url: window.location.href,
                readyState: document.readyState,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                pageWidth,
                pageHeight,
                scrollX: window.scrollX,
                scrollY: window.scrollY,
            };
        });
    };

    const pageSettleKey = (signature: BrowserPageSettleSignature): string => [
        signature.url,
        signature.readyState,
        signature.viewportWidth,
        signature.viewportHeight,
        signature.pageWidth,
        signature.pageHeight,
        signature.scrollX,
        signature.scrollY,
    ].join('|');

    const waitForPageSettled = async (
        session: BrowserSessionState,
        options: BrowserPageSettleOptions = {},
    ): Promise<BrowserPageSettleResult> => {
        const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 1500));
        const stableMs = Math.max(0, Math.floor(options.stableMs ?? 350));
        const pollMs = Math.max(50, Math.floor(options.pollMs ?? 100));
        const startedAt = Date.now();

        let activePage: Page;
        try {
            activePage = await ensureActivePage(session);
        } catch {
            return { settled: false, elapsedMs: Date.now() - startedAt, reason: 'error' };
        }

        let lastKey = '';
        let stableSince = 0;

        while (Date.now() - startedAt <= timeoutMs) {
            let signature: BrowserPageSettleSignature;
            try {
                signature = await getPageSettleSignature(activePage);
            } catch {
                return { settled: false, elapsedMs: Date.now() - startedAt, reason: 'error' };
            }

            const ready = signature.readyState !== 'loading';
            const key = pageSettleKey(signature);
            const now = Date.now();

            if (ready && key === lastKey) {
                stableSince = stableSince || now;
                if (now - stableSince >= stableMs) {
                    return { settled: true, elapsedMs: now - startedAt, reason: 'stable' };
                }
            } else {
                lastKey = key;
                stableSince = ready ? now : 0;
            }

            const remainingMs = timeoutMs - (Date.now() - startedAt);
            if (remainingMs <= 0) break;
            await sleep(Math.min(pollMs, remainingMs));
        }

        return { settled: false, elapsedMs: Date.now() - startedAt, reason: 'timeout' };
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
        const useDisplayAutomation = shouldUseDisplayAutomation();

        if (useDisplayAutomation) {
            const display = getDisplayDimensions();
            if (source === 'agent') {
                log(`📸 Display screenshot ${display.width}x${display.height} (${source})`);
            }

            const buffer = runDisplayCommand(lastLiveViewState.display, 'import', [
                '-window', 'root',
                '-quality', String(Math.max(1, Math.min(100, Math.round(quality)))),
                'jpg:-',
            ], { timeoutMs: DISPLAY_COMMAND_SCREENSHOT_TIMEOUT_MS });
            const frame: BrowserFrameSnapshot = {
                id: toFrameId(++session.frameSequence),
                source,
                timestamp: new Date().toISOString(),
                imageBase64: buffer.toString('base64'),
                url: activePage.url(),
                captureMode: 'viewport',
                coordinateSpace: 'normalized-display',
                viewport: { ...display },
                page: {
                    width: display.width,
                    height: display.height,
                    scrollX: 0,
                    scrollY: 0,
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
        }

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
        await syncActivePageWithVisibleTab(session, pages);
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

    const drawPageClickMarker = async (
        page: Page,
        point: { x: number; y: number },
    ): Promise<boolean> => {
        try {
            return await page.evaluate(({ x, y }) => {
                try {
                    const markerSize = 24;
                    const div = document.createElement('div');
                    div.style.position = 'fixed';
                    div.style.left = `${x - markerSize / 2}px`;
                    div.style.top = `${y - markerSize / 2}px`;
                    div.style.width = `${markerSize}px`;
                    div.style.height = `${markerSize}px`;
                    div.style.borderRadius = '50%';
                    div.style.backgroundColor = 'rgba(255, 0, 0, 0.72)';
                    div.style.border = '3px solid white';
                    div.style.boxShadow = '0 0 12px rgba(0,0,0,0.55)';
                    div.style.zIndex = '2147483647';
                    div.style.pointerEvents = 'none';
                    div.id = `ai-click-${Date.now()}`;

                    const parent = document.fullscreenElement || document.documentElement || document.body;
                    if (!parent) return false;
                    parent.appendChild(div);

                    setTimeout(() => div.remove(), 2000);
                    return true;
                } catch {
                    return false;
                }
            }, point);
        } catch {
            return false;
        }
    };

    const drawDisplayClickMarker = async (
        session: BrowserSessionState,
        x: number,
        y: number,
    ): Promise<boolean> => {
        try {
            const activePage = await ensureActivePage(session);
            const pagePoint = await activePage.evaluate(({ displayX, displayY }) => {
                const sideChrome = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
                const topChrome = Math.max(0, Math.round(window.outerHeight - window.innerHeight - sideChrome));
                const pageX = Math.round(displayX - window.screenX - sideChrome);
                const pageY = Math.round(displayY - window.screenY - topChrome);
                return {
                    x: pageX,
                    y: pageY,
                    visible: pageX >= 0 && pageY >= 0 && pageX < window.innerWidth && pageY < window.innerHeight,
                };
            }, { displayX: x, displayY: y });

            if (!pagePoint.visible) return false;
            return await drawPageClickMarker(activePage, pagePoint);
        } catch {
            return false;
        }
    };

    const clickDisplayCoordinate = async (
        session: BrowserSessionState,
        x: number,
        y: number,
        count: number = 1,
    ): Promise<boolean> => {
        const [safeX, safeY] = clampDisplayCoordinate(x, y);
        const repeat = Number.isFinite(count) ? Math.max(1, Math.round(count)) : 1;

        try {
            log(`🖱️ Display click at ${safeX}, ${safeY} (Count: ${repeat})`);
            await xdotool(['mousemove', String(safeX), String(safeY)]);
            session.lastMousePosition = { x: safeX, y: safeY };
            if (await drawDisplayClickMarker(session, safeX, safeY)) {
                await sleep(120);
            }
            for (let i = 0; i < repeat; i++) {
                await xdotool(['mousedown', '1']);
                await sleep(45);
                await xdotool(['mouseup', '1']);
                if (i < repeat - 1) {
                    await sleep(80);
                }
            }
            return true;
        } catch (error) {
            logError('Display click failed:', error);
            return false;
        }
    };

    const hoverDisplayCoordinate = async (
        session: BrowserSessionState,
        x: number,
        y: number,
    ): Promise<void> => {
        const [safeX, safeY] = clampDisplayCoordinate(x, y);
        log(`🖱️ Display hover at ${safeX}, ${safeY}`);
        await xdotool(['mousemove', String(safeX), String(safeY)]);
        session.lastMousePosition = { x: safeX, y: safeY };
    };

    const dragDisplayCoordinate = async (
        session: BrowserSessionState,
        startX: number,
        startY: number,
        endX: number,
        endY: number,
        durationMs: number = DEFAULT_DRAG_DURATION_MS,
    ): Promise<TracedActionResult> => {
        const [safeStartX, safeStartY] = clampDisplayCoordinate(startX, startY);
        const [safeEndX, safeEndY] = clampDisplayCoordinate(endX, endY);
        const steps = Math.max(8, Math.min(40, Math.round(durationMs / 35)));

        try {
            log(`🖱️ Display drag from [${safeStartX}, ${safeStartY}] to [${safeEndX}, ${safeEndY}] (${durationMs}ms)`);
            await xdotool(['mousemove', String(safeStartX), String(safeStartY)]);
            await xdotool(['mousedown', '1']);
            session.lastMousePosition = { x: safeStartX, y: safeStartY };
            for (let step = 1; step <= steps; step++) {
                const ratio = step / steps;
                const x = Math.round(safeStartX + (safeEndX - safeStartX) * ratio);
                const y = Math.round(safeStartY + (safeEndY - safeStartY) * ratio);
                await xdotool(['mousemove', String(x), String(y)]);
                await sleep(Math.max(5, durationMs / steps));
            }
            session.lastMousePosition = { x: safeEndX, y: safeEndY };
            await xdotool(['mouseup', '1']);
            return { success: true, trace: emptyTrace('drag') };
        } catch (error) {
            logError('Display drag failed:', error);
            try {
                await xdotool(['mouseup', '1']);
            } catch {}
            return { success: false, trace: emptyTrace('drag') };
        }
    };

    const holdDisplayCoordinate = async (
        session: BrowserSessionState,
        x: number,
        y: number,
        durationMs: number = 10000,
    ): Promise<TracedActionResult> => {
        const [safeX, safeY] = clampDisplayCoordinate(x, y);

        try {
            log(`🖱️ Display hold at ${safeX}, ${safeY} (${durationMs}ms)`);
            await xdotool(['mousemove', String(safeX), String(safeY)]);
            await xdotool(['mousedown', '1']);
            session.lastMousePosition = { x: safeX, y: safeY };
            await sleep(Math.max(200, durationMs));
            await xdotool(['mouseup', '1']);
            return { success: true, trace: emptyTrace('hold') };
        } catch (error) {
            logError('Display hold failed:', error);
            try {
                await xdotool(['mouseup', '1']);
            } catch {}
            return { success: false, trace: emptyTrace('hold') };
        }
    };

    const scrollDisplay = async (
        session: BrowserSessionState,
        direction: 'up' | 'down' | 'left' | 'right',
        amount: number = 500,
    ): Promise<void> => {
        const display = getDisplayDimensions();
        const target = session.lastMousePosition ?? { x: display.width / 2, y: display.height / 2 };
        const [targetX, targetY] = clampDisplayCoordinate(target.x, target.y);
        await xdotool(['mousemove', String(targetX), String(targetY)]);
        session.lastMousePosition = { x: targetX, y: targetY };

        const button = direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
        const repeats = Math.max(1, Math.min(20, Math.ceil(amount / 120)));
        for (let i = 0; i < repeats; i++) {
            await xdotool(['click', button]);
        }
    };

    const pressDisplayKey = async (key: string): Promise<void> => {
        await xdotool(['key', '--clearmodifiers', normalizeXdotoolKey(key)]);
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
        const getCapabilities = (): BrowserPageSessionCapabilities => {
            const displayAutomation = shouldUseDisplayAutomation();
            return {
                backend,
                coordinateSpace: displayAutomation ? 'normalized-display' : 'normalized-viewport',
                domInspection: true,
                overviewCapture: !displayAutomation,
                tabEnumeration: true,
                downloadEvents: true,
                displayCapture: displayAutomation,
                osClipboard: false,
                diagnostics: true,
                browserFetch: true,
            };
        };
        const facade: BrowserPageSession = {
            id: session.id,
            createdAt: session.createdAt,
            get capabilities() {
                return getCapabilities();
            },

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
                if (shouldUseDisplayAutomation()) {
                    if (!commandExists('ffmpeg')) {
                        throw new Error('ffmpeg is required for Patchright display video recording.');
                    }
                    const recordingDurationMs = clampDurationMs(
                        durationMs,
                        DEFAULT_VIDEO_DURATION_MS,
                        MIN_VIDEO_DURATION_MS,
                        MAX_VIDEO_DURATION_MS,
                    );
                    const fps = DEFAULT_VIDEO_FPS;
                    const display = getDisplayDimensions();
                    const outputPath = path.join(downloadsDir, `browser-recording-${Date.now()}.webm`);
                    const seconds = Math.max(1, Math.min(60, recordingDurationMs / 1000));

                    log(`🎥 Recording full display for ${Math.round(recordingDurationMs / 1000)}s...`);
                    runDisplayCommand(lastLiveViewState.display, 'ffmpeg', [
                        '-y',
                        '-video_size', `${display.width}x${display.height}`,
                        '-f', 'x11grab',
                        '-i', `${lastLiveViewState.display}.0`,
                        '-t', String(seconds),
                        '-r', String(fps),
                        outputPath,
                    ], { timeoutMs: Math.ceil(seconds * 1000) + DISPLAY_COMMAND_DEFAULT_TIMEOUT_MS });
                    const bytes = fs.readFileSync(outputPath);
                    return {
                        id: `video_${Date.now().toString(36)}`,
                        timestamp: new Date().toISOString(),
                        mimeType: 'video/webm',
                        videoBase64: bytes.toString('base64'),
                        url: activePage.url(),
                        durationMs: recordingDurationMs,
                        fps,
                        frameCount: Math.max(1, Math.round((recordingDurationMs / 1000) * fps)),
                        viewport: { ...display },
                        page: { width: display.width, height: display.height, scrollX: 0, scrollY: 0 },
                    };
                }

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
                if (shouldUseDisplayAutomation()) {
                    return clickDisplayCoordinate(session, x, y, count);
                }

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

                    // Draw the marker before the click and leave a short beat so
                    // it is visible in the live view before the page reacts.
                    if (await drawPageClickMarker(activePage, { x: safeX, y: safeY })) {
                        await sleep(120);
                    }

                    if (count === 2) {
                        await activePage.mouse.click(safeX, safeY, { clickCount: 2, delay: 70 });
                    } else {
                        await activePage.mouse.click(safeX, safeY, { delay: 24 });
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
                if (shouldUseDisplayAutomation()) {
                    return dragDisplayCoordinate(session, startX, startY, endX, endY, durationMs);
                }

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
                if (shouldUseDisplayAutomation()) {
                    return holdDisplayCoordinate(session, x, y, durationMs);
                }

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
                if (shouldUseDisplayAutomation()) {
                    return hoverDisplayCoordinate(session, x, y);
                }

                const activePage = await ensureActivePage(session);
                const { width, height } = await activePage.evaluate(() => ({
                    width: window.innerWidth,
                    height: window.innerHeight,
                }));
                const safeX = Math.max(0, Math.min(x, width - 1));
                const safeY = Math.max(0, Math.min(y, height - 1));

                log(`🖱️ Hovering at ${safeX}, ${safeY}`);
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
                if (shouldUseDisplayAutomation()) {
                    await pressDisplayKey(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
                    await pressDisplayKey('Backspace');
                    return;
                }

                const activePage = await ensureActivePage(session);
                await selectAllAndClear(activePage);
            },

            async pressKey(key: string) {
                if (shouldUseDisplayAutomation()) {
                    await pressDisplayKey(key);
                    return;
                }

                const activePage = await ensureActivePage(session);
                await activePage.keyboard.press(key);
            },

            async findInPage(query: string, next: boolean = false) {
                const activePage = await ensureActivePage(session);
                // The native Ctrl+F find bar is browser chrome, not page content, so
                // CDP key events (page.keyboard) never open it — the old approach just
                // sent Ctrl+A to the page (selecting everything) and typed into the void.
                // Run the search in the page context instead so it works in every mode.
                const result = await activePage.evaluate(({ q, goNext }) => {
                    const empty = { found: false, count: 0 };
                    if (!q) return empty;
                    const selection = window.getSelection();
                    // Starting a fresh search: drop any stray selection (e.g. a leftover
                    // select-all) so window.find scans from the top of the document.
                    if (!goNext && selection) {
                        selection.removeAllRanges();
                    }

                    // Count occurrences in visible text for a useful observation.
                    let count = 0;
                    try {
                        const haystack = ((document.body && document.body.innerText) || '').toLowerCase();
                        const needle = q.toLowerCase();
                        if (needle) {
                            let idx = haystack.indexOf(needle);
                            while (idx !== -1) {
                                count++;
                                idx = haystack.indexOf(needle, idx + needle.length);
                            }
                        }
                    } catch {
                        // innerText can throw on detached/odd documents; ignore.
                    }

                    // window.find(string, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames, showDialog)
                    // window.find is non-standard (no DOM lib type) but supported in Chromium.
                    const finder = (window as unknown as {
                        find?: (
                            text: string,
                            caseSensitive?: boolean,
                            backwards?: boolean,
                            wrapAround?: boolean,
                            wholeWord?: boolean,
                            searchInFrames?: boolean,
                            showDialog?: boolean,
                        ) => boolean;
                    }).find;
                    let found = false;
                    try {
                        found = typeof finder === 'function'
                            ? finder.call(window, q, false, false, true, false, true, false)
                            : false;
                    } catch {
                        found = false;
                    }

                    // Center the active match in the viewport for the next screenshot.
                    if (found && selection && selection.rangeCount > 0) {
                        const node = selection.getRangeAt(0).startContainer;
                        const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
                        if (el && typeof el.scrollIntoView === 'function') {
                            el.scrollIntoView({ block: 'center', inline: 'center' });
                        }
                    }

                    return { found, count };
                }, { q: query, goNext: next });
                return result;
            },

            async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number = 500) {
                if (shouldUseDisplayAutomation()) {
                    await scrollDisplay(session, direction, amount);
                    return;
                }

                const activePage = await ensureActivePage(session);
                const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
                const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
                await activePage.mouse.wheel(deltaX, deltaY);
            },

            async scrollToBottom() {
                if (shouldUseDisplayAutomation()) {
                    await pressDisplayKey('End');
                    return;
                }

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
                if (shouldUseDisplayAutomation()) {
                    await pressDisplayKey(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
                    return;
                }

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
                if (shouldUseDisplayAutomation()) {
                    return null;
                }

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

            async getCurrentUrl(): Promise<BrowserCurrentUrlResult> {
                const activePage = await ensureActivePage(session);
                const pageUrl = activePage.url();

                const addressBarUrl = await copyAddressBarUrl(activePage);
                if (addressBarUrl) {
                    return { url: addressBarUrl, source: 'address-bar' };
                }

                if (isInternalBrowserUrl(pageUrl)) {
                    const historyUrl = await getNavigationHistoryUrl(activePage);
                    if (historyUrl) {
                        return { url: historyUrl, source: 'navigation-history' };
                    }
                }

                return { url: pageUrl, source: 'page-url' };
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
                if (shouldUseDisplayAutomation()) {
                    return getDisplayDimensions();
                }

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

            waitForPageSettled(options?: BrowserPageSettleOptions): Promise<BrowserPageSettleResult> {
                return waitForPageSettled(session, options);
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

            async readPage(): Promise<BrowserReadPageResult> {
                const capturedAt = new Date().toISOString();
                try {
                    const activePage = await ensureActivePage(session);
                    disposeElementRefs(session);

                    // Collect the live elements once, then derive metadata and
                    // handles from the SAME in-page array so refs cannot skew.
                    const collectionHandle = await activePage.evaluateHandle(({ maxElements }) => {
                        const selector = [
                            'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
                            '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
                            '[role="option"]', '[role="checkbox"]', '[role="radio"]',
                            '[role="combobox"]', '[role="switch"]', '[role="textbox"]',
                            '[contenteditable="true"]', '[onclick]',
                        ].join(', ');
                        const out: Element[] = [];
                        let total = 0;
                        for (const el of Array.from(document.querySelectorAll(selector))) {
                            const rect = el.getBoundingClientRect();
                            if (rect.width < 1 || rect.height < 1) continue;
                            const style = window.getComputedStyle(el);
                            if (style.visibility === 'hidden' || style.display === 'none') continue;
                            total += 1;
                            if (out.length < maxElements) out.push(el);
                        }
                        return { elements: out, total };
                    }, { maxElements: MAX_READ_PAGE_ELEMENTS });

                    const metadata = await activePage.evaluate((collected) => {
                        const textOf = (el: Element): string => {
                            const aria = el.getAttribute('aria-label')?.trim();
                            if (aria) return aria;
                            const labelledBy = el.getAttribute('aria-labelledby')?.trim();
                            if (labelledBy) {
                                const parts = labelledBy.split(/\s+/)
                                    .map((id) => document.getElementById(id)?.textContent?.trim() || '')
                                    .filter(Boolean);
                                if (parts.length) return parts.join(' ');
                            }
                            if (el instanceof HTMLInputElement) {
                                if (el.labels && el.labels.length > 0) {
                                    const label = Array.from(el.labels).map((l) => l.textContent?.trim() || '').filter(Boolean).join(' ');
                                    if (label) return label;
                                }
                                return el.placeholder || el.name || (el.type === 'submit' || el.type === 'button' ? el.value : '') || '';
                            }
                            if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
                                if (el.labels && el.labels.length > 0) {
                                    const label = Array.from(el.labels).map((l) => l.textContent?.trim() || '').filter(Boolean).join(' ');
                                    if (label) return label;
                                }
                                return (el as HTMLTextAreaElement).placeholder ?? el.name ?? '';
                            }
                            const text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim() || '';
                            if (text) return text;
                            const img = el.querySelector('img[alt]');
                            if (img) return img.getAttribute('alt') || '';
                            return el.getAttribute('title') || '';
                        };
                        const roleOf = (el: Element): string => {
                            const explicit = el.getAttribute('role');
                            if (explicit) return explicit;
                            const tag = el.tagName.toLowerCase();
                            if (tag === 'a') return 'link';
                            if (tag === 'input') {
                                const type = (el as HTMLInputElement).type || 'text';
                                if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
                                if (type === 'checkbox' || type === 'radio') return type;
                                return `input:${type}`;
                            }
                            if (tag === 'textarea') return 'input:multiline';
                            if (tag === 'select') return 'select';
                            if (tag === 'summary') return 'expander';
                            if (el.getAttribute('contenteditable') === 'true') return 'input:richtext';
                            return tag === 'button' ? 'button' : `clickable:${tag}`;
                        };
                        return collected.elements.map((el) => {
                            const rect = el.getBoundingClientRect();
                            const inViewport = rect.bottom > 0 && rect.right > 0
                                && rect.top < window.innerHeight && rect.left < window.innerWidth;
                            const entry: {
                                role: string; name: string; href?: string; value?: string;
                                checked?: boolean; disabled?: boolean; inViewport: boolean;
                            } = {
                                role: roleOf(el),
                                name: textOf(el).replace(/\s+/g, ' ').slice(0, 80),
                                inViewport,
                            };
                            if (el instanceof HTMLAnchorElement && el.href) entry.href = el.href.slice(0, 200);
                            if (el instanceof HTMLInputElement) {
                                if (el.type !== 'password' && el.value && el.type !== 'submit' && el.type !== 'button') {
                                    entry.value = el.value.slice(0, 60);
                                }
                                if (el.type === 'checkbox' || el.type === 'radio') entry.checked = el.checked;
                                if (el.disabled) entry.disabled = true;
                            } else if (el instanceof HTMLSelectElement) {
                                entry.value = (el.selectedOptions[0]?.textContent || '').trim().slice(0, 60);
                                if (el.disabled) entry.disabled = true;
                            } else if (el instanceof HTMLTextAreaElement) {
                                if (el.value) entry.value = el.value.slice(0, 60);
                                if (el.disabled) entry.disabled = true;
                            } else if (el instanceof HTMLButtonElement && el.disabled) {
                                entry.disabled = true;
                            }
                            return entry;
                        });
                    }, collectionHandle);

                    const collectedTotal = await activePage.evaluate((collected) => collected.total, collectionHandle);
                    const elementsHandle = await collectionHandle.getProperty('elements');
                    const properties = await elementsHandle.getProperties();
                    const byRef = new Map<string, { handle: ElementHandle; label: string }>();
                    const elements: BrowserPageElementRef[] = [];
                    for (let index = 0; index < metadata.length; index++) {
                        const handle = properties.get(String(index))?.asElement();
                        if (!handle) continue;
                        const ref = `e${index + 1}`;
                        const meta = metadata[index];
                        byRef.set(ref, { handle, label: meta.name || meta.role });
                        elements.push({ ref, ...meta });
                    }
                    void elementsHandle.dispose().catch(() => {});
                    void collectionHandle.dispose().catch(() => {});

                    session.elementRefs = {
                        page: activePage,
                        url: activePage.url(),
                        byRef,
                    };

                    return {
                        supported: true,
                        url: activePage.url(),
                        capturedAt,
                        total: collectedTotal,
                        truncated: collectedTotal > elements.length,
                        elements,
                    };
                } catch (error) {
                    return {
                        supported: false,
                        url: session.activePage ? pageUrl(session.activePage) : '',
                        capturedAt,
                        total: 0,
                        truncated: false,
                        elements: [],
                        error: formatBrowserError(error),
                    };
                }
            },

            async clickRef(ref: string, count: number = 1): Promise<BrowserClickRefResult> {
                const activePage = await ensureActivePage(session);
                const store = session.elementRefs;
                if (!store || store.page !== activePage) {
                    return {
                        success: false,
                        stale: true,
                        error: 'No element refs captured for the current tab. Run readPage first.',
                    };
                }
                const entry = store.byRef.get(ref);
                if (!entry) {
                    return {
                        success: false,
                        stale: true,
                        error: `Unknown element ref "${ref}". Run readPage again to refresh the element list.`,
                    };
                }

                try {
                    await entry.handle.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
                    const box = await entry.handle.boundingBox();
                    if (!box) {
                        return {
                            success: false,
                            stale: true,
                            label: entry.label,
                            error: `Element ${ref} ("${entry.label}") is detached or hidden now. Run readPage again.`,
                        };
                    }
                    const centerX = Math.round(box.x + box.width / 2);
                    const centerY = Math.round(box.y + box.height / 2);

                    if (shouldUseDisplayAutomation()) {
                        // Translate the viewport-relative center to display coordinates
                        // (inverse of drawDisplayClickMarker) so the click goes through
                        // the same xdotool input path as coordinate clicks.
                        const displayPoint = await activePage.evaluate(({ x, y }) => {
                            const sideChrome = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
                            const topChrome = Math.max(0, Math.round(window.outerHeight - window.innerHeight - sideChrome));
                            return {
                                x: Math.round(x + window.screenX + sideChrome),
                                y: Math.round(y + window.screenY + topChrome),
                            };
                        }, { x: centerX, y: centerY });
                        const clicked = await clickDisplayCoordinate(session, displayPoint.x, displayPoint.y, count);
                        return clicked
                            ? { success: true, label: entry.label }
                            : { success: false, label: entry.label, error: 'Display click failed.' };
                    }

                    const clicked = await facade.clickCoordinate(centerX, centerY, count);
                    return clicked
                        ? { success: true, label: entry.label }
                        : { success: false, label: entry.label, error: 'Click failed.' };
                } catch (error) {
                    return { success: false, label: entry.label, error: formatBrowserError(error) };
                }
            },

            async setViewport(preset: ViewportPreset, colorScheme: 'dark' | 'light' | 'auto' = 'auto'): Promise<BrowserSetViewportResult> {
                if (shouldUseDisplayAutomation()) {
                    return {
                        supported: false,
                        preset,
                        error: 'Viewport presets are unavailable on the full-display backend; the page always renders in the real browser window.',
                    };
                }
                try {
                    const activePage = await ensureActivePage(session);
                    const size = VIEWPORT_PRESETS[preset] ?? DEFAULT_VIEWPORT;
                    await activePage.setViewportSize({ width: size.width, height: size.height });
                    if (colorScheme === 'dark' || colorScheme === 'light') {
                        await activePage.emulateMedia({ colorScheme });
                    } else {
                        await activePage.emulateMedia({ colorScheme: null });
                    }
                    return {
                        supported: true,
                        preset,
                        width: size.width,
                        height: size.height,
                        colorScheme,
                    };
                } catch (error) {
                    return { supported: false, preset, error: formatBrowserError(error) };
                }
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
                disposeElementRefs(session);
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
        get capabilities() {
            return defaultSession.capabilities;
        },

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

            if (shouldUseDisplayAutomation()) {
                const display = getDisplayDimensions();
                log(`🖥️ Patchright display automation enabled (${display.width}x${display.height}); agent frames use normalized coordinates mapped to display pixels.`);
            }
            log('✅ Patchright Browser ready');
        },

        async close() {
            const closingContext = context;
            context = null;
            if (closingContext) {
                try {
                    await closingContext.close();
                } catch (err) {
                    logError('⚠️ Patchright browser context close failed', err);
                }
            }
            if (displayController) {
                try {
                    await displayController.close();
                } catch (err) {
                    logError('⚠️ Browser live display close failed', err);
                }
            }

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
