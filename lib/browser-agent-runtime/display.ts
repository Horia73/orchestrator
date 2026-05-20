export type BrowserLiveViewMode = 'disabled' | 'mac-headful' | 'linux-vnc';

export interface BrowserLiveViewState {
    enabled: boolean;
    available: boolean;
    ready: boolean;
    mode: BrowserLiveViewMode;
    platform: NodeJS.Platform;
    display?: string;
    width?: number;
    height?: number;
    vncHost?: string;
    vncPort?: number;
    wsHost?: string;
    wsPort?: number;
    wsToken?: string;
    reason?: string;
}

export interface BrowserDisplayController {
    ensureStarted(): Promise<BrowserLiveViewState>;
    getState(): BrowserLiveViewState;
    close(): Promise<void>;
}

interface BrowserDisplayControllerOptions {
    enabled: boolean;
    viewport: { width: number; height: number };
    onLog?: (message: string) => void;
}

export function createBrowserDisplayController(options: BrowserDisplayControllerOptions): BrowserDisplayController {
    let state: BrowserLiveViewState = {
        enabled: options.enabled,
        available: false,
        ready: false,
        mode: options.enabled
            ? process.platform === 'darwin'
                ? 'mac-headful'
                : process.platform === 'linux'
                    ? 'linux-vnc'
                    : 'disabled'
            : 'disabled',
        platform: process.platform,
        width: options.viewport.width,
        height: options.viewport.height,
        reason: options.enabled ? undefined : 'Live view is disabled.',
    };

    let startPromise: Promise<BrowserLiveViewState> | null = null;
    let linuxDisplay: { close(): Promise<void> } | null = null;

    const log = (message: string) => options.onLog?.(message);

    const startLinuxVnc = async (): Promise<BrowserLiveViewState> => {
        const { startLinuxVncDisplay } = await import('./display-linux');
        const result = await startLinuxVncDisplay({
            viewport: options.viewport,
            previousState: state,
            onLog: log,
        });
        linuxDisplay = result.handle;
        return result.state;
    };

    const controller: BrowserDisplayController = {
        async ensureStarted() {
            if (!options.enabled) return state;
            if (state.ready || state.mode === 'mac-headful') {
                state = {
                    ...state,
                    available: state.mode === 'mac-headful' || state.available,
                    ready: state.mode === 'mac-headful' || state.ready,
                    reason: state.mode === 'mac-headful' ? 'Patchright is running in a local headful browser window.' : state.reason,
                };
                return state;
            }
            if (process.platform !== 'linux') return state;
            if (startPromise) return startPromise;
            startPromise = startLinuxVnc()
                .then(next => {
                    state = next;
                    return state;
                })
                .finally(() => {
                    startPromise = null;
                });
            return startPromise;
        },

        getState() {
            return { ...state };
        },

        async close() {
            await linuxDisplay?.close();
            linuxDisplay = null;
            state = {
                ...state,
                available: state.mode === 'mac-headful',
                ready: state.mode === 'mac-headful',
                reason: state.mode === 'mac-headful' ? state.reason : 'Live view stopped.',
            };
        },
    };

    return controller;
}
