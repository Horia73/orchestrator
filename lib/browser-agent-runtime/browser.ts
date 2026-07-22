import { chromium, BrowserContext, ElementHandle, Frame, Page } from 'patchright';
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
    BrowserDownloadMediaResult,
    BrowserDownloadMediaTarget,
    BrowserFetchResult,
    BrowserFrameSnapshot,
    BrowserFrameSource,
    BrowserCurrentUrlResult,
    BrowserManager,
    BrowserManagerOptions,
    BrowserNetworkEntry,
    BrowserChooseFileTarget,
    BrowserClickRefResult,
    BrowserClickOptions,
    BrowserInspectAtResult,
    BrowserKeyModifier,
    BrowserMouseButton,
    BrowserPageAsset,
    BrowserPageAssetsResult,
    BrowserUploadFileResult,
    BrowserPageElementRef,
    BrowserPageMetrics,
    BrowserPageSettleOptions,
    BrowserPageSettleResult,
    BrowserPageSession,
    BrowserPageSessionCapabilities,
    BrowserPageErrorEntry,
    BrowserPageSessionOptions,
    BrowserPointerActionKind,
    BrowserPointerState,
    BrowserReadPageResult,
    BrowserScrollResult,
    BrowserScrollSnapshot,
    BrowserSetViewportResult,
    BrowserTabInfo,
    BrowserTabOrigin,
    BrowserVideoRecording,
    BrowserWaitForOptions,
    BrowserWaitForResult,
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
    BrowserDownloadMediaResult,
    BrowserDownloadMediaTarget,
    BrowserFetchResult,
    BrowserFrameSnapshot,
    BrowserFrameSource,
    BrowserCurrentUrlResult,
    BrowserManager,
    BrowserManagerOptions,
    BrowserNetworkEntry,
    BrowserChooseFileTarget,
    BrowserClickRefResult,
    BrowserClickOptions,
    BrowserInspectAtResult,
    BrowserKeyModifier,
    BrowserMouseButton,
    BrowserPageAsset,
    BrowserPageAssetsResult,
    BrowserUploadFileResult,
    BrowserPageElementRef,
    BrowserPageMetrics,
    BrowserPageSession,
    BrowserPageSessionCapabilities,
    BrowserPageErrorEntry,
    BrowserPageSessionOptions,
    BrowserPointerActionKind,
    BrowserPointerState,
    BrowserReadPageResult,
    BrowserScrollResult,
    BrowserScrollSnapshot,
    BrowserSetViewportResult,
    BrowserTabInfo,
    BrowserTabOrigin,
    BrowserVideoRecording,
    BrowserWaitForOptions,
    BrowserWaitForResult,
    TracedActionResult,
} from './browser-types';

const MAX_DIAGNOSTIC_ENTRIES = 80;
const MAX_READ_PAGE_ELEMENTS = 150;
const MAX_PAGE_ASSETS = 160;
const MAX_MEDIA_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_FILES = 20;
const MAX_TARGETED_WAIT_MS = 30_000;
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

function toBrowserPageMetrics(metrics: BrowserFrameMetrics): BrowserPageMetrics {
    return {
        measurement: 'dom',
        width: metrics.pageWidth,
        height: metrics.pageHeight,
        viewportWidth: metrics.viewportWidth,
        viewportHeight: metrics.viewportHeight,
        scrollX: metrics.scrollX,
        scrollY: metrics.scrollY,
    };
}

