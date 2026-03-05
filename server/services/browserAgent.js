import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executionContext, getExecutionContext } from '../core/context.js';
import { broadcastEvent, updateStreamingSnapshot } from '../core/events.js';
import {
    BROWSER_PERSISTENT_PROFILE_DIR,
    BROWSER_RECORDINGS_DIR,
    BROWSER_SESSION_DATA_DIR,
} from '../core/dataPaths.js';
import {
    buildRemoteDesktopState,
    createLinuxRemoteDesktop,
    getRemoteDesktopUpgradeTarget,
    proxyRemoteDesktopUpgrade,
    supportsLinuxRemoteDesktop,
} from './browserRemoteDesktop.js';
import { getAgentConfig } from '../storage/settings.js';
import { DEFAULT_AGENT_CONFIG } from '../vendor/browser-agent/config.js';
import { createAgentRuntime } from '../vendor/browser-agent/runtime.js';

export const BROWSER_AGENT_ID = 'browser';
const WAIT_POLL_MS = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_QUESTION_TYPE = 'info';
const ARCHIVED_SESSION_RETENTION_MS = 30 * 60_000;
const MAX_RECORDED_AGENT_FRAMES = 120;
const RECORDING_SAMPLE_INTERVAL_MS = 1000;
const RECORDING_METADATA_FILE = 'metadata.json';
const RECORDING_OUTPUT_FILE = 'agent-recording.mp4';
const FFMPEG_BINARY = process.env.FFMPEG_PATH || 'ffmpeg';

const execFileAsync = promisify(execFile);

const browserSessions = new Map();
const isolatedSessionIdsByOwner = new Map();
const archivedBrowserSessions = new Map();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneConfig(value) {
    return JSON.parse(JSON.stringify(value));
}

function sanitizeText(value) {
    return String(value ?? '').trim();
}

function sanitizePathSegment(value, fallback = 'unknown') {
    const normalized = sanitizeText(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
    return normalized || fallback;
}

function getRecordingRootForSession(sessionId) {
    return path.join(BROWSER_RECORDINGS_DIR, sanitizePathSegment(sessionId, 'browser-session'));
}

function getRecordingMetadataPath(sessionId) {
    return path.join(getRecordingRootForSession(sessionId), RECORDING_METADATA_FILE);
}

function buildRecordingVideoFileUri({ sessionId, chatId, index = 0, download = false }) {
    const query = new URLSearchParams();
    query.set('chatId', sanitizeText(chatId));
    if (Number.isFinite(Number(index)) && Number(index) > 0) {
        query.set('index', String(Math.trunc(Number(index))));
    }
    if (download) {
        query.set('download', '1');
    }
    return `/api/browser-agent/sessions/${encodeURIComponent(sanitizeText(sessionId))}/recording/video?${query.toString()}`;
}

function sanitizeThinkingLevel(value, fallback = 'minimal') {
    const normalized = sanitizeText(value).toLowerCase();
    if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }

    return fallback;
}

function buildOwnerKey({ chatId, agentId }) {
    return `${sanitizeText(agentId)}:${sanitizeText(chatId)}`;
}

function isLiveSession(session) {
    return Boolean(session) && session.closed !== true;
}

function getSessionIdleTimeoutMs() {
    return undefined;
}

function clearSessionCloseTimer(session) {
    if (!session) {
        return;
    }

    if (session.closeTimer) {
        clearTimeout(session.closeTimer);
        session.closeTimer = null;
    }
    session.expiresAt = 0;
}

function syncSessionCloseState(session) {
    clearSessionCloseTimer(session);
    return false;
}

function getPersistentLiveSession() {
    for (const session of browserSessions.values()) {
        if (session.profileMode === 'persistent' && session.closed !== true) {
            return session;
        }
    }

    return null;
}

