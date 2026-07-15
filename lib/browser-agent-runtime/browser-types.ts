import type { Page, BrowserContext } from 'patchright';
import type { BrowserBackend } from './config';
import type { BrowserLiveViewState } from './display';
import type { ViewportPreset } from './viewport';

export interface BrowserManagerOptions {
    backend?: BrowserBackend;
    userDataDir?: string;
    downloadsDir?: string;
    /** Root of files the browser agent may attach to web forms. */
    workspaceDir?: string;
    headless?: boolean;
    liveView?: boolean;
    viewport?: { width: number; height: number } | null;
    launchArgs?: string[];
    onLog?: (message: string) => void;
}

export type BrowserFrameSource = 'agent' | 'live';
export type BrowserCaptureMode = 'viewport' | 'overview';
export type BrowserCoordinateSpace = 'normalized-viewport' | 'normalized-display';
export type BrowserPointerActionKind = 'move' | 'click' | 'drag' | 'hold' | 'scroll';

/**
 * Last agent-driven pointer action in display pixels — the live view renders
 * its cursor overlay from this, so it only reports in display-automation mode
 * (the same mode the VNC live view uses).
 */
export interface BrowserPointerState {
    x: number;
    y: number;
    kind: BrowserPointerActionKind;
    at: number;
}

export interface BrowserPageSessionCapabilities {
    backend: BrowserBackend;
    coordinateSpace: BrowserCoordinateSpace;
    domInspection: boolean;
    overviewCapture: boolean;
    tabEnumeration: boolean;
    downloadEvents: boolean;
    displayCapture: boolean;
    osClipboard: boolean;
    diagnostics: boolean;
    browserFetch: boolean;
}

export interface BrowserPageMetrics {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
}

export interface BrowserFrameSnapshot {
    id: string;
    source: BrowserFrameSource;
    timestamp: string;
    imageBase64: string;
    url: string;
    captureMode: BrowserCaptureMode;
    coordinateSpace?: BrowserCoordinateSpace;
    viewport: { width: number; height: number };
    page: BrowserPageMetrics;
}

export interface BrowserVideoRecording {
    id: string;
    timestamp: string;
    mimeType: string;
    videoBase64: string;
    url: string;
    durationMs: number;
    fps: number;
    frameCount: number;
    viewport: { width: number; height: number };
    page: BrowserPageMetrics;
}

export interface BrowserDownloadFile {
    id: string;
    timestamp: string;
    url: string;
    suggestedFilename: string;
    savedPath?: string;
    state: 'pending' | 'saved' | 'failed';
    size?: number;
    error?: string;
}

export interface BrowserDownloadWaitOptions {
    waitForNew?: boolean;
    baselineCount?: number;
}

export interface BrowserPageSettleOptions {
    timeoutMs?: number;
    stableMs?: number;
    pollMs?: number;
}

export interface BrowserPageSettleResult {
    settled: boolean;
    elapsedMs: number;
    reason: 'stable' | 'timeout' | 'unsupported' | 'error';
}

export interface BrowserConsoleEntry {
    timestamp: string;
    level: string;
    text: string;
    url: string;
    lineNumber?: number;
    columnNumber?: number;
}

export interface BrowserPageErrorEntry {
    timestamp: string;
    message: string;
    stack?: string;
    url: string;
}

export interface BrowserNetworkEntry {
    timestamp: string;
    url: string;
    method: string;
    resourceType: string;
    status?: number;
    statusText?: string;
    failureText?: string;
}

export interface BrowserDiagnosticsSnapshot {
    supported: boolean;
    capturedAt: string;
    currentUrl: string;
    consoleMessages: BrowserConsoleEntry[];
    pageErrors: BrowserPageErrorEntry[];
    failedRequests: BrowserNetworkEntry[];
    httpErrors: BrowserNetworkEntry[];
}

export interface BrowserPageElementRef {
    ref: string;
    role: string;
    name: string;
    href?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    inViewport: boolean;
}

export interface BrowserReadPageResult {
    supported: boolean;
    url: string;
    capturedAt: string;
    total: number;
    truncated: boolean;
    elements: BrowserPageElementRef[];
    error?: string;
}

export interface BrowserClickRefResult {
    success: boolean;
    /** True when the refs no longer match the live DOM and readPage must run again. */
    stale?: boolean;
    label?: string;
    error?: string;
}

export interface BrowserUploadFileResult {
    success: boolean;
    /** True when a requested readPage ref no longer belongs to the active page. */
    stale?: boolean;
    ref?: string;
    label?: string;
    /** Workspace-relative path; absolute runtime/profile paths are never exposed. */
    path?: string;
    filename?: string;
    error?: string;
}

export interface BrowserSetViewportResult {
    supported: boolean;
    preset?: ViewportPreset;
    width?: number;
    height?: number;
    colorScheme?: 'dark' | 'light' | 'auto';
    error?: string;
}

