import type { BrowserDownloadFile } from './browser';
import type { IterationLimitReview } from './prompts';
import type { AgentAction, VisionCoordinateMode } from './vision';
import { formatBrowserAgentTextForLog } from './redaction';

function reason(action: AgentAction): string {
    return formatBrowserAgentTextForLog(action.reasoning, '', 220);
}

function coordinateLabel(mode: VisionCoordinateMode = 'normalized'): string {
    return mode === 'pixel' ? 'viewport' : 'normalized';
}

function formatCoordinate(coordinate: [number, number] | undefined, mode: VisionCoordinateMode = 'normalized'): string {
    if (!coordinate) return `${coordinateLabel(mode)} [?]`;
    return `${coordinateLabel(mode)} [${coordinate[0]}, ${coordinate[1]}]`;
}

export function formatAction(action: AgentAction, coordinateMode: VisionCoordinateMode = 'normalized'): string {
    switch (action.action) {
        case 'click': {
            const count = action.clickCount && action.clickCount > 1 ? ' (Double Click)' : '';
            return `Click ${formatCoordinate(action.coordinate, coordinateMode)}${count} - ${reason(action)}`;
        }
        case 'hover': {
            return `Hover ${formatCoordinate(action.coordinate, coordinateMode)} - ${reason(action)}`;
        }
        case 'inspectPage':
            return `Inspect Page Context - ${reason(action)}`;
        case 'findInPage':
            return `Find "${formatBrowserAgentTextForLog(action.text, action.reasoning, 40)}" - ${reason(action)}`;
        case 'inspectDiagnostics':
            return `Inspect browser diagnostics - ${reason(action)}`;
        case 'fetchUrl':
            return `Fetch URL ${action.url || '[?]'} - ${reason(action)}`;
        case 'screenshot':
            return `Save screenshot - ${reason(action)}`;
        case 'recordVideo': {
            const duration = action.durationMs ? ` for ${action.durationMs}ms` : '';
            return `Record video${duration} - ${reason(action)}`;
        }
        case 'hold': {
            const duration = action.durationMs ? ` for ${action.durationMs}ms` : '';
            return `Hold ${formatCoordinate(action.coordinate, coordinateMode)}${duration} - ${reason(action)}`;
        }
        case 'drag': {
            const start = formatCoordinate(action.coordinate, coordinateMode);
            const end = formatCoordinate(action.coordinateEnd, coordinateMode);
            const duration = action.durationMs ? ` over ${action.durationMs}ms` : '';
            return `Drag from ${start} to ${end}${duration} - ${reason(action)}`;
        }
        case 'type': {
            const coords = action.coordinate ? ` at ${formatCoordinate(action.coordinate, coordinateMode)}` : '';
            const clear = action.clearBefore ? ' (Clear First)' : '';
            const enter = action.submit ? ' + Enter' : '';
            return `Type "${formatBrowserAgentTextForLog(action.text, action.reasoning, 20)}"${coords}${clear}${enter} - ${reason(action)}`;
        }
        case 'clear': {
            const coords = action.coordinate ? ` at ${formatCoordinate(action.coordinate, coordinateMode)}` : '';
            return `Clear Input${coords} - ${reason(action)}`;
        }
        case 'key':
            return `Press ${action.key} - ${reason(action)}`;
        case 'scroll': {
            const amount = action.scrollAmount ? ` by ${action.scrollAmount}px` : '';
            return `Scroll ${action.scrollDirection}${amount} - ${reason(action)}`;
        }
        case 'scrollToBottom':
            return `Scroll to Bottom - ${reason(action)}`;
        case 'undo':
            return `Undo - ${reason(action)}`;
        case 'wait': {
            const duration = action.durationMs ? ` for ${action.durationMs}ms` : '';
            return `Wait${duration} - ${reason(action)}`;
        }
        case 'navigate':
            return `Navigate to ${action.url} - ${reason(action)}`;
        case 'done':
            return `Done - ${reason(action)}`;
        case 'ask':
            return `Ask User - ${reason(action)}`;
        case 'escalate':
            return `🚨 Escalate to Advanced AI - ${reason(action)}`;
        case 'yield_control':
            return `🔙 Yield Control to Base AI - ${reason(action)}`;
        case 'goBack':
            return `Go Back - ${reason(action)}`;
        case 'goForward':
            return `Go Forward - ${reason(action)}`;
        case 'listTabs':
            return `List Tabs - ${reason(action)}`;
        case 'switchTab':
            return `Switch to Tab ${action.tabIndex ?? '?'} - ${reason(action)}`;
        case 'newTab':
            return `New Tab${action.url ? ` (${action.url})` : ''} - ${reason(action)}`;
        case 'listDownloads':
            return `List Downloads - ${reason(action)}`;
        case 'waitForDownloads': {
            const duration = action.durationMs ? ` up to ${action.durationMs}ms` : '';
            const expected = action.expectedFilename ? ` expecting "${action.expectedFilename}"` : '';
            return `Wait for Downloads${duration}${expected} - ${reason(action)}`;
        }
        case 'readClipboard':
            return `Read Clipboard - ${reason(action)}`;
        default:
            return `${action.action} - ${reason(action)}`;
    }
}

