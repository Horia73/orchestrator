/**
 * Canonical browser-agent action surface.
 *
 * Keep the runtime schema, the browser model prompt, and the parent
 * Orchestrator capability hint on this one source of truth. Action-specific
 * prose can stay near the prompt/executor, but action names must not be copied
 * into another hand-maintained list.
 */
export const BROWSER_AGENT_EXECUTION_ACTIONS = [
    'click',
    'type',
    'key',
    'scroll',
    'scrollToBottom',
    'undo',
    'wait',
    'waitFor',
    'navigate',
    'hold',
    'drag',
    'hover',
    'inspectPage',
    'inspectAt',
    'readPage',
    'clickRef',
    'selectOption',
    'setChecked',
    'chooseFile',
    'dropFiles',
    'uploadFile',
    'listPageAssets',
    'downloadMedia',
    'findInPage',
    'inspectDiagnostics',
    'fetchUrl',
    'screenshot',
    'recordVideo',
    'setViewport',
    'closeTab',
    'refresh',
    'getCurrentUrl',
    'getLink',
    'pasteLink',
    'readClipboard',
    'clear',
    'goBack',
    'goForward',
    'listTabs',
    'switchTab',
    'newTab',
    'listDownloads',
    'waitForDownloads',
] as const;

export const BROWSER_AGENT_STANDARD_TERMINAL_ACTIONS = [
    'done',
    'ask',
    'error',
] as const;

export const BROWSER_AGENT_ESCALATION_ACTIONS = [
    'escalate',
    'yield_control',
] as const;

export const BROWSER_AGENT_ACTIONS = [
    ...BROWSER_AGENT_EXECUTION_ACTIONS,
    ...BROWSER_AGENT_STANDARD_TERMINAL_ACTIONS,
    ...BROWSER_AGENT_ESCALATION_ACTIONS,
] as const;

export type BrowserAgentExecutionActionName = typeof BROWSER_AGENT_EXECUTION_ACTIONS[number];
export type BrowserAgentActionName = typeof BROWSER_AGENT_ACTIONS[number];

export const BROWSER_AGENT_CAPABILITY_GROUPS = [
    {
        id: 'interaction',
        label: 'visual interaction and editing',
        actions: ['click', 'clickRef', 'type', 'key', 'clear', 'undo', 'hover', 'hold', 'drag', 'selectOption', 'setChecked'],
    },
    {
        id: 'scroll',
        label: 'document and targeted-container scrolling',
        actions: ['scroll', 'scrollToBottom'],
    },
    {
        id: 'navigation',
        label: 'navigation, history, tabs, URLs, and viewport emulation',
        actions: ['navigate', 'goBack', 'goForward', 'refresh', 'getCurrentUrl', 'getLink', 'pasteLink', 'listTabs', 'switchTab', 'newTab', 'closeTab', 'setViewport'],
    },
    {
        id: 'inspection',
        label: 'visual/DOM inspection, text search, targeted waits, diagnostics, and same-origin reads',
        actions: ['inspectPage', 'inspectAt', 'readPage', 'findInPage', 'wait', 'waitFor', 'inspectDiagnostics', 'fetchUrl'],
    },
    {
        id: 'files',
        label: 'authorized uploads, bounded page assets, managed downloads, and clipboard reads',
        actions: ['chooseFile', 'dropFiles', 'uploadFile', 'listPageAssets', 'downloadMedia', 'listDownloads', 'waitForDownloads', 'readClipboard'],
    },
    {
        id: 'evidence',
        label: 'screenshots and short recordings',
        actions: ['screenshot', 'recordVideo'],
    },
] as const satisfies readonly {
    id: string;
    label: string;
    actions: readonly BrowserAgentExecutionActionName[];
}[];

export function getBrowserAgentPromptActions(options: {
    advancedMode?: boolean;
    escalationEnabled?: boolean;
} = {}): readonly BrowserAgentActionName[] {
    if (options.advancedMode) {
        return [...BROWSER_AGENT_EXECUTION_ACTIONS, 'ask', 'yield_control'];
    }

    return options.escalationEnabled === false
        ? [...BROWSER_AGENT_EXECUTION_ACTIONS, ...BROWSER_AGENT_STANDARD_TERMINAL_ACTIONS]
        : [...BROWSER_AGENT_EXECUTION_ACTIONS, ...BROWSER_AGENT_STANDARD_TERMINAL_ACTIONS, 'escalate'];
}

export function formatBrowserAgentActionUnion(actions: readonly BrowserAgentActionName[]): string {
    return actions.map(action => `"${action}"`).join(' | ');
}

export function formatBrowserAgentCapabilityGroups(): string {
    return BROWSER_AGENT_CAPABILITY_GROUPS
        .map(group => group.label)
        .join('; ');
}