function createStatusEntry(message) {
    return {
        id: `browser-log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        message,
    };
}

function appendSessionLog(session, message) {
    session.updatedAt = Date.now();
    session.lastStatusMessage = message;
    session.logEntries.push(createStatusEntry(message));
}

function normalizeQuestionType(value) {
    const normalized = sanitizeText(value).toLowerCase();
    if (normalized === 'confirmation' || normalized === 'captcha' || normalized === 'info') {
        return normalized;
    }
    return DEFAULT_QUESTION_TYPE;
}

function parseUserQuestion(rawQuestion) {
    const message = sanitizeText(rawQuestion);
    if (!message) {
        return {
            type: DEFAULT_QUESTION_TYPE,
            question: '',
        };
    }

    const match = message.match(/^\[(confirmation|captcha|info)\]\s*/i);
    if (!match) {
        return {
            type: DEFAULT_QUESTION_TYPE,
            question: message,
        };
    }

    return {
        type: normalizeQuestionType(match[1]),
        question: sanitizeText(message.slice(match[0].length)),
    };
}

function buildUserActionState(session) {
    const needsUser = session.status === 'awaiting_user' || session.controlMode === 'user';
    if (!needsUser) {
        return null;
    }

    const type = normalizeQuestionType(session.questionType || DEFAULT_QUESTION_TYPE);
    const directToUser = type === 'captcha' || session.controlMode === 'user';
    return {
        required: true,
        type,
        route: directToUser ? 'panel' : 'orchestrator',
        question: session.question || '',
        controlMode: session.controlMode,
        directToUser,
        canTakeControl: directToUser,
        canContinue: directToUser,
        needsText: false,
    };
}

function cloneRecordingFrame(frame, index = 0) {
    if (!frame || typeof frame !== 'object') {
        return null;
    }

    const imageBase64 = sanitizeText(frame.imageBase64);
    if (!imageBase64) {
        return null;
    }

    return {
        id: sanitizeText(frame.id) || `browser-recording-frame-${index + 1}`,
        timestamp: sanitizeText(frame.timestamp) || new Date().toISOString(),
        url: sanitizeText(frame.url),
        imageBase64,
        viewport: frame.viewport && typeof frame.viewport === 'object'
            ? {
                width: Number(frame.viewport.width) || 0,
                height: Number(frame.viewport.height) || 0,
            }
            : null,
    };
}

function normalizeRecordingVideoFile(file, index = 0) {
    if (!file || typeof file !== 'object') {
        return null;
    }

    const localPath = sanitizeText(file.localPath ?? file.path);
    if (!localPath) {
        return null;
    }

    const fileName = sanitizeText(file.fileName) || path.basename(localPath);
    const mimeType = sanitizeText(file.mimeType).toLowerCase() || 'video/mp4';
    return {
        id: sanitizeText(file.id) || `browser-recording-video-${index + 1}`,
        localPath,
        fileName,
        mimeType,
        sizeBytes: Number(file.sizeBytes) || 0,
        pageUrl: sanitizeText(file.pageUrl),
        recordedAt: sanitizeText(file.recordedAt) || new Date().toISOString(),
    };
}

function normalizeRecordingVideoFiles(files) {
    if (!Array.isArray(files)) {
        return [];
    }

    return files
        .map((file, index) => normalizeRecordingVideoFile(file, index))
        .filter(Boolean);
}

function buildRecordingVideoDescriptor(videoFile, sessionLike, index = 0) {
    const normalized = normalizeRecordingVideoFile(videoFile, index);
    if (!normalized) {
        return null;
    }

    const sessionId = sanitizeText(sessionLike?.sessionId);
    const chatId = sanitizeText(sessionLike?.chatId);
    return {
        ...normalized,
        fileUri: buildRecordingVideoFileUri({ sessionId, chatId, index }),
        downloadUri: buildRecordingVideoFileUri({ sessionId, chatId, index, download: true }),
    };
}

function normalizeRecordingFrames(frames, limit = MAX_RECORDED_AGENT_FRAMES) {
    if (!Array.isArray(frames)) {
        return [];
    }

    const safeLimit = Number.isFinite(limit) && limit > 0
        ? Math.min(Math.trunc(limit), MAX_RECORDED_AGENT_FRAMES)
        : MAX_RECORDED_AGENT_FRAMES;

    return frames
        .slice(-safeLimit)
        .map((frame, index) => cloneRecordingFrame(frame, index))
        .filter(Boolean);
}

function buildRecordingState(session, recordingFrames = null, recordingVideoFiles = null) {
    const normalizedFrames = Array.isArray(recordingFrames)
        ? recordingFrames
        : (Array.isArray(session?.recordingFrames) ? session.recordingFrames : []);
    const normalizedVideos = Array.isArray(recordingVideoFiles)
        ? normalizeRecordingVideoFiles(recordingVideoFiles)
        : normalizeRecordingVideoFiles(session?.recordingVideoFiles);
    const videos = normalizedVideos
        .map((videoFile, index) => buildRecordingVideoDescriptor(videoFile, session, index))
        .filter(Boolean);

    return {
        available: videos.length > 0 || normalizedFrames.length > 0,
        mode: videos.length > 0 ? 'video' : (normalizedFrames.length > 0 ? 'frames' : 'none'),
        frameCount: normalizedFrames.length,
        videoCount: videos.length,
        capturesAgentOnly: true,
        includesManualControl: false,
        video: videos[0] || undefined,
        videos,
    };
}

function closeActiveRecordingSegment(session, endedAt = Date.now()) {
    const startedAt = Number(session?.recordingSegmentStartedAt) || 0;
    if (startedAt <= 0) {
        return;
    }

    session.recordingSegmentStartedAt = 0;
    if (!Number.isFinite(endedAt) || endedAt <= startedAt) {
        return;
    }

    session.recordingSegments.push({
        startedAt,
        endedAt,
    });
}

function syncSessionRecordingSegments(session) {
    if (!session) {
        return;
    }

    if (isAgentActivelyRunning(session)) {
        if (!(Number(session.recordingSegmentStartedAt) > 0)) {
            session.recordingSegmentStartedAt = Date.now();
        }
        return;
    }

    closeActiveRecordingSegment(session);
}

function serializeRecordingSegments(session) {
    return (Array.isArray(session?.recordingSegments) ? session.recordingSegments : [])
        .map((segment) => {
            const startedAt = Number(segment?.startedAt) || 0;
            const endedAt = Number(segment?.endedAt) || 0;
            if (startedAt <= 0 || endedAt <= startedAt) {
                return null;
            }
            return {
                startedAt,
                endedAt,
            };
        })
        .filter(Boolean);
}

function buildFfmpegFilterForSegments(segments, recordingOriginAtMs) {
    const preparedSegments = segments
        .map((segment) => {
            const start = Math.max(0, (segment.startedAt - recordingOriginAtMs) / 1000);
            const end = Math.max(start + 0.05, (segment.endedAt - recordingOriginAtMs) / 1000);
            return { start, end };
        })
        .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);

    if (preparedSegments.length === 0) {
        return '';
    }

    const graph = [];
    const inputs = [];
    preparedSegments.forEach((segment, index) => {
        graph.push(
            `[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`,
        );
        inputs.push(`[v${index}]`);
    });
    graph.push(`${inputs.join('')}concat=n=${preparedSegments.length}:v=1:a=0,fps=30[outv]`);
    return graph.join(';');
}

async function finalizeRecordedVideoFiles(session, sourceVideoFiles) {
    const normalizedSourceVideos = normalizeRecordingVideoFiles(sourceVideoFiles);
    if (normalizedSourceVideos.length === 0) {
        return [];
    }

    const recordingRoot = sanitizeText(session?.recordingRoot);
    const recordingOriginAt = Number(session?.recordingOriginAt) || 0;
    const segments = serializeRecordingSegments(session);
    const primarySource = normalizedSourceVideos[0];
    const fallbackVideoFile = {
        id: primarySource.id,
        localPath: primarySource.localPath,
        fileName: primarySource.fileName,
        mimeType: primarySource.mimeType,
        sizeBytes: primarySource.sizeBytes,
        pageUrl: primarySource.pageUrl,
        recordedAt: primarySource.recordedAt,
    };

    if (!recordingRoot || recordingOriginAt <= 0 || segments.length === 0) {
        return [fallbackVideoFile];
    }

    const outputPath = path.join(recordingRoot, RECORDING_OUTPUT_FILE);
    const filterComplex = buildFfmpegFilterForSegments(segments, recordingOriginAt);
    if (!filterComplex) {
        return [fallbackVideoFile];
    }

    try {
        await execFileAsync(FFMPEG_BINARY, [
            '-y',
            '-i',
            primarySource.localPath,
            '-filter_complex',
            filterComplex,
            '-map',
            '[outv]',
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            outputPath,
        ], {
            maxBuffer: 10 * 1024 * 1024,
        });

        const stats = await fs.stat(outputPath);
        return [{
            id: `browser-recording-final-${sanitizePathSegment(session?.sessionId, 'session')}`,
            localPath: outputPath,
            fileName: path.basename(outputPath),
            mimeType: 'video/mp4',
            sizeBytes: Number(stats.size) || 0,
            pageUrl: primarySource.pageUrl,
            recordedAt: new Date(stats.mtimeMs).toISOString(),
        }];
    } catch {
        return [fallbackVideoFile];
    }
}

function isAgentActivelyRunning(session) {
    return Boolean(
        isLiveSession(session)
        && session.controlMode !== 'user'
        && session.status === 'running'
        && session.runtimeStatus?.running === true
    );
}

function shouldKeepSessionOpen(session) {
    return Boolean(
        isLiveSession(session)
        && (
            session.controlMode === 'user'
            || session.status === 'awaiting_user'
            || session.runtimeStatus?.running === true
        )
    );
}

function shouldCloseSessionImmediately(session) {
    if (session?.profileMode === 'persistent') {
        return false;
    }

    return Boolean(
        isLiveSession(session)
        && !shouldKeepSessionOpen(session)
        && (
            session.status === 'completed'
            || session.status === 'error'
            || session.status === 'stopped'
        )
    );
}

async function ensureSessionRecording(session, { reset = false } = {}) {
    if (!isLiveSession(session)) {
        return;
    }

    if (reset) {
        session.recordingFrames = [];
        session.lastRecordedFrameAt = 0;
        session.recordingSegments = [];
        session.recordingSegmentStartedAt = 0;
    }

    if (session.recordingUnsubscribe) {
        syncSessionRecordingSegments(session);
        return;
    }

    session.recordingUnsubscribe = await session.runtime.subscribeLiveFrames((frame) => {
        if (!isAgentActivelyRunning(session)) {
            return;
        }

        const now = Date.now();
        if (
            Number.isFinite(session.lastRecordedFrameAt)
            && session.lastRecordedFrameAt > 0
            && (now - session.lastRecordedFrameAt) < RECORDING_SAMPLE_INTERVAL_MS
        ) {
            return;
        }

        const clonedFrame = cloneRecordingFrame(frame, session.recordingFrames.length);
        if (!clonedFrame) {
            return;
        }

        session.lastRecordedFrameAt = now;
        session.recordingFrames.push(clonedFrame);
        if (session.recordingFrames.length > MAX_RECORDED_AGENT_FRAMES) {
            session.recordingFrames = session.recordingFrames.slice(-MAX_RECORDED_AGENT_FRAMES);
        }
    });
    syncSessionRecordingSegments(session);
}

function stopSessionRecording(session) {
    closeActiveRecordingSegment(session);

    if (!session?.recordingUnsubscribe) {
        return;
    }

    try {
        session.recordingUnsubscribe();
    } catch {
        // ignore cleanup failures
    }
    session.recordingUnsubscribe = null;
}

async function persistRecordingMetadata(session) {
    const sessionId = sanitizeText(session?.sessionId);
    const chatId = sanitizeText(session?.chatId);
    if (!sessionId || !chatId) {
        return;
    }

    const recordingRoot = sanitizeText(session?.recordingRoot);
    if (!recordingRoot) {
        return;
    }

    const payload = {
        sessionId,
        chatId,
        agentId: sanitizeText(session?.agentId),
        status: sanitizeText(session?.status),
        currentUrl: sanitizeText(session?.currentUrl),
        viewport: session?.viewport || null,
        profileMode: sanitizeText(session?.profileMode),
        createdAt: Number(session?.createdAt) || Date.now(),
        updatedAt: Number(session?.updatedAt) || Date.now(),
        recordingOriginAt: Number(session?.recordingOriginAt) || 0,
        recordingSegments: serializeRecordingSegments(session),
        recordingVideoFiles: normalizeRecordingVideoFiles(session?.recordingVideoFiles),
    };

    await fs.mkdir(recordingRoot, { recursive: true });
    await fs.writeFile(
        getRecordingMetadataPath(sessionId),
        JSON.stringify(payload, null, 2),
        'utf8',
    );
}

async function readPersistedRecordingMetadata(sessionId) {
    const normalizedSessionId = sanitizeText(sessionId);
    if (!normalizedSessionId) {
        return null;
    }

    try {
        const raw = await fs.readFile(getRecordingMetadataPath(normalizedSessionId), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        return {
            sessionId: sanitizeText(parsed.sessionId),
            chatId: sanitizeText(parsed.chatId),
            agentId: sanitizeText(parsed.agentId),
            status: sanitizeText(parsed.status),
            currentUrl: sanitizeText(parsed.currentUrl),
            viewport: parsed.viewport || null,
            profileMode: sanitizeText(parsed.profileMode),
            createdAt: Number(parsed.createdAt) || 0,
            updatedAt: Number(parsed.updatedAt) || 0,
            recordingOriginAt: Number(parsed.recordingOriginAt) || 0,
            recordingSegments: Array.isArray(parsed.recordingSegments) ? parsed.recordingSegments : [],
            recordingVideoFiles: normalizeRecordingVideoFiles(parsed.recordingVideoFiles),
        };
    } catch {
        return null;
    }
}

async function archiveClosedSession(session) {
    const sessionId = sanitizeText(session?.sessionId);
    if (!sessionId) {
        return;
    }

    const recordingFrames = normalizeRecordingFrames(
        session.recordingFrames,
        MAX_RECORDED_AGENT_FRAMES,
    );

    const archivedAt = Date.now();
    const archivedSession = {
        sessionId,
        chatId: sanitizeText(session.chatId),
        agentId: sanitizeText(session.agentId),
        profileMode: session.profileMode,
        status: sanitizeText(session.status),
        question: sanitizeText(session.question),
        questionType: sanitizeText(session.questionType),
        completionReason: sanitizeText(session.completionReason),
        errorMessage: sanitizeText(session.errorMessage),
        controlMode: sanitizeText(session.controlMode) || 'agent',
        currentUrl: sanitizeText(session.currentUrl),
        viewport: session.viewport || null,
        lastStatusMessage: sanitizeText(session.lastStatusMessage),
        logEntries: Array.isArray(session.logEntries) ? [...session.logEntries] : [],
        archivedAt,
        recordingFrames,
        recordingVideoFiles: normalizeRecordingVideoFiles(session.recordingVideoFiles),
    };

    archivedBrowserSessions.set(sessionId, archivedSession);
    setTimeout(() => {
        const current = archivedBrowserSessions.get(sessionId);
        if (current && current.archivedAt === archivedAt) {
            archivedBrowserSessions.delete(sessionId);
        }
    }, ARCHIVED_SESSION_RETENTION_MS).unref?.();
}

function getArchivedSessionForChat(sessionId, chatId) {
    const archivedSession = archivedBrowserSessions.get(sanitizeText(sessionId));
    if (!archivedSession) {
        return null;
    }

    if (sanitizeText(archivedSession.chatId) !== sanitizeText(chatId)) {
        return null;
    }

    return archivedSession;
}

function buildArchivedToolResult(archivedSession) {
    const sessionLike = {
        ...archivedSession,
        logEntries: archivedSession.logEntries ?? [],
        executionBinding: {},
        expiresAt: 0,
        closed: true,
        runtimeStatus: {
            running: false,
        },
        lastLiveFrameAt: 0,
        livePreviewTimeouts: 0,
        livePreviewFrameCount: 0,
        lastLivePreviewError: '',
    };
    const payload = buildAgentPayload(sessionLike);

    return {
        ok: archivedSession.status !== 'error',
        status: archivedSession.status,
        text: payload.text,
        thought: '',
        parts: payload.parts,
        steps: payload.steps,
        activityLog: payload.activityLog,
        sessionId: archivedSession.sessionId,
        question: archivedSession.question || undefined,
        questionType: archivedSession.questionType || undefined,
        currentUrl: archivedSession.currentUrl || undefined,
        profileMode: archivedSession.profileMode,
        controlMode: archivedSession.controlMode,
        userAction: undefined,
        sessionLive: false,
        sessionExpiresAt: undefined,
        sessionIdleTimeoutMs: undefined,
        livePreview: {
            healthy: false,
            lastFrameAt: undefined,
            staleForMs: null,
            frameCount: 0,
            consecutiveTimeouts: 0,
            lastError: 'Browser session is no longer live.',
        },
        remoteDesktop: buildRemoteDesktopState({
            enabled: false,
            available: false,
            status: 'offline',
            reason: 'Browser session is no longer live.',
        }),
        recording: buildRecordingState(
            sessionLike,
            archivedSession.recordingFrames,
            archivedSession.recordingVideoFiles,
        ),
        viewport: archivedSession.viewport || undefined,
        running: false,
        lastStatusMessage: archivedSession.lastStatusMessage || undefined,
        message: 'Browser session is no longer live.',
        sessionClosed: true,
    };
}

function getCurrentExecutionBinding() {
    const contextData = getExecutionContext();
    return {
        chatId: sanitizeText(contextData?.chatId),
        messageId: sanitizeText(contextData?.messageId),
        clientId: sanitizeText(contextData?.clientId),
        toolCallId: sanitizeText(contextData?.toolCallId),
        toolName: sanitizeText(contextData?.toolName) || 'call_browser_agent',
    };
}

function buildSessionSummaryText(session) {
    const lines = [];
    const currentUrl = sanitizeText(session.currentUrl);
    const remoteDesktop = buildRemoteDesktopState(session.remoteDesktop);

    if (session.status === 'awaiting_user' && session.question) {
        lines.push(`Waiting for user input: ${session.question}`);
    } else if (session.controlMode === 'user') {
        lines.push('Waiting for the user to interact with the browser.');
    } else if (session.status === 'completed' && session.completionReason) {
        lines.push(`Completed: ${session.completionReason}`);
    } else if (session.status === 'error' && session.errorMessage) {
        lines.push(`Error: ${session.errorMessage}`);
    } else if (session.status === 'stopped') {
        lines.push('Browser task stopped.');
    } else {
        lines.push('Browser task in progress.');
    }

    if (currentUrl) {
        lines.push(`Current URL: ${currentUrl}`);
    }

    if (remoteDesktop.available) {
        lines.push('Remote desktop is available for live browser takeover.');
    }

    if (session.expiresAt > Date.now()) {
        lines.push(`Browser remains open until ${new Date(session.expiresAt).toISOString()}.`);
    }

    lines.push(`Session: ${session.sessionId}`);
    lines.push(`Profile: ${session.profileMode}`);

    const recentEntries = session.logEntries.slice(-6);
    if (recentEntries.length > 0) {
        lines.push('');
        lines.push('Recent activity:');
        for (const entry of recentEntries) {
            lines.push(`- ${entry.message}`);
        }
    }

    return lines.join('\n').trim();
}

function buildSessionSteps(session) {
    return session.logEntries.map((entry) => ({
        text: entry.message,
        thought: '',
        parts: [{ text: entry.message }],
        isThinking: false,
    }));
}

function buildActivityLog(session) {
    return session.logEntries.map((entry) => ({
        id: entry.id,
        content: entry.message,
        createdAt: entry.createdAt,
        isLive: false,
    }));
}

function buildLivePreviewState(session) {
    const lastFrameAt = Number(session.lastLiveFrameAt) || 0;
    const consecutiveTimeouts = Number(session.livePreviewTimeouts) || 0;
    const lastError = sanitizeText(session.lastLivePreviewError);
    const staleForMs = lastFrameAt > 0 ? Math.max(0, Date.now() - lastFrameAt) : null;
    const healthy = Boolean(
        session.closed !== true
        && lastFrameAt > 0
        && staleForMs !== null
        && staleForMs < 4000
        && consecutiveTimeouts < 2
    );

    return {
        healthy,
        lastFrameAt: lastFrameAt > 0 ? lastFrameAt : undefined,
        staleForMs,
        frameCount: Number(session.livePreviewFrameCount) || 0,
        consecutiveTimeouts,
        lastError: lastError || undefined,
    };
}

function buildAgentPayload(session) {
    const text = buildSessionSummaryText(session);
    return {
        text,
        thought: '',
        parts: [{ text }],
        steps: buildSessionSteps(session),
        activityLog: buildActivityLog(session),
        isThinking: session.status === 'running' || session.status === 'thinking' || session.status === 'working',
        status: session.status,
        question: session.question || undefined,
        questionType: session.questionType || undefined,
        userAction: buildUserActionState(session) || undefined,
        error: session.errorMessage || undefined,
        currentUrl: session.currentUrl || undefined,
        sessionId: session.sessionId,
        profileMode: session.profileMode,
        controlMode: session.controlMode,
        sessionLive: isLiveSession(session),
        sessionExpiresAt: session.expiresAt > 0 ? session.expiresAt : undefined,
        sessionIdleTimeoutMs: getSessionIdleTimeoutMs(session),
        livePreview: buildLivePreviewState(session),
        viewport: session.viewport || undefined,
        remoteDesktop: buildRemoteDesktopState(session.remoteDesktop),
        clientId: session.executionBinding.clientId || undefined,
        agentId: BROWSER_AGENT_ID,
    };
}

function emitStreamingUpdate(session) {
    const binding = session.executionBinding;
    if (!binding.chatId || !binding.messageId) {
        return;
    }

    const agentPayload = buildAgentPayload(session);
    broadcastEvent('agent.streaming', {
        chatId: binding.chatId,
        messageId: binding.messageId,
        toolCallId: binding.toolCallId,
        toolName: binding.toolName,
        agentId: BROWSER_AGENT_ID,
        payload: agentPayload,
    });
    updateStreamingSnapshot(binding.chatId, {
        agentToolCallId: binding.toolCallId,
        agentToolName: binding.toolName,
        agentPayload,
    });
}

function pushStatusMessage(session, rawMessage) {
    if (!isLiveSession(session)) {
        return;
    }

    const message = sanitizeText(rawMessage);
    if (!message) {
        return;
    }

    appendSessionLog(session, message);

    if (message.startsWith('❓ QUESTION:')) {
        const parsedQuestion = parseUserQuestion(message.replace(/^❓ QUESTION:\s*/, ''));
        session.status = 'awaiting_user';
        session.question = parsedQuestion.question;
        session.questionType = parsedQuestion.type;
        session.completionReason = '';
        session.errorMessage = '';
        syncSessionRecordingSegments(session);
        emitStreamingUpdate(session);
        return;
    }

    if (message.startsWith('✅ Complete:')) {
        if (session.status !== 'awaiting_user') {
            session.status = 'completed';
            session.completionReason = sanitizeText(message.replace(/^✅ Complete:\s*/, ''));
            session.question = '';
            session.questionType = '';
            session.errorMessage = '';
        }
        syncSessionRecordingSegments(session);
        emitStreamingUpdate(session);
        return;
    }

    if (message === '🛑 Stopping...') {
        session.status = 'stopped';
        session.question = '';
        session.questionType = '';
        syncSessionRecordingSegments(session);
        emitStreamingUpdate(session);
        return;
    }

    if (message.startsWith('🛑 ')) {
        if (session.status !== 'awaiting_user') {
            session.status = 'error';
            session.errorMessage = sanitizeText(message.replace(/^🛑\s*/, ''));
            session.question = '';
            session.questionType = '';
            session.completionReason = '';
        }
        syncSessionRecordingSegments(session);
        emitStreamingUpdate(session);
        return;
    }

    if (message.startsWith('❌ ')) {
        session.status = 'error';
        session.errorMessage = sanitizeText(message.replace(/^❌\s*/, ''));
        session.question = '';
        session.questionType = '';
        session.completionReason = '';
        syncSessionRecordingSegments(session);
        emitStreamingUpdate(session);
        return;
    }

    if (message.startsWith('📊 Usage (completed)')) {
        if (session.status !== 'awaiting_user' && session.status !== 'error' && session.status !== 'stopped') {
            session.status = 'completed';
        }
        syncSessionRecordingSegments(session);
        emitStreamingUpdate(session);
        return;
    }

    if (message.startsWith('📊 Usage (stopped)')) {
        session.status = 'stopped';
        syncSessionRecordingSegments(session);
        emitStreamingUpdate(session);
        return;
    }

    if (message.startsWith('📊 Usage (error)')) {
        session.status = 'error';
        syncSessionRecordingSegments(session);
        emitStreamingUpdate(session);
        return;
    }

    session.status = 'running';
    syncSessionRecordingSegments(session);
    emitStreamingUpdate(session);
}

function createBrowserConfig({ userDataDir, recordingVideoDir, remoteDesktop }) {
    const config = cloneConfig(DEFAULT_AGENT_CONFIG);
    const savedAgentConfig = getAgentConfig(BROWSER_AGENT_ID);
    config.browser.userDataDir = userDataDir;
    config.browser.recordVideo = {
        dir: recordingVideoDir,
        size: {
            width: 1920,
            height: 1080,
        },
    };
    if (remoteDesktop?.available) {
        config.browser.headless = false;
        config.browser.env = {
            ...(remoteDesktop.env && typeof remoteDesktop.env === 'object' ? remoteDesktop.env : {}),
        };
        config.browser.launchArgs = [
            ...config.browser.launchArgs,
            '--window-size=1920,1080',
            '--force-device-scale-factor=1',
        ];
    }
    config.llm.model = sanitizeText(savedAgentConfig?.model)
        || sanitizeText(process.env.BROWSER_AGENT_MODEL)
        || config.llm.model;
    config.llm.thinkingLevel = sanitizeThinkingLevel(
        savedAgentConfig?.thinkingLevel
        || process.env.BROWSER_AGENT_THINKING_LEVEL,
        config.llm.thinkingLevel,
    );
    const headlessOverride = sanitizeText(process.env.BROWSER_AGENT_HEADLESS).toLowerCase();
    if (headlessOverride === 'false' || headlessOverride === '0' || headlessOverride === 'no') {
        config.browser.headless = false;
    }
    if (headlessOverride === 'true' || headlessOverride === '1' || headlessOverride === 'yes') {
        config.browser.headless = true;
    }
    return config;
}

async function cleanupSessionArtifacts(session) {
    if (session.profileMode !== 'isolated' || !session.sessionRoot) {
        return;
    }

    try {
        await fs.rm(session.sessionRoot, { recursive: true, force: true });
    } catch {
        // ignore cleanup failures
    }
}

async function closeSession(session) {
    if (!isLiveSession(session)) {
        return;
    }

    clearSessionCloseTimer(session);
    stopSessionRecording(session);
    session.closed = true;
    session.updatedAt = Date.now();
    let shutdownResult = null;

    try {
        shutdownResult = await session.runtime?.shutdown();
    } catch {
        // ignore shutdown failures
    }
    await session.remoteDesktop?.close?.();

    session.recordingVideoFiles = await finalizeRecordedVideoFiles(
        session,
        shutdownResult?.recordedVideoFiles,
    );
    if (session.recordingVideoFiles.length > 0) {
        appendSessionLog(
            session,
            `🎥 Saved Browser Agent recording: ${session.recordingVideoFiles[0].localPath}`,
        );
    }

    await persistRecordingMetadata(session);
    await archiveClosedSession(session);

    browserSessions.delete(session.sessionId);
    if (session.profileMode === 'isolated') {
        isolatedSessionIdsByOwner.delete(session.ownerKey);
    }

    await cleanupSessionArtifacts(session);
}

function getSessionOwnershipContext() {
    const contextData = getExecutionContext();
    return {
        chatId: sanitizeText(contextData?.chatId),
        agentId: sanitizeText(contextData?.agentId) || 'orchestrator',
    };
}

async function createSession({ agentId, chatId, clientId, profileMode }) {
    const sessionId = `browser-${randomUUID()}`;
    const executionBinding = getCurrentExecutionBinding();
    const ownerKey = buildOwnerKey({ chatId, agentId });
    const recordingRoot = getRecordingRootForSession(sessionId);
    const recordingVideoDir = path.join(recordingRoot, 'raw');
    const remoteDesktop = supportsLinuxRemoteDesktop()
        ? await createLinuxRemoteDesktop(sessionId)
        : null;
    let sessionRoot = '';
    let userDataDir = BROWSER_PERSISTENT_PROFILE_DIR;

    if (profileMode === 'isolated') {
        await fs.mkdir(BROWSER_SESSION_DATA_DIR, { recursive: true });
        sessionRoot = await fs.mkdtemp(path.join(BROWSER_SESSION_DATA_DIR, `${agentId}-`));
        userDataDir = path.join(sessionRoot, 'profile');
    }

    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(recordingVideoDir, { recursive: true });

    const session = {
        sessionId,
        agentId,
        chatId,
        clientId,
        ownerKey,
        profileMode,
        sessionRoot,
        userDataDir,
        recordingRoot,
        recordingVideoDir,
        status: 'running',
        question: '',
        questionType: '',
        completionReason: '',
        errorMessage: '',
        controlMode: 'agent',
        availableUploadFiles: [],
        currentUrl: '',
        viewport: null,
        remoteDesktop,
        runtimeStatus: null,
        lastStatusMessage: '',
        lastTaskPrompt: '',
        logEntries: [],
        closeTimer: null,
        expiresAt: 0,
        recordingFrames: [],
        recordingUnsubscribe: null,
        lastRecordedFrameAt: 0,
        recordingVideoFiles: [],
        recordingOriginAt: 0,
        recordingSegments: [],
        recordingSegmentStartedAt: 0,
        lastLiveFrameAt: 0,
        livePreviewFrameCount: 0,
        livePreviewTimeouts: 0,
        lastLivePreviewError: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        closed: false,
        executionBinding,
        runtime: null,
    };

    browserSessions.set(sessionId, session);
    if (profileMode === 'isolated') {
        isolatedSessionIdsByOwner.set(ownerKey, sessionId);
    }

    const runtime = createAgentRuntime(
        createBrowserConfig({ userDataDir, recordingVideoDir, remoteDesktop }),
        (message) => {
            const liveSession = browserSessions.get(sessionId);
            if (liveSession) {
                pushStatusMessage(liveSession, message);
            }
        },
    );

    session.runtime = runtime;

    try {
        await runtime.start();
        session.recordingOriginAt = Date.now();
        if (remoteDesktop && remoteDesktop.available) {
            appendSessionLog(session, `🖥️ Remote desktop ready on ${remoteDesktop.display}.`);
        } else if (remoteDesktop?.reason) {
            appendSessionLog(session, `🖥️ Remote desktop unavailable: ${remoteDesktop.reason}`);
        }
        const runtimeStatus = await runtime.getStatus();
        session.runtimeStatus = runtimeStatus;
        session.currentUrl = sanitizeText(runtimeStatus.currentUrl);
        session.viewport = await runtime.getViewport().catch(() => null);
        emitStreamingUpdate(session);
        return session;
    } catch (error) {
        browserSessions.delete(sessionId);
        if (profileMode === 'isolated') {
            isolatedSessionIdsByOwner.delete(ownerKey);
        }
        await remoteDesktop?.close?.();
        await cleanupSessionArtifacts(session);
        throw error;
    }
}

function getAccessibleSession(sessionId, { chatId, agentId }) {
    const session = browserSessions.get(sanitizeText(sessionId));
    if (!isLiveSession(session)) {
        return null;
    }

    if (sanitizeText(session.chatId) !== sanitizeText(chatId) || sanitizeText(session.agentId) !== sanitizeText(agentId)) {
        return null;
    }

    return session;
}

function getAccessibleSessionForChat(sessionId, chatId) {
    const session = browserSessions.get(sanitizeText(sessionId));
    if (!isLiveSession(session)) {
        return null;
    }

    if (sanitizeText(session.chatId) !== sanitizeText(chatId)) {
        return null;
    }

    return session;
}

async function resolveSession({
    requestedSessionId,
    chatId,
    clientId,
    agentId,
    newSession = false,
}) {
    const persistent = agentId === 'orchestrator';

    if (requestedSessionId) {
        const session = getAccessibleSession(requestedSessionId, { chatId, agentId });
        if (session) {
            return session;
        }
    }

    if (persistent) {
        const livePersistentSession = getPersistentLiveSession();
        if (livePersistentSession) {
            if (newSession && livePersistentSession.chatId === chatId) {
                await closeSession(livePersistentSession);
            } else if (livePersistentSession.chatId === chatId) {
                return livePersistentSession;
            } else if (!newSession) {
                throw new Error(
                    `Persistent browser profile is already in use by chat ${livePersistentSession.chatId} (session ${livePersistentSession.sessionId}). Retry with new_session=true to take over that shared profile.`,
                );
            } else {
                try {
                    livePersistentSession.runtime?.stopTask?.();
                } catch {
                    // ignore stop failures while reclaiming the shared persistent profile
                }
                livePersistentSession.status = 'stopped';
                livePersistentSession.errorMessage = '';
                livePersistentSession.completionReason = '';
                livePersistentSession.question = '';
                livePersistentSession.questionType = '';
                appendSessionLog(
                    livePersistentSession,
                    `🔁 Persistent browser profile was reassigned to chat ${chatId}.`,
                );
                emitStreamingUpdate(livePersistentSession);
                await closeSession(livePersistentSession);
            }
        }

        return createSession({
            agentId,
            chatId,
            clientId,
            profileMode: 'persistent',
        });
    }

    const ownerKey = buildOwnerKey({ chatId, agentId });
    if (!newSession) {
        const existingId = isolatedSessionIdsByOwner.get(ownerKey);
        const existingSession = getAccessibleSession(existingId, { chatId, agentId });
        if (existingSession) {
            return existingSession;
        }
    } else {
        const existingId = isolatedSessionIdsByOwner.get(ownerKey);
        const existingSession = getAccessibleSession(existingId, { chatId, agentId });
        if (existingSession) {
            await closeSession(existingSession);
        }
    }

    return createSession({
        agentId,
        chatId,
        clientId,
        profileMode: 'isolated',
    });
}

function normalizeBrowserUploadFiles(uploadFiles) {
    if (!Array.isArray(uploadFiles)) {
        return [];
    }

    return uploadFiles
        .map((entry, index) => {
            if (!entry || typeof entry !== 'object') {
                return null;
            }

            const absolutePath = sanitizeText(entry.absolutePath);
            if (!absolutePath) {
                return null;
            }

            return {
                uploadId: sanitizeText(entry.uploadId || entry.id) || `upload-${index + 1}`,
                name: sanitizeText(entry.name) || path.basename(absolutePath) || `file-${index + 1}`,
                mimeType: sanitizeText(entry.mimeType) || 'application/octet-stream',
                absolutePath,
            };
        })
        .filter(Boolean);
}

function buildUploadContextBlock(uploadFiles) {
    const normalized = normalizeBrowserUploadFiles(uploadFiles);
    if (normalized.length === 0) {
        return '';
    }

    const lines = normalized
        .map((file) => `- [${file.uploadId}] ${file.name} (${file.mimeType})`)
        .join('\n');

    return [
        'Upload Files Available:',
        lines,
        'For upload steps, use action="upload" with files references matching upload id or file name above.',
    ].join('\n');
}

function buildTaskPrompt({ task, context, uploadFiles }) {
    const taskText = sanitizeText(task);
    const contextText = sanitizeText(context);
    const uploadText = buildUploadContextBlock(uploadFiles);

    return [
        taskText,
        contextText ? `Context:\n${contextText}` : '',
        uploadText,
    ]
        .filter(Boolean)
        .join('\n\n');
}

async function refreshSessionState(session) {
    const runtimeStatus = await session.runtime.getStatus();
    session.runtimeStatus = runtimeStatus;
    session.currentUrl = sanitizeText(runtimeStatus.currentUrl);
    session.viewport = await session.runtime.getViewport().catch(() => session.viewport);
    session.updatedAt = Date.now();

    if (
        runtimeStatus?.running !== true
        && session.status === 'running'
        && session.lastStatusMessage.startsWith('📊 Usage (completed)')
    ) {
        session.status = 'completed';
    }

    syncSessionRecordingSegments(session);
    syncSessionCloseState(session);

    return runtimeStatus;
}

async function waitForStableState(session, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, shouldStop = null } = {}) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (typeof shouldStop === 'function' && shouldStop()) {
            session.runtime.stopTask();
            session.status = 'stopped';
            await refreshSessionState(session);
            return session;
        }

        await refreshSessionState(session);
        emitStreamingUpdate(session);

        if (
            session.status === 'awaiting_user'
            || session.status === 'completed'
            || session.status === 'error'
            || session.status === 'stopped'
        ) {
            return session;
        }

        await sleep(WAIT_POLL_MS);
    }

    await refreshSessionState(session);
    emitStreamingUpdate(session);
    return session;
}

function buildUsageMetadata(runtimeStatus) {
    const taskUsage = runtimeStatus?.usage?.lastTask ?? runtimeStatus?.usage?.currentTask ?? null;
    if (!taskUsage?.totals) {
        return null;
    }

    return {
        promptTokenCount: Number(taskUsage.totals.promptTokens) || 0,
        candidatesTokenCount: Number(taskUsage.totals.outputTokens) || 0,
        thoughtsTokenCount: Number(taskUsage.totals.thoughtsTokens) || 0,
        totalTokenCount: Number(taskUsage.totals.totalTokens) || 0,
    };
}

function buildToolResult(session) {
    const payload = buildAgentPayload(session);
    const runtimeStatus = session.runtimeStatus;
    const usageMetadata = buildUsageMetadata(runtimeStatus);

    return {
        ok: session.status !== 'error',
        status: session.status,
        text: payload.text,
        thought: '',
        parts: payload.parts,
        steps: payload.steps,
        activityLog: payload.activityLog,
        sessionId: session.sessionId,
        question: session.question || undefined,
        questionType: session.questionType || undefined,
        currentUrl: session.currentUrl || undefined,
        profileMode: session.profileMode,
        controlMode: session.controlMode,
        userAction: buildUserActionState(session) || undefined,
        sessionLive: isLiveSession(session),
        sessionExpiresAt: session.expiresAt > 0 ? session.expiresAt : undefined,
        sessionIdleTimeoutMs: getSessionIdleTimeoutMs(session),
        livePreview: buildLivePreviewState(session),
        viewport: session.viewport || undefined,
        remoteDesktop: buildRemoteDesktopState(session.remoteDesktop),
        recording: buildRecordingState(session),
        running: runtimeStatus?.running === true,
        lastStatusMessage: session.lastStatusMessage || undefined,
        message: session.status === 'awaiting_user'
            ? 'Browser Agent is waiting for user input.'
            : session.status === 'completed'
                ? (
                    session.profileMode === 'persistent'
                        ? 'Browser Agent completed the requested task and kept the persistent session open.'
                        : 'Browser Agent completed the requested task.'
                )
                : session.status === 'error'
                    ? 'Browser Agent encountered an error.'
                    : 'Browser Agent is still working.',
        _usage: {
            source: 'agent',
            model: (
                runtimeStatus?.usage?.lastTask?.model
                ?? runtimeStatus?.usage?.currentTask?.model
                ?? sanitizeText(getAgentConfig(BROWSER_AGENT_ID)?.model)
            )
                || sanitizeText(process.env.BROWSER_AGENT_MODEL)
                || DEFAULT_AGENT_CONFIG.llm.model,
            status: session.status,
            agentId: BROWSER_AGENT_ID,
            inputText: runtimeStatus?.usage?.lastTask?.goal ?? runtimeStatus?.usage?.currentTask?.goal ?? '',
            outputText: payload.text,
            activityLog: payload.activityLog,
            questionType: session.questionType || undefined,
            usageMetadata,
        },
    };
}

function buildScreenshotDisplayName(label = '', session) {
    const trimmedLabel = sanitizeText(label);
    if (trimmedLabel) {
        return `${trimmedLabel}.jpg`;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `browser-screenshot-${sanitizeText(session?.sessionId) || timestamp}-${timestamp}.jpg`;
}

async function captureLiveSessionScreenshot(session, {
    label = '',
    source = 'tool',
} = {}) {
    if (!isLiveSession(session)) {
        return null;
    }

    const frame = await session.runtime?.captureScreenshot?.({
        source,
        quality: 88,
    });
    if (!frame?.imageBase64) {
        return null;
    }

    if (frame.viewport) {
        session.viewport = frame.viewport;
    }
    if (frame.url) {
        session.currentUrl = sanitizeText(frame.url);
    }
    session.updatedAt = Date.now();

    const displayName = buildScreenshotDisplayName(label, session);
    const mediaPart = {
        inlineData: {
            mimeType: 'image/jpeg',
            data: frame.imageBase64,
            displayName,
        },
    };

    return {
        displayName,
        mimeType: 'image/jpeg',
        timestamp: sanitizeText(frame.timestamp) || new Date().toISOString(),
        url: sanitizeText(frame.url) || session.currentUrl || undefined,
        viewport: frame.viewport || session.viewport || undefined,
        mediaPart,
    };
}

function attachScreenshotToToolResult(result, screenshot) {
    if (!result || !screenshot?.mediaPart) {
        return result;
    }

    const screenshots = Array.isArray(result.screenshots) ? [...result.screenshots] : [];
    screenshots.push({
        displayName: screenshot.displayName,
        mimeType: screenshot.mimeType,
        timestamp: screenshot.timestamp,
        url: screenshot.url,
        viewport: screenshot.viewport,
    });

    return {
        ...result,
        screenshots,
        screenshotCount: screenshots.length,
        _mediaParts: [
            ...(Array.isArray(result._mediaParts) ? result._mediaParts : []),
            screenshot.mediaPart,
        ],
    };
}

function applyLivePreviewFrame(session, frame) {
    if (!frame || typeof frame !== 'object') {
        return null;
    }

    if (frame.viewport) {
        session.viewport = frame.viewport;
    }
    if (frame.url) {
        session.currentUrl = sanitizeText(frame.url);
    }

    const jpegBuffer = frame.imageBase64
        ? Buffer.from(frame.imageBase64, 'base64')
        : null;
    if (!jpegBuffer || jpegBuffer.length === 0) {
        return null;
    }

    session.lastLiveFrameAt = Date.now();
    session.livePreviewFrameCount = (Number(session.livePreviewFrameCount) || 0) + 1;
    session.livePreviewTimeouts = 0;
    session.lastLivePreviewError = '';
    return jpegBuffer;
}

async function writeLivePreviewChunk(res, chunk) {
    if (!res.write(chunk)) {
        await new Promise((resolve, reject) => {
            const handleDrain = () => {
                cleanup();
                resolve();
            };
            const handleClose = () => {
                cleanup();
                reject(new Error('Preview stream closed.'));
            };
            const handleError = (error) => {
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
            };
            const cleanup = () => {
                res.off('drain', handleDrain);
                res.off('close', handleClose);
                res.off('error', handleError);
            };

            res.once('drain', handleDrain);
            res.once('close', handleClose);
            res.once('error', handleError);
        });
    }
}

function buildResumeTaskPrompt(session, note = '') {
    const userNote = sanitizeText(note);
    const previousTask = sanitizeText(session.lastTaskPrompt);

    if (userNote) {
        return previousTask
            ? `${userNote}\n\nPrevious task:\n${previousTask}`
            : userNote;
    }

    if (session.questionType === 'captcha') {
        return previousTask
            ? `The user completed the CAPTCHA or manual verification. Resume the previous task from the current page state.\n\nPrevious task:\n${previousTask}`
            : 'The user completed the CAPTCHA or manual verification. Resume from the current page state.';
    }

    if (session.questionType === 'confirmation') {
        return previousTask
            ? `The user approved the pending confirmation. Continue the previous task and complete the final step if it is still pending.\n\nPrevious task:\n${previousTask}`
            : 'The user approved the pending confirmation. Continue from the current page state.';
    }

    return previousTask
        ? `Continue the previous task from the current page state.\n\nPrevious task:\n${previousTask}`
        : 'Continue from the current page state.';
}

async function setSessionControlMode(session, nextMode) {
    const mode = nextMode === 'user' ? 'user' : 'agent';
    if (mode === 'user' && session.runtimeStatus?.running === true) {
        try {
            session.runtime.stopTask();
        } catch {
            // ignore stop failures
        }
    }

    await refreshSessionState(session);
    session.controlMode = mode;

    if (mode === 'user') {
        if (session.status !== 'completed' && session.status !== 'error') {
            session.status = 'awaiting_user';
        }
        if (!session.question) {
            session.question = 'Manual control is active.';
        }
        if (!session.questionType) {
            session.questionType = DEFAULT_QUESTION_TYPE;
        }
    }

    syncSessionRecordingSegments(session);
    syncSessionCloseState(session);
    emitStreamingUpdate(session);

    if (shouldCloseSessionImmediately(session)) {
        const closingSessionId = session.sessionId;
        const closingChatId = session.chatId;
        await closeSession(session);
        const archivedSession = getArchivedSessionForChat(closingSessionId, closingChatId);
        if (archivedSession) {
            return buildArchivedToolResult(archivedSession);
        }
    }

    return buildToolResult(session);
}

export async function runBrowserAgentTask({
    task,
    context,
    uploadFiles = [],
    sessionId,
    newSession = false,
    restartSession = false,
    clearContext = false,
    preserveRecording = false,
    captureScreenshot = false,
    screenshotLabel = '',
} = {}) {
    const contextData = getExecutionContext();
    const chatId = sanitizeText(contextData?.chatId);
    const clientId = sanitizeText(contextData?.clientId);
    const agentId = sanitizeText(contextData?.agentId) || 'orchestrator';

    if (!chatId) {
        throw new Error('Browser Agent requires a chat context.');
    }

    const normalizedUploadFiles = normalizeBrowserUploadFiles(uploadFiles);
    const taskPrompt = buildTaskPrompt({
        task,
        context,
        uploadFiles: normalizedUploadFiles,
    });
    if (!taskPrompt) {
        throw new Error('task is required.');
    }

    const session = await resolveSession({
        requestedSessionId: sessionId,
        chatId,
        clientId,
        agentId,
        newSession,
    });

    session.executionBinding = getCurrentExecutionBinding();
    if (normalizedUploadFiles.length > 0) {
        session.availableUploadFiles = normalizedUploadFiles;
    } else if (!Array.isArray(session.availableUploadFiles)) {
        session.availableUploadFiles = [];
    }
    session.lastTaskPrompt = taskPrompt;
    session.question = '';
    session.questionType = '';
    session.completionReason = '';
    session.errorMessage = '';
    session.controlMode = 'agent';
    session.status = 'running';
    session.livePreviewTimeouts = 0;
    session.lastLivePreviewError = '';
    clearSessionCloseTimer(session);
    emitStreamingUpdate(session);

    if (restartSession) {
        await session.runtime.restart();
    } else if (clearContext) {
        await session.runtime.resetContext({
            stopRunningTask: true,
            navigateToStartup: false,
            clearMemory: false,
            clearFrameHistory: false,
        });
    }

    await session.runtime.submitTask(taskPrompt, {
        cleanContext: clearContext,
        preserveContext: !clearContext,
        uploadFiles: session.availableUploadFiles,
    });
    session.runtimeStatus = {
        ...(session.runtimeStatus && typeof session.runtimeStatus === 'object' ? session.runtimeStatus : {}),
        running: true,
    };
    await ensureSessionRecording(session, {
        reset: preserveRecording !== true,
    });

    await waitForStableState(session, {
        shouldStop: typeof contextData?.shouldStop === 'function' ? contextData.shouldStop : null,
    });

    syncSessionCloseState(session);
    emitStreamingUpdate(session);
    const taskScreenshot = captureScreenshot
        ? await captureLiveSessionScreenshot(session, {
            label: screenshotLabel,
            source: 'tool',
        })
        : null;

    if (shouldCloseSessionImmediately(session)) {
        const closingSessionId = session.sessionId;
        await closeSession(session);
        const archivedSession = getArchivedSessionForChat(closingSessionId, chatId);
        if (archivedSession) {
            return attachScreenshotToToolResult(buildArchivedToolResult(archivedSession), taskScreenshot);
        }

        return attachScreenshotToToolResult({
            ...buildToolResult(session),
            sessionLive: false,
            sessionClosed: true,
            message: 'Browser Agent session completed and was closed.',
        }, taskScreenshot);
    }

    return attachScreenshotToToolResult({
        ...buildToolResult(session),
        sessionClosed: false,
    }, taskScreenshot);
}

export async function inspectBrowserAgentSession(sessionId) {
    const { chatId, agentId } = getSessionOwnershipContext();
    if (!chatId) {
        throw new Error('Browser Agent requires a chat context.');
    }

    const session = getAccessibleSession(sessionId, { chatId, agentId });
    if (!session) {
        const archivedSession = getArchivedSessionForChat(sessionId, chatId);
        if (!archivedSession) {
            throw new Error(`Unknown browser session: ${sessionId}`);
        }
        return buildArchivedToolResult(archivedSession);
    }

    await refreshSessionState(session);
    emitStreamingUpdate(session);
    return {
        ...buildToolResult(session),
        sessionClosed: false,
    };
}

export async function captureBrowserAgentScreenshot(sessionId, {
    label = '',
} = {}) {
    const { chatId, agentId } = getSessionOwnershipContext();
    if (!chatId) {
        throw new Error('Browser Agent requires a chat context.');
    }

    const session = getAccessibleSession(sessionId, { chatId, agentId });
    if (!session) {
        throw new Error(`Unknown browser session: ${sessionId}`);
    }

    await refreshSessionState(session);
    const screenshot = await captureLiveSessionScreenshot(session, {
        label,
        source: 'tool',
    });
    const result = buildToolResult(session);
    if (!screenshot) {
        return result;
    }

    return attachScreenshotToToolResult(result, screenshot);
}

export async function inspectBrowserAgentSessionForChat({ sessionId, chatId } = {}) {
    const session = getAccessibleSessionForChat(sessionId, chatId);
    if (!session) {
        const archivedSession = getArchivedSessionForChat(sessionId, chatId);
        if (!archivedSession) {
            throw new Error(`Unknown browser session: ${sessionId}`);
        }
        return buildArchivedToolResult(archivedSession);
    }

    await refreshSessionState(session);
    emitStreamingUpdate(session);
    return {
        ...buildToolResult(session),
        sessionClosed: false,
    };
}

export async function getBrowserAgentRecordingForChat({
    sessionId,
    chatId,
    limit = MAX_RECORDED_AGENT_FRAMES,
} = {}) {
    const normalizedSessionId = sanitizeText(sessionId);
    const normalizedChatId = sanitizeText(chatId);
    const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.min(Math.trunc(Number(limit)), MAX_RECORDED_AGENT_FRAMES)
        : MAX_RECORDED_AGENT_FRAMES;

    const liveSession = getAccessibleSessionForChat(normalizedSessionId, normalizedChatId);
    if (liveSession) {
        const frames = normalizeRecordingFrames(liveSession.recordingFrames, safeLimit);

        return {
            sessionId: liveSession.sessionId,
            sessionLive: true,
            sessionClosed: false,
            recording: buildRecordingState(liveSession, frames, liveSession.recordingVideoFiles),
            frames,
            currentUrl: liveSession.currentUrl || undefined,
            viewport: liveSession.viewport || undefined,
        };
    }

    const archivedSession = getArchivedSessionForChat(normalizedSessionId, normalizedChatId);
    if (archivedSession) {
        const frames = normalizeRecordingFrames(archivedSession.recordingFrames, safeLimit);
        return {
            sessionId: archivedSession.sessionId,
            sessionLive: false,
            sessionClosed: true,
            recording: buildRecordingState(
                archivedSession,
                frames,
                archivedSession.recordingVideoFiles,
            ),
            frames,
            currentUrl: archivedSession.currentUrl || undefined,
            viewport: archivedSession.viewport || undefined,
        };
    }

    const persistedRecording = await readPersistedRecordingMetadata(normalizedSessionId);
    if (persistedRecording && sanitizeText(persistedRecording.chatId) === normalizedChatId) {
        return {
            sessionId: normalizedSessionId,
            sessionLive: false,
            sessionClosed: true,
            recording: buildRecordingState(
                persistedRecording,
                [],
                persistedRecording.recordingVideoFiles,
            ),
            frames: [],
            currentUrl: persistedRecording.currentUrl || undefined,
            viewport: persistedRecording.viewport || undefined,
        };
    }

    throw new Error(`Unknown browser session: ${normalizedSessionId}`);
}

export async function getBrowserAgentRecordingVideoForChat({
    sessionId,
    chatId,
    index = 0,
} = {}) {
    const normalizedSessionId = sanitizeText(sessionId);
    const normalizedChatId = sanitizeText(chatId);
    const safeIndex = Number.isFinite(Number(index)) && Number(index) >= 0
        ? Math.trunc(Number(index))
        : 0;

    const resolveVideoFile = (sessionLike) => {
        const videos = normalizeRecordingVideoFiles(sessionLike?.recordingVideoFiles);
        if (videos.length === 0) {
            return null;
        }
        return videos[Math.min(safeIndex, videos.length - 1)] || null;
    };

    const liveSession = getAccessibleSessionForChat(normalizedSessionId, normalizedChatId);
    if (liveSession) {
        const videoFile = resolveVideoFile(liveSession);
        if (videoFile) {
            return videoFile;
        }
    }

    const archivedSession = getArchivedSessionForChat(normalizedSessionId, normalizedChatId);
    if (archivedSession) {
        const videoFile = resolveVideoFile(archivedSession);
        if (videoFile) {
            return videoFile;
        }
    }

    const persistedRecording = await readPersistedRecordingMetadata(normalizedSessionId);
    if (persistedRecording && sanitizeText(persistedRecording.chatId) === normalizedChatId) {
        const videoFile = resolveVideoFile(persistedRecording);
        if (videoFile) {
            return videoFile;
        }
    }

    throw new Error(`No Browser Agent video recording is available for session: ${normalizedSessionId}`);
}

export async function continueBrowserAgentSession({
    sessionId,
    chatId,
    clientId,
    note = '',
} = {}) {
    const session = getAccessibleSessionForChat(sessionId, chatId);
    if (!session) {
        throw new Error(`Unknown browser session: ${sessionId}`);
    }

    const trimmedNote = sanitizeText(note);
    if (!trimmedNote && session.questionType === 'info' && session.controlMode !== 'user') {
        throw new Error('A response is required before continuing this browser task.');
    }

    const nextTask = buildResumeTaskPrompt(session, trimmedNote);

    return executionContext.run({
        chatId: session.chatId,
        clientId: sanitizeText(clientId) || session.clientId || session.executionBinding.clientId,
        agentId: session.agentId,
        messageId: session.executionBinding.messageId,
        toolCallId: session.executionBinding.toolCallId,
        toolName: session.executionBinding.toolName,
    }, () => runBrowserAgentTask({
        task: nextTask,
        sessionId: session.sessionId,
        newSession: false,
        restartSession: false,
        clearContext: false,
        preserveRecording: true,
    }));
}

function describeLiveAction(action, payload = {}) {
    switch (action) {
        case 'click':
            return `👤 User clicked at [${payload.x}, ${payload.y}].`;
        case 'double_click':
            return `👤 User double-clicked at [${payload.x}, ${payload.y}].`;
        case 'hold':
            return `👤 User held at [${payload.x}, ${payload.y}].`;
        case 'hover':
            return `👤 User hovered at [${payload.x}, ${payload.y}].`;
        case 'type':
            return `👤 User typed into the page.`;
        case 'paste':
            return `👤 User pasted into the page.`;
        case 'clear':
            return `👤 User cleared the focused field.`;
        case 'press_key':
            return `👤 User pressed ${payload.key}.`;
        case 'scroll_up':
            return '👤 User scrolled up.';
        case 'scroll_down':
            return '👤 User scrolled down.';
        case 'navigate':
            return `👤 User navigated to ${sanitizeText(payload.url)}.`;
        case 'go_back':
            return '👤 User went back.';
        case 'go_forward':
            return '👤 User went forward.';
        case 'reload':
            return '👤 User reloaded the page.';
        default:
            return '👤 User interacted with the browser.';
    }
}

export async function performBrowserAgentLiveAction(sessionId, {
    chatId,
    action,
    x,
    y,
    text,
    key,
    url,
    durationMs,
} = {}) {
    const session = getAccessibleSessionForChat(sessionId, chatId);
    if (!session) {
        throw new Error(`Unknown browser session: ${sessionId}`);
    }

    const normalizedAction = sanitizeText(action).toLowerCase();
    if (!normalizedAction) {
        throw new Error('action is required.');
    }

    if (normalizedAction === 'take_control') {
        return setSessionControlMode(session, 'user');
    }

    if (normalizedAction === 'release_control') {
        return setSessionControlMode(session, 'agent');
    }

    if (session.controlMode !== 'user') {
        await setSessionControlMode(session, 'user');
    }

    const payload = {
        x: Number(x),
        y: Number(y),
        text: sanitizeText(text),
        key: sanitizeText(key),
        url: sanitizeText(url),
        durationMs: Number(durationMs),
    };

    const ok = await session.runtime.performLiveAction(normalizedAction, payload);
    await refreshSessionState(session);
    appendSessionLog(session, describeLiveAction(normalizedAction, payload));
    emitStreamingUpdate(session);

    return {
        ...buildToolResult(session),
        ok: ok !== false,
        sessionClosed: false,
        liveAction: normalizedAction,
    };
}

export async function handleBrowserAgentRemoteDesktopUpgrade(req, socket, head) {
    const target = getRemoteDesktopUpgradeTarget(req.url);
    if (!target) {
        return false;
    }

    const session = getAccessibleSessionForChat(target.sessionId, target.chatId);
    if (!session || session.remoteDesktop?.available !== true) {
        try {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        } catch {
            // ignore socket write failures
        }
        try {
            socket.destroy();
        } catch {
            // ignore socket destroy failures
        }
        return true;
    }

    await proxyRemoteDesktopUpgrade({
        req,
        socket,
        head,
        remoteDesktop: session.remoteDesktop,
    });
    return true;
}

export async function streamBrowserAgentLiveView({ sessionId, chatId, req, res }) {
    const session = getAccessibleSessionForChat(sessionId, chatId);
    if (!session) {
        throw new Error(`Unknown browser session: ${sessionId}`);
    }

    res.status(200);
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    let writing = false;
    let queuedFrame = null;
    let unsubscribe = null;
    let closeWatcher = null;

    const closeStream = async () => {
        if (closed) {
            return;
        }

        closed = true;
        queuedFrame = null;
        if (closeWatcher) {
            clearInterval(closeWatcher);
            closeWatcher = null;
        }
        if (typeof unsubscribe === 'function') {
            try {
                unsubscribe();
            } catch {
                // ignore subscriber cleanup failures
            }
            unsubscribe = null;
        }

        try {
            res.end();
        } catch {
            // ignore stream close failures
        }
    };

    const writeFrame = async (frame) => {
        if (closed || !isLiveSession(session)) {
            await closeStream();
            return;
        }

        const jpegBuffer = applyLivePreviewFrame(session, frame);
        if (!jpegBuffer) {
            return;
        }

        writing = true;
        try {
            await writeLivePreviewChunk(res, `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuffer.length}\r\n\r\n`);
            await writeLivePreviewChunk(res, jpegBuffer);
            await writeLivePreviewChunk(res, '\r\n');
            res.flush?.();
        } catch (error) {
            session.livePreviewTimeouts = (Number(session.livePreviewTimeouts) || 0) + 1;
            session.lastLivePreviewError = error instanceof Error ? error.message : 'Preview stream failed.';
            await closeStream();
            return;
        } finally {
            writing = false;
        }

        if (queuedFrame && !closed) {
            const nextFrame = queuedFrame;
            queuedFrame = null;
            void writeFrame(nextFrame);
        }
    };

    req.on('close', () => {
        void closeStream();
    });

    try {
        unsubscribe = await session.runtime.subscribeLiveFrames((frame) => {
            if (closed) {
                return;
            }

            if (writing) {
                queuedFrame = frame;
                return;
            }

            void writeFrame(frame);
        });
    } catch (error) {
        session.livePreviewTimeouts = (Number(session.livePreviewTimeouts) || 0) + 1;
        session.lastLivePreviewError = error instanceof Error ? error.message : 'Preview stream failed.';
        await closeStream();
        throw error;
    }

    closeWatcher = setInterval(() => {
        if (!isLiveSession(session)) {
            void closeStream();
        }
    }, 1000);
    closeWatcher.unref?.();
}

export async function terminateBrowserAgentSession(sessionId) {
    const { chatId, agentId } = getSessionOwnershipContext();
    if (!chatId) {
        throw new Error('Browser Agent requires a chat context.');
    }

    const session = getAccessibleSession(sessionId, { chatId, agentId });
    if (!session) {
        throw new Error(`Unknown browser session: ${sessionId}`);
    }

    try {
        session.runtime.stopTask();
    } catch {
        // ignore stop failures
    }
    session.status = 'stopped';
    emitStreamingUpdate(session);

    const result = buildToolResult(session);
    await closeSession(session);
    return {
        ...result,
        sessionClosed: true,
        message: 'Browser Agent session terminated.',
    };
}