export interface BrowserFetchResult {
    supported: boolean;
    requestedUrl: string;
    finalUrl: string;
    ok: boolean;
    status: number;
    statusText: string;
    contentType: string;
    redirected: boolean;
    bodyLength: number;
    bodySnippet: string;
    error?: string;
}

export type BrowserCurrentUrlSource = 'address-bar' | 'navigation-history' | 'page-url';

export interface BrowserCurrentUrlResult {
    url: string;
    source: BrowserCurrentUrlSource;
}

export type BrowserTabOrigin = 'initial' | 'newTab' | 'popup' | 'recovered';

export interface BrowserTabInfo {
    index: number;
    title: string;
    url: string;
    isActive: boolean;
    sessionId: string;
    openedAt: string;
    origin: BrowserTabOrigin;
    openerTabIndex?: number;
    openerUrl?: string;
}

export interface ActionTraceFrame extends BrowserFrameSnapshot {
    label: string;
}

export interface ActionTrace {
    action: 'hold' | 'drag';
    intervalMs: number;
    frames: ActionTraceFrame[];
}

export interface TracedActionResult {
    success: boolean;
    trace: ActionTrace | null;
}

export interface BrowserPageSession {
    readonly id: string;
    readonly createdAt: string;
    readonly capabilities: BrowserPageSessionCapabilities;
    screenshot(source?: BrowserFrameSource): Promise<string>;
    captureAgentFrame(): Promise<BrowserFrameSnapshot>;
    captureLiveFrame(): Promise<BrowserFrameSnapshot>;
    captureOverviewFrame(): Promise<BrowserFrameSnapshot>;
    recordVideo(durationMs?: number): Promise<BrowserVideoRecording>;
    clickCoordinate(x: number, y: number, count?: number): Promise<boolean>;
    dragCoordinate(startX: number, startY: number, endX: number, endY: number, durationMs?: number): Promise<TracedActionResult>;
    holdCoordinate(x: number, y: number, durationMs?: number): Promise<TracedActionResult>;
    hoverCoordinate(x: number, y: number): Promise<void>;
    type(text: string): Promise<void>;
    paste(text: string): Promise<void>;
    readClipboard(): Promise<string | null>;
    clear(): Promise<void>;
    pressKey(key: string): Promise<void>;
    findInPage(query: string, next?: boolean): Promise<{ found: boolean; count: number }>;
    scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>;
    scrollToBottom(): Promise<void>;
    undo(): Promise<void>;
    navigate(url: string): Promise<void>;
    goBack(): Promise<void>;
    goForward(): Promise<void>;
    reloadPage(): Promise<void>;
    closeTab(index?: number): Promise<boolean>;
    listTabs(): Promise<BrowserTabInfo[]>;
    switchTab(index: number): Promise<boolean>;
    newTab(url?: string): Promise<boolean>;
    getHrefAt(x: number, y: number): Promise<string | null>;
    getCurrentUrl(): Promise<BrowserCurrentUrlResult>;
    getPage(): Page | null;
    getPageUrl(): string;
    getOpenTabCount(): Promise<number>;
    getViewport(): Promise<{ width: number; height: number }>;
    getDownloads(): BrowserDownloadFile[];
    waitForDownloads(timeoutMs?: number, options?: BrowserDownloadWaitOptions): Promise<BrowserDownloadFile[]>;
    waitForPageSettled(options?: BrowserPageSettleOptions): Promise<BrowserPageSettleResult>;
    getDiagnostics(): BrowserDiagnosticsSnapshot;
    getPointerState(): BrowserPointerState | null;
    readPage(): Promise<BrowserReadPageResult>;
    clickRef(ref: string, count?: number): Promise<BrowserClickRefResult>;
    uploadFile(filePath: string, ref?: string): Promise<BrowserUploadFileResult>;
    setViewport(preset: ViewportPreset, colorScheme?: 'dark' | 'light' | 'auto'): Promise<BrowserSetViewportResult>;
    fetchUrl(url: string): Promise<BrowserFetchResult>;
    getLatestAgentFrame(): BrowserFrameSnapshot | null;
    getAgentFrameHistory(limit?: number): BrowserFrameSnapshot[];
    clearAgentFrameHistory(): void;
    closeOwnedPages(): Promise<void>;
}

export interface BrowserPageSessionOptions {
    id?: string;
    startupUrl?: string;
    /** Profile workspace root used to sandbox uploadFile for this session. */
    workspaceDir?: string;
}

export interface BrowserManager extends BrowserPageSession {
    launch(): Promise<void>;
    close(): Promise<void>;
    createSession(options?: BrowserPageSessionOptions): Promise<BrowserPageSession>;
    getSession(id: string): BrowserPageSession | null;
    closeSession(id: string): Promise<boolean>;
    listAllTabs(): Promise<BrowserTabInfo[]>;
    getContext(): BrowserContext | null;
    getLiveViewState(): BrowserLiveViewState;
}