function unavailableBrowserPageMetrics(): BrowserPageMetrics {
    return {
        measurement: 'unavailable',
        width: null,
        height: null,
        viewportWidth: null,
        viewportHeight: null,
        scrollX: null,
        scrollY: null,
    };
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

function summarizeMediaSourceUrl(value: string): string {
    if (value.startsWith('data:')) {
        const separator = value.indexOf(',');
        return `${value.slice(0, separator >= 0 ? Math.min(separator + 1, 80) : 80)}…`;
    }
    return value.length > 2_000 ? `${value.slice(0, 1_999)}…` : value;
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
    let launchInFlight: Promise<void> | null = null;
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
        lastPointerAction: BrowserPointerState | null;
        frameSequence: number;
        latestAgentFrame: BrowserFrameSnapshot | null;
        agentFrameHistory: BrowserFrameSnapshot[];
        downloads: BrowserDownloadFile[];
        downloadTasks: Set<Promise<void>>;
        consoleMessages: BrowserConsoleEntry[];
        pageErrors: BrowserPageErrorEntry[];
        failedRequests: BrowserNetworkEntry[];
        httpErrors: BrowserNetworkEntry[];
        uploadWorkspaceDir: string | null;
        elementRefs: {
            page: Page;
            url: string;
            byRef: Map<string, { handle: ElementHandle; frame: Frame; label: string; metadata: BrowserPageElementRef }>;
        } | null;
        pageAssets: Map<string, { asset: BrowserPageAsset; frame: Frame; page: Page; pageUrl: string; sourceUrl?: string }>;
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

    const createSessionState = (requestedId?: string, sessionWorkspaceDir?: string): BrowserSessionState => {
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
            lastPointerAction: null,
            frameSequence: 0,
            latestAgentFrame: null,
            agentFrameHistory: [],
            downloads: [],
            downloadTasks: new Set(),
            consoleMessages: [],
            pageErrors: [],
            failedRequests: [],
            httpErrors: [],
            uploadWorkspaceDir: sessionWorkspaceDir
                ? path.resolve(/*turbopackIgnore: true*/ process.cwd(), sessionWorkspaceDir)
                : null,
            elementRefs: null,
            pageAssets: new Map(),
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
    const workspaceDir = path.resolve(
        /*turbopackIgnore: true*/ process.cwd(),
        options.workspaceDir || path.dirname(downloadsDir)
    );
    const validateUploadBatch = (
        session: BrowserSessionState,
        filePath: string | string[],
        actionName: 'chooseFile' | 'dropFiles' | 'uploadFile',
    ): {
        success: true;
        resolvedWorkspace: string;
        resolvedFiles: string[];
        relativePaths: string[];
        filenames: string[];
    } | {
        success: false;
        error: string;
    } => {
        const requestedPaths = (Array.isArray(filePath) ? filePath : [filePath])
            .map(value => String(value || '').trim());
        if (requestedPaths.some(requestedPath => !requestedPath)) {
            return { success: false, error: `${actionName} paths must all be non-empty.` };
        }
        if (requestedPaths.length === 0) {
            return { success: false, error: `${actionName} needs a workspace-relative "path" or non-empty "paths" list.` };
        }
        if (requestedPaths.length > MAX_UPLOAD_FILES) {
            return { success: false, error: `${actionName} accepts at most ${MAX_UPLOAD_FILES} files at once.` };
        }

        let resolvedWorkspace: string;
        try {
            resolvedWorkspace = fs.realpathSync(session.uploadWorkspaceDir || workspaceDir);
        } catch {
            return { success: false, error: 'The active profile workspace is unavailable.' };
        }

        // Validate the complete batch before the browser sees any file, so one
        // bad item can never cause a partial selection or drop.
        const resolvedFiles: string[] = [];
        const relativePaths: string[] = [];
        for (const requestedPath of requestedPaths) {
            const candidate = path.isAbsolute(requestedPath)
                ? requestedPath
                : path.resolve(session.uploadWorkspaceDir || workspaceDir, requestedPath);
            let resolvedFile: string;
            try {
                resolvedFile = fs.realpathSync(candidate);
            } catch {
                return { success: false, error: `The requested workspace file was not found: ${path.basename(requestedPath) || '<empty>'}.` };
            }
            const relative = path.relative(resolvedWorkspace, resolvedFile);
            if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                return { success: false, error: 'Every selected file must be inside the active profile workspace.' };
            }
            if (!fs.statSync(resolvedFile).isFile()) {
                return { success: false, error: `The selected workspace path is not a file: ${relative}.` };
            }
            resolvedFiles.push(resolvedFile);
            relativePaths.push(relative.split(path.sep).join('/'));
        }

        return {
            success: true,
            resolvedWorkspace,
            resolvedFiles,
            relativePaths,
            filenames: resolvedFiles.map(resolvedFile => path.basename(resolvedFile)),
        };
    };
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
    const resetSessionsAfterContextLoss = () => {
        for (const session of sessions.values()) {
            disposeElementRefs(session);
            session.pages = [];
            session.activePage = null;
            session.lastMousePosition = null;
            session.latestAgentFrame = null;
            session.agentFrameHistory = [];
            session.pageAssets.clear();
        }
    };
    const isContextConnected = (candidate: BrowserContext): boolean => {
        try {
            const browser = candidate.browser();
            return browser === null || browser.isConnected();
        } catch {
            return false;
        }
    };
    const isClosedContextError = (error: unknown): boolean => {
        const message = formatBrowserError(error);
        return /(?:target page, context or browser has been closed|browser context.*closed|browser has been closed|target closed|browser disconnected)/i.test(message);
    };
    const trackContextLifecycle = (candidate: BrowserContext) => {
        candidate.once('close', () => {
            if (context !== candidate) return;
            context = null;
            resetSessionsAfterContextLoss();
            log('♻️ Patchright browser context closed; the next browser action will relaunch it with the same persistent profile.');
        });
    };
    const recoverClosedContext = async (candidate: BrowserContext, error: unknown): Promise<void> => {
        if (context === candidate) {
            context = null;
            resetSessionsAfterContextLoss();
        }
        try {
            await candidate.close();
        } catch {
            // The browser process may already be gone.
        }
        log(`♻️ Relaunching Patchright after a closed browser context: ${formatBrowserError(error)}`);
        await manager.launch();
    };
    const openManagedPage = async (): Promise<Page> => {
        if (!context || !isContextConnected(context)) {
            await manager.launch();
        }
        if (!context) throw new Error('Browser not launched');

        const candidate = context;
        try {
            return await candidate.newPage();
        } catch (error) {
            if (!isClosedContextError(error)) throw error;
            await recoverClosedContext(candidate, error);
            if (!context) throw new Error('Browser relaunch did not create a context');
            return context.newPage();
        }
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
        if (!context || !isContextConnected(context)) {
            await manager.launch();
        }
        if (!context) throw new Error('Browser not launched');

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

        const newPage = await openManagedPage();
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

    type BrowserScrollProbe = {
        key: string;
        before: BrowserScrollSnapshot[];
    };

    const beginScrollProbe = async (
        activePage: Page,
        pointer: { x: number; y: number } | null,
        inputMode: BrowserScrollResult['inputMode'],
    ): Promise<BrowserScrollProbe> => {
        const key = `__orchestrator_scroll_probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const before = await activePage.evaluate(({ probeKey, pointerPosition, mode }) => {
            type ProbeSnapshot = {
                target: 'document' | 'element';
                label: string;
                tagName: string;
                role?: string;
                name?: string;
                scrollLeft: number;
                scrollTop: number;
                scrollWidth: number;
                scrollHeight: number;
                clientWidth: number;
                clientHeight: number;
            };
            type ProbeState = { elements: Element[] };

            const root = document.scrollingElement || document.documentElement;
            const elements: Element[] = [];
            const seen = new Set<Element>();
            const add = (element: Element | null) => {
                if (!element || seen.has(element)) return;
                seen.add(element);
                elements.push(element);
            };
            const isScrollable = (element: Element) => {
                if (element === root) return true;
                if (!(element instanceof HTMLElement)) return false;
                const style = getComputedStyle(element);
                const permitsY = /^(auto|scroll|overlay)$/.test(style.overflowY);
                const permitsX = /^(auto|scroll|overlay)$/.test(style.overflowX);
                return (permitsY && element.scrollHeight > element.clientHeight + 1)
                    || (permitsX && element.scrollWidth > element.clientWidth + 1);
            };
            const collectAncestors = (start: Element | null) => {
                let current = start;
                while (current) {
                    if (isScrollable(current)) add(current);
                    current = current.parentElement;
                }
            };

            let pagePoint = pointerPosition;
            if (pagePoint && mode === 'display') {
                const sideChrome = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
                const topChrome = Math.max(0, Math.round(window.outerHeight - window.innerHeight - sideChrome));
                pagePoint = {
                    x: Math.round(pagePoint.x - window.screenX - sideChrome),
                    y: Math.round(pagePoint.y - window.screenY - topChrome),
                };
            }
            if (!pagePoint) {
                pagePoint = { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
            }

            if (pagePoint.x >= 0 && pagePoint.y >= 0 && pagePoint.x < window.innerWidth && pagePoint.y < window.innerHeight) {
                collectAncestors(document.elementFromPoint(pagePoint.x, pagePoint.y));
            }
            collectAncestors(document.activeElement);
            add(root);

            const cleanText = (value: string | null | undefined, max = 80) => String(value || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, max);
            const snapshot = (element: Element): ProbeSnapshot => {
                const isDocument = element === root;
                const html = element as HTMLElement;
                const tagName = isDocument ? 'document' : element.tagName.toLowerCase();
                const role = isDocument ? undefined : cleanText(element.getAttribute('role'), 40) || undefined;
                const name = isDocument
                    ? undefined
                    : cleanText(
                        element.getAttribute('aria-label')
                        || element.getAttribute('title')
                        || (element.id ? `#${element.id}` : ''),
                    ) || undefined;
                const label = isDocument
                    ? 'document'
                    : name || role || tagName;

                return {
                    target: isDocument ? 'document' : 'element',
                    label,
                    tagName,
                    role,
                    name,
                    scrollLeft: Math.round(html.scrollLeft || 0),
                    scrollTop: Math.round(html.scrollTop || 0),
                    scrollWidth: Math.round(html.scrollWidth || 0),
                    scrollHeight: Math.round(html.scrollHeight || 0),
                    clientWidth: Math.round(html.clientWidth || window.innerWidth),
                    clientHeight: Math.round(html.clientHeight || window.innerHeight),
                };
            };

            const globalStore = globalThis as typeof globalThis & Record<string, ProbeState | undefined>;
            globalStore[probeKey] = { elements };
            return elements.map(snapshot);
        }, { probeKey: key, pointerPosition: pointer, mode: inputMode });

        return { key, before };
    };

    const finishScrollProbe = async (
        activePage: Page,
        probe: BrowserScrollProbe,
    ): Promise<BrowserScrollSnapshot[]> => {
        return activePage.evaluate((probeKey) => {
            type ProbeState = { elements: Element[] };
            const globalStore = globalThis as typeof globalThis & Record<string, ProbeState | undefined>;
            const state = globalStore[probeKey];
            delete globalStore[probeKey];
            if (!state) return [];

            const root = document.scrollingElement || document.documentElement;
            const cleanText = (value: string | null | undefined, max = 80) => String(value || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, max);

            return state.elements
                .map(element => {
                    const isDocument = element === root;
                    const html = element as HTMLElement;
                    const tagName = isDocument ? 'document' : element.tagName.toLowerCase();
                    const role = isDocument ? undefined : cleanText(element.getAttribute('role'), 40) || undefined;
                    const name = isDocument
                        ? undefined
                        : cleanText(
                            element.getAttribute('aria-label')
                            || element.getAttribute('title')
                            || (element.id ? `#${element.id}` : ''),
                        ) || undefined;
                    return {
                        target: isDocument ? 'document' as const : 'element' as const,
                        label: isDocument ? 'document' : name || role || tagName,
                        tagName,
                        role,
                        name,
                        scrollLeft: Math.round(html.scrollLeft || 0),
                        scrollTop: Math.round(html.scrollTop || 0),
                        scrollWidth: Math.round(html.scrollWidth || 0),
                        scrollHeight: Math.round(html.scrollHeight || 0),
                        clientWidth: Math.round(html.clientWidth || window.innerWidth),
                        clientHeight: Math.round(html.clientHeight || window.innerHeight),
                    };
                });
        }, probe.key);
    };

    const selectScrollProbeResult = (
        probe: BrowserScrollProbe,
        after: BrowserScrollSnapshot[],
        direction: 'up' | 'down' | 'left' | 'right',
        inputMode: BrowserScrollResult['inputMode'],
    ): BrowserScrollResult => {
        const horizontal = direction === 'left' || direction === 'right';
        const candidateCount = Math.min(probe.before.length, after.length);
        let selectedIndex = -1;

        for (let index = 0; index < candidateCount; index++) {
            const beforePosition = horizontal ? probe.before[index].scrollLeft : probe.before[index].scrollTop;
            const afterPosition = horizontal ? after[index].scrollLeft : after[index].scrollTop;
            if (Math.abs(afterPosition - beforePosition) > 1) {
                selectedIndex = index;
                break;
            }
        }

        if (selectedIndex < 0) {
            selectedIndex = after.findIndex(snapshot => horizontal
                ? snapshot.scrollWidth > snapshot.clientWidth + 1
                : snapshot.scrollHeight > snapshot.clientHeight + 1);
        }
        if (selectedIndex < 0 && after.length > 0) {
            selectedIndex = after.findIndex(snapshot => snapshot.target === 'document');
            if (selectedIndex < 0) selectedIndex = 0;
        }

        const before = selectedIndex >= 0 ? probe.before[selectedIndex] || null : null;
        const selectedAfter = selectedIndex >= 0 ? after[selectedIndex] || null : null;
        const changed = Boolean(before && selectedAfter && (
            horizontal
                ? Math.abs(selectedAfter.scrollLeft - before.scrollLeft) > 1
                : Math.abs(selectedAfter.scrollTop - before.scrollTop) > 1
        ));

        return {
            available: Boolean(selectedAfter),
            inputMode,
            changed,
            before,
            after: selectedAfter,
            ...(!selectedAfter ? { error: 'No measurable document or scrollable element was available after input.' } : {}),
        };
    };

    const performScrollWithTelemetry = async (
        activePage: Page,
        session: BrowserSessionState,
        direction: 'up' | 'down' | 'left' | 'right',
        inputMode: BrowserScrollResult['inputMode'],
        work: () => Promise<void>,
    ): Promise<BrowserScrollResult> => {
        let probeError = '';
        const probe = await beginScrollProbe(activePage, session.lastMousePosition, inputMode).catch((error) => {
            probeError = formatBrowserError(error);
            return null;
        });
        try {
            await work();
        } catch (error) {
            if (probe) await finishScrollProbe(activePage, probe).catch(() => []);
            throw error;
        }

        if (!probe) {
            return {
                available: false,
                inputMode,
                changed: false,
                before: null,
                after: null,
                error: `Could not capture pre-scroll DOM telemetry${probeError ? `: ${probeError}` : '.'}`,
            };
        }

        await sleep(80);
        const after = await finishScrollProbe(activePage, probe).catch(() => []);
        if (after.length === 0) {
            return {
                available: false,
                inputMode,
                changed: false,
                before: null,
                after: null,
                error: 'Could not capture post-scroll DOM telemetry.',
            };
        }

        return selectScrollProbeResult(probe, after, direction, inputMode);
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
            const metrics = await getFrameMetrics(activePage).catch((error) => {
                if (source === 'agent') {
                    log(`⚠️ Page DOM metrics unavailable for display capture: ${formatBrowserError(error)}`);
                }
                return null;
            });
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
                page: metrics ? toBrowserPageMetrics(metrics) : unavailableBrowserPageMetrics(),
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
            page: toBrowserPageMetrics(metrics),
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
        const encoderPage = await openManagedPage();
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
                    const parent = document.fullscreenElement || document.documentElement || document.body;
                    if (!parent) return false;

                    // Small persistent dot: stays visible in evidence
                    // screenshots captured after the click.
                    const dotSize = 10;
                    const dot = document.createElement('div');
                    dot.style.position = 'fixed';
                    dot.style.left = `${x - dotSize / 2}px`;
                    dot.style.top = `${y - dotSize / 2}px`;
                    dot.style.width = `${dotSize}px`;
                    dot.style.height = `${dotSize}px`;
                    dot.style.borderRadius = '50%';
                    dot.style.backgroundColor = 'rgba(20, 20, 24, 0.85)';
                    dot.style.border = '2px solid rgba(255, 255, 255, 0.95)';
                    dot.style.boxShadow = '0 0 6px rgba(0, 0, 0, 0.45)';
                    dot.style.zIndex = '2147483647';
                    dot.style.pointerEvents = 'none';
                    dot.id = `ai-click-${Date.now()}`;
                    parent.appendChild(dot);
                    setTimeout(() => dot.remove(), 2000);

                    // Expanding ripple ring: the live-view click feedback.
                    const ringSize = 26;
                    const ring = document.createElement('div');
                    ring.style.position = 'fixed';
                    ring.style.left = `${x - ringSize / 2}px`;
                    ring.style.top = `${y - ringSize / 2}px`;
                    ring.style.width = `${ringSize}px`;
                    ring.style.height = `${ringSize}px`;
                    ring.style.borderRadius = '50%';
                    ring.style.border = '2.5px solid rgba(255, 255, 255, 0.95)';
                    ring.style.backgroundColor = 'rgba(20, 20, 24, 0.25)';
                    ring.style.boxShadow = '0 0 10px rgba(0, 0, 0, 0.4)';
                    ring.style.zIndex = '2147483647';
                    ring.style.pointerEvents = 'none';
                    parent.appendChild(ring);
                    if (typeof ring.animate === 'function') {
                        ring.animate([
                            { transform: 'scale(0.4)', opacity: 1 },
                            { transform: 'scale(1.7)', opacity: 0 },
                        ], { duration: 650, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
                    }
                    setTimeout(() => ring.remove(), 700);

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

    const setDisplayPointer = (
        session: BrowserSessionState,
        x: number,
        y: number,
        kind: BrowserPointerActionKind,
    ): void => {
        session.lastMousePosition = { x, y };
        session.lastPointerAction = { x, y, kind, at: Date.now() };
    };

    const normalizeClickOptions = (value?: number | BrowserClickOptions): Required<BrowserClickOptions> => {
        const options = typeof value === 'number' ? { count: value } : (value || {});
        return {
            count: Number.isFinite(options.count) ? Math.max(1, Math.min(5, Math.round(options.count || 1))) : 1,
            button: options.button || 'left',
            modifiers: [...new Set(options.modifiers || [])].filter((modifier): modifier is BrowserKeyModifier =>
                modifier === 'Alt' || modifier === 'Control' || modifier === 'Meta' || modifier === 'Shift'
            ),
        };
    };

    const mouseButtonNumber = (button: BrowserMouseButton): string =>
        button === 'middle' ? '2' : button === 'right' ? '3' : '1';

    const clickDisplayCoordinate = async (
        session: BrowserSessionState,
        x: number,
        y: number,
        clickOptions?: number | BrowserClickOptions,
    ): Promise<boolean> => {
        const [safeX, safeY] = clampDisplayCoordinate(x, y);
        const options = normalizeClickOptions(clickOptions);
        const repeat = options.count;
        const button = mouseButtonNumber(options.button);

        try {
            log(`🖱️ Display ${options.button} click at ${safeX}, ${safeY} (Count: ${repeat})`);
            await xdotool(['mousemove', String(safeX), String(safeY)]);
            setDisplayPointer(session, safeX, safeY, 'click');
            if (await drawDisplayClickMarker(session, safeX, safeY)) {
                await sleep(120);
            }
            for (const modifier of options.modifiers) {
                await xdotool(['keydown', normalizeXdotoolKey(modifier)]);
            }
            try {
                for (let i = 0; i < repeat; i++) {
                    await xdotool(['mousedown', button]);
                    await sleep(45);
                    await xdotool(['mouseup', button]);
                    if (i < repeat - 1) await sleep(80);
                }
            } finally {
                for (const modifier of [...options.modifiers].reverse()) {
                    await xdotool(['keyup', normalizeXdotoolKey(modifier)]).catch(() => {});
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
        setDisplayPointer(session, safeX, safeY, 'move');
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
            setDisplayPointer(session, safeStartX, safeStartY, 'drag');
            for (let step = 1; step <= steps; step++) {
                const ratio = step / steps;
                const x = Math.round(safeStartX + (safeEndX - safeStartX) * ratio);
                const y = Math.round(safeStartY + (safeEndY - safeStartY) * ratio);
                await xdotool(['mousemove', String(x), String(y)]);
                await sleep(Math.max(5, durationMs / steps));
            }
            setDisplayPointer(session, safeEndX, safeEndY, 'drag');
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
            setDisplayPointer(session, safeX, safeY, 'hold');
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
        setDisplayPointer(session, targetX, targetY, 'scroll');

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
                    const metrics = await getFrameMetrics(activePage).catch((error) => {
                        log(`⚠️ Page DOM metrics unavailable for display recording: ${formatBrowserError(error)}`);
                        return null;
                    });
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
                        page: metrics ? toBrowserPageMetrics(metrics) : unavailableBrowserPageMetrics(),
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
                        page: toBrowserPageMetrics(metrics),
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

            async clickCoordinate(x: number, y: number, clickOptions?: number | BrowserClickOptions): Promise<boolean> {
                const options = normalizeClickOptions(clickOptions);
                if (shouldUseDisplayAutomation()) {
                    return clickDisplayCoordinate(session, x, y, options);
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
                    log(`🖱️ ${options.button} clicking at ${safeX}, ${safeY} (Count: ${options.count})`);

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

                    for (const modifier of options.modifiers) {
                        await activePage.keyboard.down(modifier);
                    }
                    try {
                        await activePage.mouse.click(safeX, safeY, {
                            button: options.button,
                            clickCount: options.count,
                            delay: options.count > 1 ? 70 : 24,
                        });
                    } finally {
                        for (const modifier of [...options.modifiers].reverse()) {
                            await activePage.keyboard.up(modifier).catch(() => {});
                        }
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

            async pressKey(key: string, modifiers: BrowserKeyModifier[] = []) {
                const shortcut = [...new Set(modifiers), key].filter(Boolean).join('+');
                if (shouldUseDisplayAutomation()) {
                    await pressDisplayKey(shortcut);
                    return;
                }

                const activePage = await ensureActivePage(session);
                await pressShortcut(activePage, shortcut);
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
                const activePage = await ensureActivePage(session);
                if (shouldUseDisplayAutomation()) {
                    return performScrollWithTelemetry(
                        activePage,
                        session,
                        direction,
                        'display',
                        () => scrollDisplay(session, direction, amount),
                    );
                }

                const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
                const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
                return performScrollWithTelemetry(
                    activePage,
                    session,
                    direction,
                    'page',
                    () => activePage.mouse.wheel(deltaX, deltaY),
                );
            },

            async scrollToBottom() {
                const activePage = await ensureActivePage(session);
                if (shouldUseDisplayAutomation()) {
                    return performScrollWithTelemetry(
                        activePage,
                        session,
                        'down',
                        'display',
                        () => pressDisplayKey('End'),
                    );
                }

                const pointer = session.lastMousePosition;
                return performScrollWithTelemetry(
                    activePage,
                    session,
                    'down',
                    'page',
                    () => activePage.evaluate((lastPointer) => {
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
                    }, pointer),
                );
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
                try {
                    const newPage = await openManagedPage();
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

            getPointerState(): BrowserPointerState | null {
                // Display coordinates are the live view's coordinate space; the
                // viewport (CDP) path uses page coordinates the overlay cannot
                // map, so only report the pointer in display-automation mode.
                if (!shouldUseDisplayAutomation()) return null;
                return session.lastPointerAction ? { ...session.lastPointerAction } : null;
            },

            async readPage(): Promise<BrowserReadPageResult> {
                const capturedAt = new Date().toISOString();
                try {
                    const activePage = await ensureActivePage(session);
                    disposeElementRefs(session);
                    const elements: BrowserPageElementRef[] = [];
                    const byRef = new Map<string, { handle: ElementHandle; frame: Frame; label: string; metadata: BrowserPageElementRef }>();
                    let total = 0;

                    const frames = activePage.frames();
                    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
                        const frame = frames[frameIndex];
                        try {
                            const remaining = Math.max(0, MAX_READ_PAGE_ELEMENTS - elements.length);
                            const collectionHandle = await frame.evaluateHandle(({ maxElements }) => {
                            const selector = [
                                'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
                                '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
                                '[role="option"]', '[role="checkbox"]', '[role="radio"]',
                                '[role="combobox"]', '[role="switch"]', '[role="textbox"]',
                                '[contenteditable="true"]', '[onclick]',
                            ].join(', ');
                            const out: Element[] = [];
                            let found = 0;
                            const isVisible = (el: Element): boolean => {
                                const rect = el.getBoundingClientRect();
                                const style = window.getComputedStyle(el);
                                return rect.width >= 1
                                    && rect.height >= 1
                                    && style.visibility !== 'hidden'
                                    && style.display !== 'none';
                            };
                            const isUploadReady = (input: HTMLInputElement): boolean => {
                                if (input.disabled) return false;
                                if (isVisible(input)) return true;
                                if (Array.from(input.labels || []).some(isVisible)) return true;
                                const dialog = input.closest('dialog, [role="dialog"], [aria-modal="true"]');
                                if (!dialog || !isVisible(dialog)) return false;
                                return !(dialog instanceof HTMLDialogElement) || dialog.open;
                            };
                            const visit = (root: Document | ShadowRoot) => {
                                for (const el of Array.from(root.querySelectorAll(selector))) {
                                    const isFileInput = el instanceof HTMLInputElement && el.type === 'file';
                                    const rect = el.getBoundingClientRect();
                                    const style = window.getComputedStyle(el);
                                    if (isFileInput && !isUploadReady(el)) continue;
                                    if (!isFileInput && (rect.width < 1 || rect.height < 1 || style.visibility === 'hidden' || style.display === 'none')) continue;
                                    found += 1;
                                    if (out.length < maxElements) out.push(el);
                                }
                                for (const host of Array.from(root.querySelectorAll('*'))) {
                                    if (host.shadowRoot) visit(host.shadowRoot);
                                }
                            };
                            visit(document);
                            return { elements: out, total: found };
                            }, { maxElements: remaining });

                            const metadata = await frame.evaluate((collected) => {
                            const textOf = (el: Element): string => {
                                const aria = el.getAttribute('aria-label')?.trim();
                                if (aria) return aria;
                                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
                                    const labels = 'labels' in el && el.labels
                                        ? Array.from(el.labels).map((label) => label.textContent?.trim() || '').filter(Boolean).join(' ')
                                        : '';
                                    if (labels) return labels;
                                    const fallback = el.getAttribute('placeholder') || el.getAttribute('name') || '';
                                    if (fallback) return fallback;
                                    if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return el.value || '';
                                    return '';
                                }
                                return (el as HTMLElement).innerText?.trim()
                                    || el.textContent?.trim()
                                    || el.querySelector('img[alt]')?.getAttribute('alt')
                                    || el.getAttribute('title')
                                    || '';
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
                                const tag = el.tagName.toLowerCase();
                                const inputType = el instanceof HTMLInputElement ? el.type || 'text' : undefined;
                                const source = el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement
                                    ? el.currentSrc || el.getAttribute('src') || undefined
                                    : el.querySelector('img,video,audio')?.getAttribute('src') || undefined;
                                const entry: Omit<BrowserPageElementRef, 'ref'> = {
                                    role: roleOf(el),
                                    name: textOf(el).replace(/\s+/g, ' ').slice(0, 80),
                                    tag,
                                    kind: inputType || undefined,
                                    inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
                                };
                                if (el instanceof HTMLAnchorElement && el.href) entry.href = el.href.slice(0, 500);
                                if (source) entry.sourceUrl = new URL(source, document.baseURI).href.slice(0, 1000);
                                if (el instanceof HTMLInputElement) {
                                    if (el.type !== 'password' && el.value && el.type !== 'submit' && el.type !== 'button') entry.value = el.value.slice(0, 60);
                                    if (el.type === 'checkbox' || el.type === 'radio') entry.checked = el.checked;
                                    if (el.disabled) entry.disabled = true;
                                    if (el.type === 'file') {
                                        entry.multiple = el.multiple;
                                        entry.accept = el.accept || undefined;
                                        entry.uploadReady = true;
                                    }
                                } else if (el instanceof HTMLSelectElement) {
                                    entry.value = (el.selectedOptions[0]?.textContent || '').trim().slice(0, 60);
                                    entry.multiple = el.multiple;
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

                            total += await frame.evaluate((collected) => collected.total, collectionHandle);
                            const elementsHandle = await collectionHandle.getProperty('elements');
                            const properties = await elementsHandle.getProperties();
                            for (let index = 0; index < metadata.length; index++) {
                                const handle = properties.get(String(index))?.asElement();
                                if (!handle) continue;
                                const ref = `e${elements.length + 1}`;
                                const frameLabel = frame === activePage.mainFrame()
                                    ? 'main'
                                    : `frame ${frameIndex}: ${frame.url().slice(0, 160)}`;
                                const element: BrowserPageElementRef = { ref, ...metadata[index], frame: frameLabel };
                                byRef.set(ref, { handle, frame, label: element.name || element.role, metadata: element });
                                elements.push(element);
                            }
                            void elementsHandle.dispose().catch(() => {});
                            void collectionHandle.dispose().catch(() => {});
                        } catch (frameError) {
                            log(`⚠️ readPage skipped a transient frame: ${formatBrowserError(frameError)}`);
                        }
                    }

                    session.elementRefs = {
                        page: activePage,
                        url: activePage.url(),
                        byRef,
                    };

                    return {
                        supported: true,
                        url: activePage.url(),
                        capturedAt,
                        total,
                        truncated: total > elements.length,
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

            async inspectAt(x: number, y: number): Promise<BrowserInspectAtResult> {
                const activePage = await ensureActivePage(session);
                let viewportX = Math.round(x);
                let viewportY = Math.round(y);

                if (shouldUseDisplayAutomation()) {
                    const mapped = await activePage.evaluate(({ displayX, displayY }) => {
                        const sideChrome = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
                        const topChrome = Math.max(0, Math.round(window.outerHeight - window.innerHeight - sideChrome));
                        return {
                            x: displayX - window.screenX - sideChrome,
                            y: displayY - window.screenY - topChrome,
                            width: window.innerWidth,
                            height: window.innerHeight,
                        };
                    }, { displayX: viewportX, displayY: viewportY });
                    if (mapped.x < 0 || mapped.y < 0 || mapped.x >= mapped.width || mapped.y >= mapped.height) {
                        return { supported: true, success: false, surface: 'native-browser-ui', error: 'The coordinate is in native browser UI, outside webpage content.' };
                    }
                    viewportX = mapped.x;
                    viewportY = mapped.y;
                }

                const viewport = await facade.getViewport();
                if (viewportX < 0 || viewportY < 0 || viewportX >= viewport.width || viewportY >= viewport.height) {
                    return { supported: true, success: false, surface: 'none', error: 'The coordinate is outside the current webpage viewport.' };
                }

                const frames = [...activePage.frames()].reverse();
                for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
                    const frame = frames[frameIndex];
                    let localX = viewportX;
                    let localY = viewportY;
                    if (frame !== activePage.mainFrame()) {
                        const frameElement = await frame.frameElement().catch(() => null);
                        const frameBox = frameElement ? await frameElement.boundingBox().catch(() => null) : null;
                        if (frameElement) void frameElement.dispose().catch(() => {});
                        if (!frameBox || viewportX < frameBox.x || viewportY < frameBox.y || viewportX >= frameBox.x + frameBox.width || viewportY >= frameBox.y + frameBox.height) continue;
                        localX = viewportX - frameBox.x;
                        localY = viewportY - frameBox.y;
                    }

                    const handle = (await frame.evaluateHandle(({ pointX, pointY }) => {
                        let element = document.elementFromPoint(pointX, pointY);
                        while (element?.shadowRoot) {
                            const nested = element.shadowRoot.elementFromPoint(pointX, pointY);
                            if (!nested || nested === element) break;
                            element = nested;
                        }
                        return element;
                    }, { pointX: localX, pointY: localY })).asElement();
                    if (!handle) continue;

                    try {
                        const meta = await handle.evaluate((el) => {
                            const tag = el.tagName.toLowerCase();
                            const input = el instanceof HTMLInputElement ? el : null;
                            const role = el.getAttribute('role')
                                || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : input ? `input:${input.type || 'text'}` : tag);
                            const labels = input?.labels
                                ? Array.from(input.labels).map((label) => label.textContent?.trim() || '').filter(Boolean).join(' ')
                                : '';
                            const name = (el.getAttribute('aria-label') || labels || (el as HTMLElement).innerText || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
                            const rect = el.getBoundingClientRect();
                            const media = el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement ? el : null;
                            const result: Omit<BrowserPageElementRef, 'ref'> = {
                                role,
                                name,
                                tag,
                                kind: input?.type || undefined,
                                inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
                            };
                            if (el instanceof HTMLAnchorElement && el.href) result.href = el.href.slice(0, 500);
                            if (media?.currentSrc || media?.getAttribute('src')) result.sourceUrl = new URL(media.currentSrc || media.getAttribute('src') || '', document.baseURI).href.slice(0, 1000);
                            if (input) {
                                if (input.type !== 'password' && input.value && input.type !== 'submit' && input.type !== 'button') result.value = input.value.slice(0, 60);
                                if (input.type === 'checkbox' || input.type === 'radio') result.checked = input.checked;
                                if (input.disabled) result.disabled = true;
                                if (input.type === 'file') {
                                    result.multiple = input.multiple;
                                    result.accept = input.accept || undefined;
                                    result.uploadReady = true;
                                }
                            } else if (el instanceof HTMLSelectElement) {
                                result.value = (el.selectedOptions[0]?.textContent || '').trim().slice(0, 60);
                                result.multiple = el.multiple;
                                if (el.disabled) result.disabled = true;
                            } else if (el instanceof HTMLTextAreaElement) {
                                if (el.value) result.value = el.value.slice(0, 60);
                                if (el.disabled) result.disabled = true;
                            } else if (el instanceof HTMLButtonElement && el.disabled) {
                                result.disabled = true;
                            }
                            return result;
                        });
                        const bounds = await handle.boundingBox();
                        if (!bounds) continue;

                        if (!session.elementRefs || session.elementRefs.page !== activePage) {
                            disposeElementRefs(session);
                            session.elementRefs = { page: activePage, url: activePage.url(), byRef: new Map() };
                        }
                        const store = session.elementRefs;
                        const existing = [...store.byRef.entries()].find(([, entry]) => entry.handle === handle)?.[0];
                        const ref = existing || `e${store.byRef.size + 1}`;
                        const frameLabel = frame === activePage.mainFrame() ? 'main' : `frame: ${frame.url().slice(0, 160)}`;
                        const element: BrowserPageElementRef = { ref, ...meta, frame: frameLabel };
                        store.byRef.set(ref, { handle, frame, label: element.name || element.role, metadata: element });
                        return { supported: true, success: true, surface: 'page', ref, label: element.name || element.role, element, bounds };
                    } catch (error) {
                        void handle.dispose().catch(() => {});
                        return { supported: false, success: false, surface: 'page', error: formatBrowserError(error) };
                    }
                }

                return { supported: true, success: false, surface: 'none', error: 'No inspectable webpage element exists at this coordinate.' };
            },

            async hoverRef(ref: string): Promise<BrowserClickRefResult> {
                const activePage = await ensureActivePage(session);
                const store = session.elementRefs;
                const entry = store?.page === activePage ? store.byRef.get(ref) : null;
                if (!entry) return { success: false, stale: true, error: `Unknown or stale element ref "${ref}". Run readPage again.` };
                try {
                    await entry.handle.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
                    const box = await entry.handle.boundingBox();
                    if (!box) return { success: false, stale: true, label: entry.label, error: `Element ${ref} is detached or hidden.` };
                    const centerX = Math.round(box.x + box.width / 2);
                    const centerY = Math.round(box.y + box.height / 2);
                    if (shouldUseDisplayAutomation()) {
                        const point = await activePage.evaluate(({ x: pageX, y: pageY }) => {
                            const sideChrome = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
                            const topChrome = Math.max(0, Math.round(window.outerHeight - window.innerHeight - sideChrome));
                            return { x: pageX + window.screenX + sideChrome, y: pageY + window.screenY + topChrome };
                        }, { x: centerX, y: centerY });
                        await hoverDisplayCoordinate(session, point.x, point.y);
                    } else {
                        await facade.hoverCoordinate(centerX, centerY);
                    }
                    return { success: true, label: entry.label };
                } catch (error) {
                    return { success: false, label: entry.label, error: formatBrowserError(error) };
                }
            },

            async selectOption(ref: string, values: string[]): Promise<BrowserClickRefResult> {
                const activePage = await ensureActivePage(session);
                const store = session.elementRefs;
                const entry = store?.page === activePage ? store.byRef.get(ref) : null;
                if (!entry) return { success: false, stale: true, error: `Unknown or stale element ref "${ref}". Run readPage again.` };
                const requested = values.map(String).map(value => value.trim()).filter(Boolean).slice(0, 20);
                if (requested.length === 0) return { success: false, label: entry.label, error: 'selectOption needs at least one value or label.' };
                try {
                    const isSelect = await entry.handle.evaluate((element) => element instanceof HTMLSelectElement);
                    if (!isSelect) return { success: false, label: entry.label, error: `${ref} is not a select element.` };
                    let selected = await entry.handle.selectOption(requested.map(value => ({ label: value }))).catch(() => []);
                    if (selected.length === 0) {
                        selected = await entry.handle.selectOption(requested.map(value => ({ value })));
                    }
                    return selected.length > 0
                        ? { success: true, label: `${entry.label}: ${selected.join(', ')}` }
                        : { success: false, label: entry.label, error: `No option matched ${requested.join(', ')}.` };
                } catch (error) {
                    return { success: false, label: entry.label, error: formatBrowserError(error) };
                }
            },

            async setChecked(ref: string, checked: boolean): Promise<BrowserClickRefResult> {
                const activePage = await ensureActivePage(session);
                const store = session.elementRefs;
                const entry = store?.page === activePage ? store.byRef.get(ref) : null;
                if (!entry) return { success: false, stale: true, error: `Unknown or stale element ref "${ref}". Run readPage again.` };
                try {
                    const state = await entry.handle.evaluate((element) => {
                        if (!(element instanceof HTMLInputElement) || (element.type !== 'checkbox' && element.type !== 'radio')) return null;
                        return { checked: element.checked, disabled: element.disabled };
                    });
                    if (!state) return { success: false, label: entry.label, error: `${ref} is not a checkbox or radio input.` };
                    if (state.disabled) return { success: false, label: entry.label, error: `${ref} is disabled.` };
                    if (state.checked !== checked) {
                        const clicked = await facade.clickRef(ref);
                        if (!clicked.success) return clicked;
                    }
                    const actual = await entry.handle.evaluate((element) => element instanceof HTMLInputElement && element.checked);
                    return actual === checked
                        ? { success: true, label: entry.label }
                        : { success: false, label: entry.label, error: `${ref} did not reach the requested checked state.` };
                } catch (error) {
                    return { success: false, label: entry.label, error: formatBrowserError(error) };
                }
            },

            async waitFor(options: BrowserWaitForOptions): Promise<BrowserWaitForResult> {
                const startedAt = Date.now();
                const timeoutMs = Math.max(100, Math.min(MAX_TARGETED_WAIT_MS, Math.round(options.timeoutMs || 10_000)));
                const activePage = await ensureActivePage(session);
                const finish = (success: boolean, observation: string, extra: Partial<BrowserWaitForResult> = {}): BrowserWaitForResult => ({
                    success,
                    elapsedMs: Date.now() - startedAt,
                    observation,
                    ...extra,
                });

                try {
                    if (options.kind === 'load') {
                        const state = options.state === 'networkidle' ? 'networkidle' : 'domcontentloaded';
                        await activePage.waitForLoadState(state, { timeout: timeoutMs });
                        return finish(true, `Page reached ${state}.`);
                    }

                    while (Date.now() - startedAt < timeoutMs) {
                        if (options.kind === 'url') {
                            const expected = String(options.url || '').trim();
                            if (!expected) return finish(false, 'waitFor url needs a URL substring.', { error: 'Missing URL.' });
                            const current = activePage.url();
                            if (current.includes(expected)) return finish(true, `URL contains "${expected}": ${current}`);
                        } else if (options.kind === 'ref') {
                            const ref = String(options.ref || '').trim();
                            const store = session.elementRefs;
                            const entry = store?.page === activePage ? store.byRef.get(ref) : null;
                            if (!entry) return finish(false, `Element ref "${ref}" is stale or unknown.`, { stale: true, error: 'Stale ref.' });
                            const state = options.state || 'visible';
                            const matched = state === 'hidden'
                                ? !(await entry.handle.isVisible().catch(() => false))
                                : state === 'enabled'
                                    ? await entry.handle.isEnabled().catch(() => false)
                                    : state === 'disabled'
                                        ? !(await entry.handle.isEnabled().catch(() => true))
                                        : await entry.handle.isVisible().catch(() => false);
                            if (matched) return finish(true, `Element ${ref} is ${state}.`);
                        } else if (options.kind === 'text') {
                            const expected = String(options.text || '').trim();
                            if (!expected) return finish(false, 'waitFor text needs non-empty text.', { error: 'Missing text.' });
                            let found = false;
                            for (const frame of activePage.frames()) {
                                found = await frame.evaluate((needle) => {
                                    const visit = (root: Document | ShadowRoot): string => {
                                        let value = '';
                                        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                                        let node = walker.nextNode();
                                        while (node) {
                                            const parent = node.parentElement;
                                            if (parent) {
                                                const style = window.getComputedStyle(parent);
                                                if (style.display !== 'none' && style.visibility !== 'hidden' && parent.getClientRects().length > 0) {
                                                    value += ` ${node.textContent || ''}`;
                                                }
                                            }
                                            node = walker.nextNode();
                                        }
                                        for (const host of Array.from(root.querySelectorAll('*'))) {
                                            if (host.shadowRoot) value += ` ${visit(host.shadowRoot)}`;
                                        }
                                        return value;
                                    };
                                    return visit(document).toLocaleLowerCase().includes(needle.toLocaleLowerCase());
                                }, expected).catch(() => false);
                                if (found) break;
                            }
                            const wantsHidden = options.state === 'hidden';
                            if ((found && !wantsHidden) || (!found && wantsHidden)) return finish(true, `Text "${expected}" is ${wantsHidden ? 'hidden/absent' : 'present'}.`);
                        }
                        await sleep(100);
                    }
                    return finish(false, `Timed out after ${timeoutMs}ms waiting for ${options.kind}.`, { error: 'Targeted wait timed out.' });
                } catch (error) {
                    return finish(false, `waitFor failed: ${formatBrowserError(error)}`, { error: formatBrowserError(error) });
                }
            },

            async clickRef(ref: string, clickOptions?: number | BrowserClickOptions): Promise<BrowserClickRefResult> {
                const activePage = await ensureActivePage(session);
                const options = normalizeClickOptions(clickOptions);
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
                        const clicked = await clickDisplayCoordinate(session, displayPoint.x, displayPoint.y, options);
                        return clicked
                            ? { success: true, label: entry.label }
                            : { success: false, label: entry.label, error: 'Display click failed.' };
                    }

                    const clicked = await facade.clickCoordinate(centerX, centerY, options);
                    return clicked
                        ? { success: true, label: entry.label }
                        : { success: false, label: entry.label, error: 'Click failed.' };
                } catch (error) {
                    return { success: false, label: entry.label, error: formatBrowserError(error) };
                }
            },

            async chooseFile(
                filePath: string | string[],
                target: BrowserChooseFileTarget,
                timeoutMs = 5_000,
            ): Promise<BrowserUploadFileResult> {
                const batch = validateUploadBatch(session, filePath, 'chooseFile');
                if (!batch.success) return batch;

                const activePage = await ensureActivePage(session);
                const targetRef = String(target.ref || '').trim();
                const coordinate = target.coordinate;
                if (!targetRef && !coordinate) {
                    return { success: false, error: 'chooseFile needs the visible chooser control as a fresh "ref" or "coordinate".' };
                }

                let label = targetRef || 'visible chooser control';
                if (targetRef) {
                    const store = session.elementRefs;
                    const entry = store?.page === activePage ? store.byRef.get(targetRef) : null;
                    if (!entry) {
                        return { success: false, stale: true, ref: targetRef, error: `Unknown or stale chooser ref "${targetRef}". Run readPage or inspectAt again.` };
                    }
                    label = entry.label;
                    const box = await entry.handle.boundingBox().catch(() => null);
                    if (!box) {
                        return { success: false, stale: true, ref: targetRef, label, error: `The chooser control ${targetRef} is not visibly clickable. Open the correct upload modal/form first.` };
                    }
                }

                try {
                    const requestedTimeout = Number.isFinite(timeoutMs) ? timeoutMs : 5_000;
                    const boundedTimeout = Math.max(1_000, Math.min(Math.floor(requestedTimeout), 10_000));
                    const chooserPromise = activePage.waitForEvent('filechooser', { timeout: boundedTimeout })
                        .catch(() => null);
                    const clicked = targetRef
                        ? await facade.clickRef(targetRef)
                        : await facade.clickCoordinate(coordinate![0], coordinate![1]);
                    if (typeof clicked === 'boolean' ? !clicked : !clicked.success) {
                        await chooserPromise;
                        const clickError = typeof clicked === 'boolean' ? 'Visible chooser click failed.' : clicked.error;
                        return { success: false, ref: targetRef || undefined, label, error: clickError || 'Visible chooser click failed.' };
                    }

                    const chooser = await chooserPromise;
                    if (!chooser) {
                        return {
                            success: false,
                            ref: targetRef || undefined,
                            label,
                            error: 'The visible control was clicked, but it did not open a web file chooser. Inspect the new UI; use dropFiles only for a real dropzone, or choose a different visible file control.',
                        };
                    }
                    if (batch.resolvedFiles.length > 1 && !chooser.isMultiple()) {
                        return {
                            success: false,
                            ref: targetRef || undefined,
                            label,
                            error: 'The chooser opened by this control does not accept multiple files.',
                        };
                    }
                    await chooser.setFiles(batch.resolvedFiles);
                    return {
                        success: true,
                        ref: targetRef || undefined,
                        label,
                        path: batch.relativePaths[0],
                        filename: batch.filenames[0],
                        paths: batch.relativePaths,
                        filenames: batch.filenames,
                        method: 'chooser',
                    };
                } catch (error) {
                    return {
                        success: false,
                        ref: targetRef || undefined,
                        label,
                        path: batch.relativePaths[0],
                        filename: batch.filenames[0],
                        paths: batch.relativePaths,
                        filenames: batch.filenames,
                        error: formatBrowserError(error).split(batch.resolvedWorkspace).join('<workspace>'),
                    };
                }
            },

            async dropFiles(filePath: string | string[], ref: string): Promise<BrowserUploadFileResult> {
                const batch = validateUploadBatch(session, filePath, 'dropFiles');
                if (!batch.success) return batch;

                const activePage = await ensureActivePage(session);
                const targetRef = String(ref || '').trim();
                if (!targetRef) return { success: false, error: 'dropFiles needs a fresh ref for the visible dropzone.' };
                const store = session.elementRefs;
                const entry = store?.page === activePage ? store.byRef.get(targetRef) : null;
                if (!entry) {
                    return { success: false, stale: true, ref: targetRef, error: `Unknown or stale dropzone ref "${targetRef}". Run readPage or inspectAt again.` };
                }
                const box = await entry.handle.boundingBox().catch(() => null);
                if (!box) {
                    return { success: false, stale: true, ref: targetRef, label: entry.label, error: `The dropzone ${targetRef} is not visible. Open the correct upload surface first.` };
                }

                let temporaryInput: ElementHandle | null = null;
                try {
                    temporaryInput = (await entry.frame.evaluateHandle(() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.multiple = true;
                        input.style.display = 'none';
                        document.documentElement.appendChild(input);
                        return input;
                    })).asElement();
                    if (!temporaryInput) throw new Error('Could not create the managed drop payload.');
                    await temporaryInput.setInputFiles(batch.resolvedFiles);
                    const dispatched = await entry.handle.evaluate((dropTarget, payloadInput) => {
                        if (!(payloadInput instanceof HTMLInputElement) || !payloadInput.files) return false;
                        const transfer = new DataTransfer();
                        for (const file of Array.from(payloadInput.files)) transfer.items.add(file);
                        transfer.dropEffect = 'copy';
                        transfer.effectAllowed = 'copy';
                        for (const type of ['dragenter', 'dragover', 'drop']) {
                            dropTarget.dispatchEvent(new DragEvent(type, {
                                bubbles: true,
                                cancelable: true,
                                composed: true,
                                dataTransfer: transfer,
                            }));
                        }
                        return true;
                    }, temporaryInput);
                    if (!dispatched) throw new Error('The managed file drop could not be dispatched.');
                    return {
                        success: true,
                        ref: targetRef,
                        label: entry.label,
                        path: batch.relativePaths[0],
                        filename: batch.filenames[0],
                        paths: batch.relativePaths,
                        filenames: batch.filenames,
                        method: 'drop',
                    };
                } catch (error) {
                    return {
                        success: false,
                        ref: targetRef,
                        label: entry.label,
                        path: batch.relativePaths[0],
                        filename: batch.filenames[0],
                        paths: batch.relativePaths,
                        filenames: batch.filenames,
                        error: formatBrowserError(error).split(batch.resolvedWorkspace).join('<workspace>'),
                    };
                } finally {
                    if (temporaryInput) {
                        await temporaryInput.evaluate((input) => (input as HTMLElement).remove()).catch(() => {});
                        void temporaryInput.dispose().catch(() => {});
                    }
                }
            },

            async uploadFile(filePath: string | string[], ref?: string): Promise<BrowserUploadFileResult> {
                const batch = validateUploadBatch(session, filePath, 'uploadFile');
                if (!batch.success) return batch;

                const activePage = await ensureActivePage(session);
                const targetRef = String(ref || '').trim();
                if (!targetRef) {
                    return { success: false, error: 'uploadFile needs an upload-ready file-input ref from readPage. Prefer chooseFile on the visible chooser control.' };
                }
                const store = session.elementRefs;
                const entry = store?.page === activePage ? store.byRef.get(targetRef) : null;
                if (!entry) {
                    return { success: false, stale: true, ref: targetRef, error: `Unknown or stale file-input ref "${targetRef}". Run readPage again.` };
                }

                try {
                    const inputState = await entry.handle.evaluate((element) => {
                        if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
                            return { valid: false, multiple: false, uploadReady: false };
                        }
                        const isVisible = (el: Element): boolean => {
                            const rect = el.getBoundingClientRect();
                            const style = window.getComputedStyle(el);
                            return rect.width >= 1 && rect.height >= 1 && style.visibility !== 'hidden' && style.display !== 'none';
                        };
                        const visibleLabel = Array.from(element.labels || []).some(isVisible);
                        const dialog = element.closest('dialog, [role="dialog"], [aria-modal="true"]');
                        const visibleDialog = Boolean(dialog && isVisible(dialog) && (!(dialog instanceof HTMLDialogElement) || dialog.open));
                        return {
                            valid: true,
                            multiple: element.multiple,
                            uploadReady: !element.disabled && (isVisible(element) || visibleLabel || visibleDialog),
                        };
                    });
                    if (!inputState.valid) {
                        return { success: false, ref: targetRef, label: entry.label, error: `${targetRef} is not an input[type=file].` };
                    }
                    if (!inputState.uploadReady) {
                        return {
                            success: false,
                            ref: targetRef,
                            label: entry.label,
                            error: `File input ${targetRef} belongs to hidden or inactive UI. Open the correct upload modal/form and use chooseFile on its visible chooser control.`,
                        };
                    }
                    if (batch.resolvedFiles.length > 1 && !inputState.multiple) {
                        return { success: false, ref: targetRef, label: entry.label, error: `${targetRef} does not accept multiple files.` };
                    }
                    await entry.handle.setInputFiles(batch.resolvedFiles);
                    return {
                        success: true,
                        ref: targetRef,
                        label: entry.label,
                        path: batch.relativePaths[0],
                        filename: batch.filenames[0],
                        paths: batch.relativePaths,
                        filenames: batch.filenames,
                        method: 'input',
                    };
                } catch (error) {
                    return {
                        success: false,
                        ref: targetRef,
                        label: entry.label,
                        path: batch.relativePaths[0],
                        filename: batch.filenames[0],
                        paths: batch.relativePaths,
                        filenames: batch.filenames,
                        error: formatBrowserError(error).split(batch.resolvedWorkspace).join('<workspace>'),
                    };
                }
            },

            async listPageAssets(): Promise<BrowserPageAssetsResult> {
                const activePage = await ensureActivePage(session);
                session.pageAssets.clear();
                try {
                    const collected = new Map<string, { asset: Omit<BrowserPageAsset, 'ref'>; frame: Frame }>();
                    let observedTotal = 0;
                    for (const [frameIndex, frame] of activePage.frames().entries()) {
                        const frameAssets = await frame.evaluate(() => {
                            const assets: Array<{ kind: BrowserPageAsset['kind']; url?: string; name: string; width?: number; height?: number }> = [];
                            const add = (kind: BrowserPageAsset['kind'], rawUrl: string | null | undefined, name: string, width?: number, height?: number) => {
                                let url: string | undefined;
                                if (rawUrl) {
                                    try { url = new URL(rawUrl, document.baseURI).href; } catch { url = undefined; }
                                }
                                assets.push({ kind, url, name: name.replace(/\s+/g, ' ').trim().slice(0, 120) || kind, width, height });
                            };
                            const roots: Array<Document | ShadowRoot> = [document];
                            for (let index = 0; index < roots.length; index++) {
                                for (const host of Array.from(roots[index].querySelectorAll('*'))) {
                                    if (host.shadowRoot) roots.push(host.shadowRoot);
                                }
                            }
                            for (const root of roots) {
                                for (const image of Array.from(root.querySelectorAll('img'))) add('image', image.currentSrc || image.src, image.alt || image.getAttribute('aria-label') || 'image', image.naturalWidth || undefined, image.naturalHeight || undefined);
                                for (const video of Array.from(root.querySelectorAll('video'))) add('video', video.currentSrc || video.src || video.querySelector('source')?.src, video.getAttribute('aria-label') || video.getAttribute('title') || 'video', video.videoWidth || undefined, video.videoHeight || undefined);
                                for (const audio of Array.from(root.querySelectorAll('audio'))) add('audio', audio.currentSrc || audio.src || audio.querySelector('source')?.src, audio.getAttribute('aria-label') || audio.getAttribute('title') || 'audio');
                                for (const candidate of Array.from(root.querySelectorAll('link[rel~="stylesheet"]'))) {
                                    const link = candidate as HTMLLinkElement;
                                    add('stylesheet', link.href, link.getAttribute('title') || link.href.split('/').pop() || 'stylesheet');
                                }
                                for (const svg of Array.from(root.querySelectorAll('svg'))) {
                                    const markup = svg.outerHTML;
                                    const source = markup.length <= 1_000_000
                                        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
                                        : undefined;
                                    add('svg', source, svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || 'inline SVG', Math.round(svg.getBoundingClientRect().width) || undefined, Math.round(svg.getBoundingClientRect().height) || undefined);
                                }
                            }
                            for (const resource of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
                                if (resource.initiatorType === 'css') add('stylesheet', resource.name, resource.name.split('/').pop() || 'stylesheet');
                                if (resource.initiatorType === 'img') add('image', resource.name, resource.name.split('/').pop() || 'image');
                                if (/\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(resource.name)) add('font', resource.name, resource.name.split('/').pop() || 'font');
                            }
                            return assets;
                        });
                        observedTotal += frameAssets.length;
                        for (const asset of frameAssets) {
                            const key = `${asset.kind}:${asset.url || `${frame.url()}:${asset.name}:${asset.width || 0}x${asset.height || 0}`}`;
                            if (collected.has(key)) continue;
                            collected.set(key, {
                                asset: {
                                    ...asset,
                                    frame: frame === activePage.mainFrame() ? 'main' : `frame ${frameIndex}: ${frame.url().slice(0, 160)}`,
                                },
                                frame,
                            });
                        }
                    }

                    const assets: BrowserPageAsset[] = [];
                    for (const entry of [...collected.values()].slice(0, MAX_PAGE_ASSETS)) {
                        const ref = `a${assets.length + 1}`;
                        const sourceUrl = entry.asset.url;
                        const publicUrl = sourceUrl?.startsWith('data:')
                            ? `${sourceUrl.slice(0, Math.min(sourceUrl.indexOf(',') + 1 || 80, 80))}…`
                            : sourceUrl && sourceUrl.length > 2_000
                                ? `${sourceUrl.slice(0, 1_999)}…`
                                : sourceUrl;
                        const asset: BrowserPageAsset = { ref, ...entry.asset, url: publicUrl };
                        assets.push(asset);
                        session.pageAssets.set(ref, {
                            asset,
                            frame: entry.frame,
                            page: activePage,
                            pageUrl: activePage.url(),
                            sourceUrl,
                        });
                    }
                    return {
                        supported: true,
                        url: activePage.url(),
                        total: Math.max(observedTotal, collected.size),
                        truncated: collected.size > assets.length,
                        assets,
                    };
                } catch (error) {
                    return { supported: false, url: activePage.url(), total: 0, truncated: false, assets: [], error: formatBrowserError(error) };
                }
            },

            async downloadMedia(target: BrowserDownloadMediaTarget): Promise<BrowserDownloadMediaResult> {
                const activePage = await ensureActivePage(session);
                let sourceUrl = '';
                let sourceFrame: Frame = activePage.mainFrame();
                let suggestedName = '';

                if (target.assetRef) {
                    const entry = session.pageAssets.get(String(target.assetRef).trim());
                    if (!entry || entry.page !== activePage || entry.pageUrl !== activePage.url()) {
                        return { success: false, stale: true, error: `Unknown or stale asset ref "${target.assetRef}". Run listPageAssets again.` };
                    }
                    sourceUrl = entry.sourceUrl || entry.asset.url || '';
                    sourceFrame = entry.frame;
                    suggestedName = entry.asset.name;
                } else {
                    let ref = String(target.ref || '').trim();
                    if (!ref && target.coordinate) {
                        const inspection = await facade.inspectAt(target.coordinate[0], target.coordinate[1]);
                        if (!inspection.success || !inspection.ref) return { success: false, error: inspection.error || 'No downloadable media exists at that coordinate.' };
                        ref = inspection.ref;
                    }
                    const store = session.elementRefs;
                    const entry = store?.page === activePage && store.url === activePage.url() ? store.byRef.get(ref) : null;
                    if (!entry) return { success: false, stale: true, error: `Unknown or stale element ref "${ref}". Run readPage or inspectAt again.` };
                    sourceFrame = entry.frame;
                    suggestedName = entry.label;
                    sourceUrl = await entry.handle.evaluate((element) => {
                        if (!(element instanceof Element)) return '';
                        const domElement = element as Element;
                        const media = domElement instanceof HTMLImageElement || domElement instanceof HTMLVideoElement || domElement instanceof HTMLAudioElement
                            ? domElement
                            : domElement.querySelector('img,video,audio,source');
                        if (media instanceof HTMLImageElement || media instanceof HTMLVideoElement || media instanceof HTMLAudioElement) return media.currentSrc || media.getAttribute('src') || '';
                        if (media instanceof HTMLSourceElement) return media.src || '';
                        if (domElement instanceof HTMLAnchorElement) return domElement.href || '';
                        return '';
                    });
                }

                if (!sourceUrl) return { success: false, error: 'The selected asset has no downloadable URL (for example, an inline SVG).' };
                let parsed: URL;
                try {
                    parsed = new URL(sourceUrl, sourceFrame.url() || activePage.url());
                } catch {
                    return { success: false, sourceUrl: summarizeMediaSourceUrl(sourceUrl), error: 'The selected media URL is invalid.' };
                }
                if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol)) {
                    return { success: false, sourceUrl: summarizeMediaSourceUrl(parsed.href), error: `Media downloads do not allow the ${parsed.protocol} URL scheme.` };
                }

                try {
                    let bytes: Buffer;
                    let contentType = '';
                    let responseFilename = '';
                    if (parsed.protocol === 'data:') {
                        if (parsed.href.length > Math.ceil(MAX_MEDIA_DOWNLOAD_BYTES * 1.5) + 1_024) {
                            throw new Error(`Media exceeds the ${MAX_MEDIA_DOWNLOAD_BYTES} byte limit.`);
                        }
                        const match = parsed.href.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/i);
                        if (!match) throw new Error('Malformed data URL.');
                        contentType = match[1] || 'application/octet-stream';
                        bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
                    } else if (parsed.protocol === 'blob:') {
                        const payload = await sourceFrame.evaluate(async ({ url, maxBytes }) => {
                            const response = await fetch(url);
                            if (!response.ok) throw new Error(`Blob fetch failed (${response.status}).`);
                            const blob = await response.blob();
                            if (blob.size > maxBytes) throw new Error(`Media exceeds ${maxBytes} bytes.`);
                            const buffer = new Uint8Array(await blob.arrayBuffer());
                            let binary = '';
                            const chunkSize = 0x8000;
                            for (let offset = 0; offset < buffer.length; offset += chunkSize) binary += String.fromCharCode(...buffer.subarray(offset, offset + chunkSize));
                            return { base64: btoa(binary), type: blob.type };
                        }, { url: parsed.href, maxBytes: MAX_MEDIA_DOWNLOAD_BYTES });
                        bytes = Buffer.from(payload.base64, 'base64');
                        contentType = payload.type;
                    } else {
                        let requestUrl = parsed.href;
                        let referer = sourceFrame.url() || activePage.url();
                        const userAgent = await activePage.evaluate(() => navigator.userAgent).catch(() => '');
                        let response: Response | null = null;

                        // Stream the response ourselves instead of using
                        // APIRequestContext.body(), which buffers an unbounded
                        // chunked response before the size guard can run.
                        for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
                            const cookies = await activePage.context().cookies(requestUrl);
                            const headers: Record<string, string> = {
                                Accept: 'image/*,video/*,audio/*,application/octet-stream,*/*;q=0.5',
                                Range: `bytes=0-${MAX_MEDIA_DOWNLOAD_BYTES}`,
                            };
                            if (/^https?:/i.test(referer)) {
                                const refererUrl = new URL(referer);
                                const targetUrl = new URL(requestUrl);
                                headers.Referer = refererUrl.origin === targetUrl.origin
                                    ? refererUrl.href
                                    : `${refererUrl.origin}/`;
                            }
                            if (userAgent) headers['User-Agent'] = userAgent;
                            if (cookies.length > 0) headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

                            const controller = new AbortController();
                            const timer = setTimeout(() => controller.abort(), 20_000);
                            try {
                                response = await fetch(requestUrl, {
                                    method: 'GET',
                                    headers,
                                    redirect: 'manual',
                                    signal: controller.signal,
                                });
                            } finally {
                                clearTimeout(timer);
                            }

                            if (![301, 302, 303, 307, 308].includes(response.status)) break;
                            const location = response.headers.get('location');
                            if (!location) throw new Error(`Media redirect ${response.status} did not include a Location header.`);
                            const redirected = new URL(location, requestUrl);
                            if (!['http:', 'https:'].includes(redirected.protocol)) {
                                throw new Error(`Media redirect does not allow the ${redirected.protocol} URL scheme.`);
                            }
                            referer = requestUrl;
                            requestUrl = redirected.href;
                            response = null;
                        }

                        if (!response) throw new Error('Media request exceeded the redirect limit.');
                        if (!response.ok) throw new Error(`Media request failed: ${response.status} ${response.statusText}`);
                        const contentLength = Number(response.headers.get('content-length') || 0);
                        if (contentLength > MAX_MEDIA_DOWNLOAD_BYTES) throw new Error(`Media exceeds the ${MAX_MEDIA_DOWNLOAD_BYTES} byte limit.`);
                        if (response.status === 206) {
                            const total = response.headers.get('content-range')?.match(/\/(\d+|\*)$/)?.[1];
                            if (!total || total === '*' || Number(total) > MAX_MEDIA_DOWNLOAD_BYTES) {
                                throw new Error(`Media exceeds the ${MAX_MEDIA_DOWNLOAD_BYTES} byte limit.`);
                            }
                        }

                        const chunks: Buffer[] = [];
                        let receivedBytes = 0;
                        const reader = response.body?.getReader();
                        if (!reader) throw new Error('Media response had no readable body.');
                        let bodyTimedOut = false;
                        const bodyTimer = setTimeout(() => {
                            bodyTimedOut = true;
                            void reader.cancel('Media response timed out.').catch(() => {});
                        }, 20_000);
                        try {
                            while (true) {
                                const chunk = await reader.read();
                                if (chunk.done) break;
                                receivedBytes += chunk.value.byteLength;
                                if (receivedBytes > MAX_MEDIA_DOWNLOAD_BYTES) {
                                    await reader.cancel().catch(() => {});
                                    throw new Error(`Media exceeds the ${MAX_MEDIA_DOWNLOAD_BYTES} byte limit.`);
                                }
                                chunks.push(Buffer.from(chunk.value));
                            }
                        } finally {
                            clearTimeout(bodyTimer);
                        }
                        if (bodyTimedOut) throw new Error('Media response timed out.');
                        bytes = Buffer.concat(chunks, receivedBytes);
                        parsed = new URL(requestUrl);
                        contentType = response.headers.get('content-type') || '';
                        const disposition = response.headers.get('content-disposition') || '';
                        responseFilename = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i)?.[1] || '';
                    }
                    if (bytes.length > MAX_MEDIA_DOWNLOAD_BYTES) throw new Error(`Media exceeds the ${MAX_MEDIA_DOWNLOAD_BYTES} byte limit.`);

                    const mimeExtension = contentType.includes('png') ? '.png'
                        : contentType.includes('jpeg') ? '.jpg'
                            : contentType.includes('webp') ? '.webp'
                                : contentType.includes('gif') ? '.gif'
                                    : contentType.includes('svg') ? '.svg'
                                        : contentType.includes('mp4') ? '.mp4'
                                            : contentType.includes('webm') ? '.webm'
                                                : contentType.includes('mpeg') ? '.mp3'
                                                    : '';
                    let filename = responseFilename ? responseFilename.trim() : '';
                    if (filename) {
                        try { filename = decodeURIComponent(filename); } catch { /* Keep the server-provided fallback verbatim. */ }
                    }
                    if (!filename) filename = parsed.protocol === 'data:' || parsed.protocol === 'blob:' ? suggestedName : path.basename(parsed.pathname);
                    filename = sanitizeDownloadFilename(filename || `page-media${mimeExtension}`);
                    if (!path.extname(filename) && mimeExtension) filename += mimeExtension;
                    fs.mkdirSync(downloadsDir, { recursive: true });
                    const savedPath = uniqueDownloadPath(downloadsDir, filename);
                    fs.writeFileSync(savedPath, bytes);
                    const download: BrowserDownloadFile = {
                        id: `media_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                        timestamp: new Date().toISOString(),
                        url: summarizeMediaSourceUrl(parsed.href),
                        suggestedFilename: filename,
                        savedPath,
                        state: 'saved',
                        size: bytes.length,
                    };
                    session.downloads.push(download);
                    log(`✅ Page media saved: ${savedPath}`);
                    return { success: true, sourceUrl: summarizeMediaSourceUrl(parsed.href), download: cloneDownload(download) };
                } catch (error) {
                    return { success: false, sourceUrl: summarizeMediaSourceUrl(parsed.href), error: formatBrowserError(error) };
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
                session.pageAssets.clear();
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
            if (context && isContextConnected(context)) {
                return;
            }
            if (launchInFlight) return launchInFlight;

            const task = (async () => {
            if (context) {
                const staleContext = context;
                context = null;
                resetSessionsAfterContextLoss();
                await staleContext.close().catch(() => {});
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
                ...(hasVirtualDisplay && lastLiveViewState.display
                    ? { env: displayEnv(lastLiveViewState.display) }
                    : {}),
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

            trackContextLifecycle(context);

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
            })();
            launchInFlight = task;
            try {
                await task;
            } finally {
                if (launchInFlight === task) launchInFlight = null;
            }
        },

        async close() {
            if (launchInFlight) await launchInFlight.catch(() => {});
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
            if (!context || !isContextConnected(context)) {
                await this.launch();
            }
            if (!context) {
                throw new Error('Browser not launched');
            }

            const session = createSessionState(sessionOptions.id, sessionOptions.workspaceDir);
            const newPage = takeReusableInitialBlankPage() ?? await openManagedPage();
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