export function formatIterationLimitReview(review: IterationLimitReview, iterationCount: number, maxIterations: number): string {
    const lines = [
        `🧠 Iteration limit review (${iterationCount}/${maxIterations})`,
        `Why it did not finish: ${review.whyNotFinished || 'No clear reason provided.'}`,
        `Where it got stuck: ${review.stuckPoint || 'No specific stuck point identified.'}`,
        `Why it could not self-recover: ${review.whySelfRecoveryFailed || 'No self-recovery analysis provided.'}`,
        `Human assessment: ${review.humanAssessment || 'No human comparison provided.'}`,
    ];

    if (review.missingToolsOrCapabilities.length > 0) {
        lines.push(`Missing tools/capabilities: ${review.missingToolsOrCapabilities.join('; ')}`);
    }
    if (review.hardParts.length > 0) {
        lines.push(`Hard parts: ${review.hardParts.join('; ')}`);
    }
    if (review.easyParts.length > 0) {
        lines.push(`Easy parts: ${review.easyParts.join('; ')}`);
    }
    if (review.futureStrategy.length > 0) {
        lines.push(`Suggested next steps: ${review.futureStrategy.join(' | ')}`);
    }
    if (review.questionsForUser.length > 0) {
        lines.push(`Questions for you: ${review.questionsForUser.join(' | ')}`);
    }

    return lines.join('\n');
}

const DEFAULT_DOWNLOAD_WAIT_MS = 15_000;
const MIN_DOWNLOAD_WAIT_MS = 1_000;
const MAX_DOWNLOAD_WAIT_MS = 30_000;

export function clampDownloadWaitMs(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_DOWNLOAD_WAIT_MS;
    }
    return Math.max(MIN_DOWNLOAD_WAIT_MS, Math.min(MAX_DOWNLOAD_WAIT_MS, Math.round(value)));
}

function formatDownloadBytes(size: number | undefined): string {
    if (typeof size !== 'number' || !Number.isFinite(size)) return 'unknown size';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function summarizeDownload(download: BrowserDownloadFile): string {
    const details = download.state === 'saved'
        ? `${formatDownloadBytes(download.size)} at ${download.savedPath || 'unknown path'}`
        : download.error || 'not saved yet';
    return `${download.state}: ${download.suggestedFilename} (${details})`;
}

export function summarizeDownloads(downloads: BrowserDownloadFile[]): string {
    if (downloads.length === 0) return 'No browser downloads recorded in this session.';
    return downloads.slice(-8).map(summarizeDownload).join('\n');
}

export function changedDownloads(before: BrowserDownloadFile[], after: BrowserDownloadFile[]): BrowserDownloadFile[] {
    const beforeById = new Map(before.map(download => [download.id, download]));
    return after.filter(download => {
        const previous = beforeById.get(download.id);
        if (!previous) return true;
        return previous.state !== download.state
            || previous.savedPath !== download.savedPath
            || previous.size !== download.size
            || previous.error !== download.error;
    });
}

export function filenameMatches(download: BrowserDownloadFile, expectedFilename: string | undefined): boolean {
    const expected = String(expectedFilename || '').trim().toLowerCase();
    if (!expected) return true;
    return download.suggestedFilename.toLowerCase().includes(expected);
}

export function summarizeDownloadWait(
    before: BrowserDownloadFile[],
    after: BrowserDownloadFile[],
    relevant: BrowserDownloadFile[],
    expectedFilename: string | undefined,
): string {
    const expected = String(expectedFilename || '').trim();
    const header = expected
        ? `Expected filename containing "${expected}".`
        : 'No expected filename substring was provided.';

    if (relevant.length === 0) {
        return `${header} No new or newly completed browser download was observed. Current downloads:\n${summarizeDownloads(after)}`;
    }

    const beforePending = new Set(before.filter(download => download.state === 'pending').map(download => download.id));
    const relevantLines = relevant.map(download => {
        const origin = beforePending.has(download.id) ? 'completed pending download' : 'new download';
        const match = filenameMatches(download, expectedFilename) ? 'filename matched' : 'filename did not match';
        return `${origin}: ${summarizeDownload(download)}; ${match}`;
    });

    return `${header}\n${relevantLines.join('\n')}`;
}
