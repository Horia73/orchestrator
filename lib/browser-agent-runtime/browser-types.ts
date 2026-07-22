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
export type BrowserMouseButton = 'left' | 'middle' | 'right';
export type BrowserKeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface BrowserClickOptions {
    count?: number;
    button?: BrowserMouseButton;
    modifiers?: BrowserKeyModifier[];
}

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
    /** DOM measurement truth. `unavailable` must never be presented as zero. */
    measurement: 'dom' | 'unavailable';
    width: number | null;
    height: number | null;
    /** Visible webpage viewport, which differs from a full display screenshot. */
    viewportWidth: number | null;
    viewportHeight: number | null;
    scrollX: number | null;
    scrollY: number | null;
}

export interface BrowserScrollSnapshot {
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
}

export interface BrowserScrollResult {
    available: boolean;
    inputMode: 'page' | 'display';
    changed: boolean;
    before: BrowserScrollSnapshot | null;
    after: BrowserScrollSnapshot | null;
    error?: string;
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
    tag: string;
    kind?: string;
    href?: string;
    sourceUrl?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    multiple?: boolean;
    accept?: string;
    /** File inputs are exposed only when their visible upload surface is active. */
    uploadReady?: boolean;
    frame?: string;
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

export interface BrowserInspectAtResult extends BrowserClickRefResult {
    supported: boolean;
    surface: 'page' | 'native-browser-ui' | 'none';
    ref?: string;
    element?: BrowserPageElementRef;
    bounds?: { x: number; y: number; width: number; height: number };
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
    paths?: string[];
    filenames?: string[];
    method?: 'chooser' | 'input' | 'drop';
    error?: string;
}

export interface BrowserChooseFileTarget {
    ref?: string;
    coordinate?: [number, number];
}

export type BrowserWaitForKind = 'url' | 'text' | 'ref' | 'load';
export type BrowserWaitForState = 'contains' | 'visible' | 'hidden' | 'enabled' | 'disabled' | 'domcontentloaded' | 'networkidle';

export interface BrowserWaitForOptions {
    kind: BrowserWaitForKind;
    state?: BrowserWaitForState;
    url?: string;
    text?: string;
    ref?: string;
    timeoutMs?: number;
}

export interface BrowserWaitForResult {
    success: boolean;
    elapsedMs: number;
    observation: string;
    stale?: boolean;
    error?: string;
}

export type BrowserPageAssetKind = 'image' | 'video' | 'audio' | 'font' | 'stylesheet' | 'svg' | 'media';

export interface BrowserPageAsset {
    ref: string;
    kind: BrowserPageAssetKind;
    url?: string;
    name: string;
    frame?: string;
    width?: number;
    height?: number;
}

export interface BrowserPageAssetsResult {
    supported: boolean;
    url: string;
    total: number;
    truncated: boolean;
    assets: BrowserPageAsset[];
    error?: string;
}

export interface BrowserDownloadMediaTarget {
    ref?: string;
    assetRef?: string;
    coordinate?: [number, number];
}

export interface BrowserDownloadMediaResult {
    success: boolean;
    download?: BrowserDownloadFile;
    sourceUrl?: string;
    stale?: boolean;
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
    clickCoordinate(x: number, y: number, options?: number | BrowserClickOptions): Promise<boolean>;
    dragCoordinate(startX: number, startY: number, endX: number, endY: number, durationMs?: number): Promise<TracedActionResult>;
    holdCoordinate(x: number, y: number, durationMs?: number): Promise<TracedActionResult>;
    hoverCoordinate(x: number, y: number): Promise<void>;
    type(text: string): Promise<void>;
    paste(text: string): Promise<void>;
    readClipboard(): Promise<string | null>;
    clear(): Promise<void>;
    pressKey(key: string, modifiers?: BrowserKeyModifier[]): Promise<void>;
    findInPage(query: string, next?: boolean): Promise<{ found: boolean; count: number }>;
    scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<BrowserScrollResult>;
    scrollToBottom(): Promise<BrowserScrollResult>;
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
    inspectAt(x: number, y: number): Promise<BrowserInspectAtResult>;
    clickRef(ref: string, options?: number | BrowserClickOptions): Promise<BrowserClickRefResult>;
    hoverRef(ref: string): Promise<BrowserClickRefResult>;
    selectOption(ref: string, values: string[]): Promise<BrowserClickRefResult>;
    setChecked(ref: string, checked: boolean): Promise<BrowserClickRefResult>;
    waitFor(options: BrowserWaitForOptions): Promise<BrowserWaitForResult>;
    chooseFile(filePath: string | string[], target: BrowserChooseFileTarget, timeoutMs?: number): Promise<BrowserUploadFileResult>;
    dropFiles(filePath: string | string[], ref: string): Promise<BrowserUploadFileResult>;
    uploadFile(filePath: string | string[], ref?: string): Promise<BrowserUploadFileResult>;
    listPageAssets(): Promise<BrowserPageAssetsResult>;
    downloadMedia(target: BrowserDownloadMediaTarget): Promise<BrowserDownloadMediaResult>;
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
