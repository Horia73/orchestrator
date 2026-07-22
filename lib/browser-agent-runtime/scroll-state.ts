import type {
    BrowserFrameSnapshot,
    BrowserPageMetrics,
    BrowserScrollResult,
    BrowserScrollSnapshot,
} from './browser-types';

const SCROLL_EDGE_TOLERANCE_PX = 2;

export interface BrowserScrollAxisState {
    position: number;
    contentSize: number;
    viewportSize: number;
    maxPosition: number;
    visibleStart: number;
    visibleEnd: number;
    remaining: number;
    progressPercent: number;
    atStart: boolean;
    atEnd: boolean;
}

function finiteNonNegative(value: number): number {
    return Math.max(0, Number.isFinite(value) ? value : 0);
}

export function calculateBrowserScrollAxis(
    position: number,
    contentSize: number,
    viewportSize: number,
): BrowserScrollAxisState {
    const safeContentSize = finiteNonNegative(contentSize);
    const safeViewportSize = finiteNonNegative(viewportSize);
    const maxPosition = Math.max(0, safeContentSize - safeViewportSize);
    const safePosition = Math.min(finiteNonNegative(position), maxPosition);
    const visibleEnd = Math.min(safeContentSize, safePosition + safeViewportSize);
    const atStart = safePosition <= SCROLL_EDGE_TOLERANCE_PX;
    const atEnd = maxPosition - safePosition <= SCROLL_EDGE_TOLERANCE_PX;

    return {
        position: Math.round(safePosition),
        contentSize: Math.round(safeContentSize),
        viewportSize: Math.round(safeViewportSize),
        maxPosition: Math.round(maxPosition),
        visibleStart: Math.round(safePosition),
        visibleEnd: Math.round(visibleEnd),
        remaining: Math.max(0, Math.round(safeContentSize - visibleEnd)),
        progressPercent: maxPosition <= SCROLL_EDGE_TOLERANCE_PX
            ? 100
            : Math.max(0, Math.min(100, Math.round((safePosition / maxPosition) * 100))),
        atStart,
        atEnd,
    };
}

function hasKnownPageMetrics(page: BrowserPageMetrics): page is BrowserPageMetrics & {
    measurement: 'dom';
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
    scrollX: number;
    scrollY: number;
} {
    return page.measurement === 'dom'
        && [page.width, page.height, page.viewportWidth, page.viewportHeight, page.scrollX, page.scrollY]
            .every(value => typeof value === 'number' && Number.isFinite(value));
}

function yesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}

function formatAxis(label: string, axis: BrowserScrollAxisState, remainingLabel: string): string {
    if (axis.maxPosition === 0) {
        return `${label}: fully visible (no scroll range); visible ${axis.visibleStart}-${axis.visibleEnd}px of ${axis.contentSize}px; atStart=yes; atEnd=yes`;
    }

    return `${label}: ${axis.progressPercent}% through scrollable range; position ${axis.position}/${axis.maxPosition}px; visible ${axis.visibleStart}-${axis.visibleEnd}px of ${axis.contentSize}px; ${remainingLabel}=${axis.remaining}px; atStart=${yesNo(axis.atStart)}; atEnd=${yesNo(axis.atEnd)}`;
}

export function formatBrowserFrameScrollMetadata(frame: BrowserFrameSnapshot): string {
    const page = frame.page;
    if (!hasKnownPageMetrics(page)) {
        return [
            'Page DOM metrics: unknown',
            'Document scroll: unknown; do not infer top/bottom or scroll progress from display coordinates or an unavailable value',
        ].join('\n');
    }

    const vertical = calculateBrowserScrollAxis(page.scrollY, page.height, page.viewportHeight);
    const horizontal = calculateBrowserScrollAxis(page.scrollX, page.width, page.viewportWidth);
    const lines = [
        `Page DOM: ${Math.round(page.width)}x${Math.round(page.height)}; webpage viewport: ${Math.round(page.viewportWidth)}x${Math.round(page.viewportHeight)}`,
        formatAxis('Document vertical scroll', vertical, 'below'),
    ];

    if (horizontal.maxPosition > 0 || horizontal.position > 0) {
        lines.push(formatAxis('Document horizontal scroll', horizontal, 'toRight'));
    }

    return lines.join('\n');
}

function axisFromSnapshot(snapshot: BrowserScrollSnapshot, horizontal: boolean): BrowserScrollAxisState {
    return horizontal
        ? calculateBrowserScrollAxis(snapshot.scrollLeft, snapshot.scrollWidth, snapshot.clientWidth)
        : calculateBrowserScrollAxis(snapshot.scrollTop, snapshot.scrollHeight, snapshot.clientHeight);
}

function targetLabel(snapshot: BrowserScrollSnapshot, requestedRef?: string): string {
    if (snapshot.target === 'document') return 'document';
    const ref = requestedRef ? ` via ref=${requestedRef}` : '';
    const name = snapshot.name ? ` "${snapshot.name}"` : '';
    const role = snapshot.role ? ` role=${snapshot.role}` : '';
    return `element <${snapshot.tagName}>${role}${name}${ref}`;
}

export function formatBrowserScrollObservation(
    result: BrowserScrollResult,
    options: {
        direction?: 'up' | 'down' | 'left' | 'right';
        requestedRef?: string;
    } = {},
): string {
    if (!result.available || !result.after) {
        const detail = result.error ? ` Runtime detail: ${result.error}` : '';
        return `Scroll telemetry unavailable; do not infer which surface moved or whether it is at the top/bottom.${detail}`;
    }

    const horizontal = options.direction === 'left' || options.direction === 'right';
    const afterAxis = axisFromSnapshot(result.after, horizontal);
    const beforeAxis = result.before ? axisFromSnapshot(result.before, horizontal) : null;
    const delta = beforeAxis ? afterAxis.position - beforeAxis.position : 0;
    const movement = result.changed
        ? `moved ${delta >= 0 ? '+' : ''}${delta}px`
        : 'did not move (it may already be at this edge, or the input had no effect)';
    const axisLabel = horizontal ? 'Horizontal target scroll' : 'Vertical target scroll';
    const remainingLabel = horizontal ? 'toRight' : 'below';

    return [
        `Scroll target: ${targetLabel(result.after, options.requestedRef)}; input=${result.inputMode}; ${movement}`,
        formatAxis(axisLabel, afterAxis, remainingLabel),
    ].join('\n');
}
