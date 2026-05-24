import fs from 'fs';
import path from 'path';
import type { ActionTraceFrame, BrowserDownloadFile, BrowserFrameSnapshot } from './browser-types';

export const MAX_AGENT_FRAME_HISTORY = 240;
export const MIN_ACTION_TRACE_FRAMES = 3;
export const MAX_ACTION_TRACE_FRAMES = 10;
export const TARGET_ACTION_TRACE_SPACING_MS = 3000;
export const DEFAULT_DRAG_DURATION_MS = 900;
export const DEFAULT_VIDEO_DURATION_MS = 5000;
export const MIN_VIDEO_DURATION_MS = 1000;
export const MAX_VIDEO_DURATION_MS = 60000;
export const DEFAULT_VIDEO_FPS = 4;

export function toFrameId(sequence: number): string {
    return `frame_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

export function cloneFrame(frame: BrowserFrameSnapshot): BrowserFrameSnapshot {
    return {
        id: frame.id,
        source: frame.source,
        timestamp: frame.timestamp,
        imageBase64: frame.imageBase64,
        url: frame.url,
        captureMode: frame.captureMode,
        coordinateSpace: frame.coordinateSpace,
        viewport: {
            width: frame.viewport.width,
            height: frame.viewport.height,
        },
        page: {
            width: frame.page.width,
            height: frame.page.height,
            scrollX: frame.page.scrollX,
            scrollY: frame.page.scrollY,
        },
    };
}

export function cloneTraceFrame(frame: ActionTraceFrame): ActionTraceFrame {
    return {
        ...cloneFrame(frame),
        label: frame.label,
    };
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clampDurationMs(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(value)));
}

export function sanitizeDownloadFilename(value: string | undefined): string {
    const fallback = `browser-download-${Date.now()}`;
    const base = path.basename(String(value || '').trim()) || fallback;
    const cleaned = base
        .replace(/[\x00-\x1f\x7f]/g, '_')
        .replace(/[\\/:"*?<>|]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^\.+$/, '')
        .slice(0, 180)
        .trim();

    return cleaned || fallback;
}

export function uniqueDownloadPath(downloadsDir: string, filename: string): string {
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext) || 'download';
    let candidate = path.join(/* turbopackIgnore: true */ downloadsDir, filename);
    let counter = 1;

    while (fs.existsSync(/* turbopackIgnore: true */ candidate)) {
        candidate = path.join(/* turbopackIgnore: true */ downloadsDir, `${stem}-${counter}${ext}`);
        counter++;
    }

    return candidate;
}

export function cloneDownload(download: BrowserDownloadFile): BrowserDownloadFile {
    return { ...download };
}

export function compressTraceFrames(frames: ActionTraceFrame[], maxFrames: number = MAX_ACTION_TRACE_FRAMES): ActionTraceFrame[] {
    if (frames.length <= maxFrames) {
        return frames.map((frame) => cloneTraceFrame(frame));
    }

    const selectedIndexes = new Set<number>([0, frames.length - 1]);
    const interiorSlots = Math.max(0, maxFrames - selectedIndexes.size);
    for (let slot = 1; slot <= interiorSlots; slot++) {
        const ratio = slot / (interiorSlots + 1);
        const index = Math.round(ratio * (frames.length - 1));
        selectedIndexes.add(index);
    }

    return [...selectedIndexes]
        .sort((a, b) => a - b)
        .slice(0, maxFrames)
        .map((index) => cloneTraceFrame(frames[index]));
}

export function getActionTraceFrameCount(durationMs: number): number {
    const requestedCount = Math.ceil(durationMs / TARGET_ACTION_TRACE_SPACING_MS);
    return Math.max(MIN_ACTION_TRACE_FRAMES, Math.min(MAX_ACTION_TRACE_FRAMES, requestedCount));
}

export function getTraceCaptureInterval(durationMs: number, frameCount: number = getActionTraceFrameCount(durationMs)): number {
    if (frameCount <= 1) {
        return Math.max(1, Math.round(durationMs));
    }

    return Math.max(1, Math.round(durationMs / (frameCount - 1)));
}

export function getTraceCaptureRatios(frameCount: number = MIN_ACTION_TRACE_FRAMES): number[] {
    if (frameCount <= 1) {
        return [1];
    }

    return Array.from({ length: frameCount }, (_, index) => index / (frameCount - 1));
}
