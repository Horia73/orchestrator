import type { BrowserDownloadFile } from './browser';
import type { IterationLimitReview } from './prompts';
import type { AgentAction } from './vision';

export function formatAction(action: AgentAction): string {
    switch (action.action) {
        case 'click': {
            const coords = action.coordinate ? `[${action.coordinate[0]}, ${action.coordinate[1]}]` : '[?]';
            const count = action.clickCount && action.clickCount > 1 ? ' (Double Click)' : '';
            return `Click ${coords}${count} - ${action.reasoning}`;
        }
        case 'hover': {
            const coords = action.coordinate ? `[${action.coordinate[0]}, ${action.coordinate[1]}]` : '[?]';
            return `Hover ${coords} - ${action.reasoning}`;
        }
        case 'inspectPage':
            return `Inspect Full Page - ${action.reasoning}`;
        case 'findInPage':
            return `Find "${action.text?.substring(0, 40) || ''}" - ${action.reasoning}`;
        case 'screenshot':
            return `Save screenshot - ${action.reasoning}`;
        case 'recordVideo': {
            const duration = action.durationMs ? ` for ${action.durationMs}ms` : '';
            return `Record video${duration} - ${action.reasoning}`;
        }
        case 'hold': {
            const coords = action.coordinate ? `[${action.coordinate[0]}, ${action.coordinate[1]}]` : '[?]';
            const duration = action.durationMs ? ` for ${action.durationMs}ms` : '';
            return `Hold ${coords}${duration} - ${action.reasoning}`;
        }
        case 'drag': {
            const start = action.coordinate ? `[${action.coordinate[0]}, ${action.coordinate[1]}]` : '[?]';
            const end = action.coordinateEnd ? `[${action.coordinateEnd[0]}, ${action.coordinateEnd[1]}]` : '[?]';
            const duration = action.durationMs ? ` over ${action.durationMs}ms` : '';
            return `Drag from ${start} to ${end}${duration} - ${action.reasoning}`;
        }
        case 'type': {
            const coords = action.coordinate ? ` at [${action.coordinate[0]}, ${action.coordinate[1]}]` : '';
            const clear = action.clearBefore ? ' (Clear First)' : '';
            const enter = action.submit ? ' + Enter' : '';
            return `Type "${action.text?.substring(0, 20)}..."${coords}${clear}${enter} - ${action.reasoning}`;
        }
        case 'clear': {
            const coords = action.coordinate ? ` at [${action.coordinate[0]}, ${action.coordinate[1]}]` : '';
            return `Clear Input${coords} - ${action.reasoning}`;
        }
        case 'key':
            return `Press ${action.key} - ${action.reasoning}`;
        case 'scroll': {
            const amount = action.scrollAmount ? ` by ${action.scrollAmount}px` : '';
            return `Scroll ${action.scrollDirection}${amount} - ${action.reasoning}`;
        }
        case 'wait': {
            const duration = action.durationMs ? ` for ${action.durationMs}ms` : '';
            return `Wait${duration} - ${action.reasoning}`;
        }
        case 'navigate':
            return `Navigate to ${action.url} - ${action.reasoning}`;
        case 'done':
            return `Done - ${action.reasoning}`;
        case 'ask':
            return `Ask User - ${action.reasoning}`;
        case 'escalate':
            return `🚨 Escalate to Advanced AI - ${action.reasoning}`;
        case 'yield_control':
            return `🔙 Yield Control to Base AI - ${action.reasoning}`;
        case 'goBack':
            return `Go Back - ${action.reasoning}`;
        case 'goForward':
            return `Go Forward - ${action.reasoning}`;
        case 'listTabs':
            return `List Tabs - ${action.reasoning}`;
        case 'switchTab':
            return `Switch to Tab ${action.tabIndex ?? '?'} - ${action.reasoning}`;
        case 'newTab':
            return `New Tab${action.url ? ` (${action.url})` : ''} - ${action.reasoning}`;
        case 'listDownloads':
            return `List Downloads - ${action.reasoning}`;
        case 'waitForDownloads': {
            const duration = action.durationMs ? ` up to ${action.durationMs}ms` : '';
            const expected = action.expectedFilename ? ` expecting "${action.expectedFilename}"` : '';
            return `Wait for Downloads${duration}${expected} - ${action.reasoning}`;
        }
        case 'readClipboard':
            return `Read Clipboard - ${action.reasoning}`;
        default:
            return `${action.action} - ${action.reasoning}`;
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
