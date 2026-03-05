import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    continueBrowserAgentSessionRequest,
    controlBrowserAgentSession,
    fetchBrowserAgentRecording,
    fetchBrowserAgentSession,
    getBrowserAgentLiveStreamUrl,
    getBrowserAgentRemoteDesktopWsUrl,
    getBrowserAgentRecordingVideoUrl,
} from '../../api/chatApi.js';
import { BrowserActivityLog } from '../shared/BrowserActivityLog.jsx';
import './BrowserAgentPanel.css';

const DEFAULT_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });

function normalizeViewport(value) {
    const width = Number(value?.width);
    const height = Number(value?.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        return {
            width: Math.round(width),
            height: Math.round(height),
        };
    }
    return { ...DEFAULT_VIEWPORT };
}

function formatQuestionType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'captcha') return 'CAPTCHA or verification';
    if (normalized === 'confirmation') return 'Confirmation needed';
    return 'More information needed';
}

function getContinueLabel({ controlMode, questionType, shouldResumeOnRelease }) {
    if (controlMode === 'user') {
        return shouldResumeOnRelease ? 'Resume with note' : 'Run follow-up';
    }
    if (questionType === 'confirmation') {
        return 'Continue';
    }
    if (!questionType) {
        return 'Steer';
    }
    return 'Send';
}

function formatExpiryLabel(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
        return '';
    }

    const expiresAt = new Date(timestamp);
    return `Open until ${expiresAt.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    })}`;
}

function formatRecordingTimestamp(value) {
    const timestamp = Date.parse(String(value ?? ''));
    if (!Number.isFinite(timestamp)) {
        return '';
    }

    return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function normalizeNavigateUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return '';
    }

    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw)) {
        return raw;
    }

    return `https://${raw}`;
}

function isTextEntryTarget(target) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const tagName = target.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
        return true;
    }

    return target.isContentEditable === true;
}

function isTerminalBrowserStatus(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'completed' || normalized === 'error' || normalized === 'stopped';
}

export function BrowserAgentPanel({
    chatId,
    clientId,
    payload,
}) {
    const panelRef = useRef(null);
    const imageRef = useRef(null);
    const addressInputRef = useRef(null);
    const vncTargetRef = useRef(null);
    const rfbRef = useRef(null);
    const [steerText, setSteerText] = useState('');
    const [typingText, setTypingText] = useState('');
    const [addressText, setAddressText] = useState('');
    const [isPending, setIsPending] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [sessionAvailable, setSessionAvailable] = useState(true);
    const [isEditingAddress, setIsEditingAddress] = useState(false);
    const [sessionSnapshot, setSessionSnapshot] = useState(null);
    const [recordingState, setRecordingState] = useState(null);
    const [recordingFrames, setRecordingFrames] = useState([]);
    const [recordingIndex, setRecordingIndex] = useState(0);
    const [isRecordingLoading, setIsRecordingLoading] = useState(false);
    const [optimisticControlMode, setOptimisticControlMode] = useState('');
    const [isPreviewConnecting, setIsPreviewConnecting] = useState(false);
    const [remoteDesktopStatus, setRemoteDesktopStatus] = useState('idle');
    const [remoteDesktopError, setRemoteDesktopError] = useState('');

    const effectivePayload = sessionSnapshot && typeof sessionSnapshot === 'object'
        ? { ...payload, ...sessionSnapshot }
        : payload;
    const sessionId = String(payload?.sessionId ?? '').trim();
    const sessionStatus = String(effectivePayload?.status ?? '').trim().toLowerCase();
    const remoteControlMode = String(effectivePayload?.controlMode ?? '').trim().toLowerCase() || 'agent';
    const controlMode = optimisticControlMode || remoteControlMode;
    const questionType = String(effectivePayload?.questionType ?? '').trim().toLowerCase() || 'info';
    const userAction = effectivePayload?.userAction ?? null;
    const hasStructuredUserRequest = userAction?.required === true;
    const currentUrl = String(effectivePayload?.currentUrl ?? '').trim();
    const viewport = useMemo(() => normalizeViewport(effectivePayload?.viewport), [effectivePayload?.viewport]);
    const activityLog = Array.isArray(effectivePayload?.activityLog) ? effectivePayload.activityLog : [];
    const sessionLive = effectivePayload?.sessionLive !== false;
    const liveSessionLikely = sessionAvailable && sessionLive;
    const remoteDesktop = effectivePayload?.remoteDesktop ?? null;
    const remoteDesktopEnabled = remoteDesktop?.enabled === true;
    const remoteDesktopAvailable = liveSessionLikely && remoteDesktop?.available === true;
    const panelControlMode = liveSessionLikely ? controlMode : 'agent';
    const directToUser = liveSessionLikely && (userAction?.directToUser === true || panelControlMode === 'user');
    const canSteerDirectly = liveSessionLikely && (!hasStructuredUserRequest || directToUser || panelControlMode === 'user');
    const needsNoteForBottomAction = panelControlMode === 'user';
    const shouldResumeOnRelease = panelControlMode === 'user' && !isTerminalBrowserStatus(sessionStatus);
    const livePreview = effectivePayload?.livePreview ?? null;
    const previewHealthy = livePreview?.healthy !== false;
    const previewStaleForMs = Number(livePreview?.staleForMs);
    const previewStatusLabel = (!sessionAvailable || !sessionLive)
        ? 'Browser not live'
        : remoteDesktopAvailable
            ? (remoteDesktopStatus === 'connected'
                ? 'Live browser'
                : remoteDesktopStatus === 'error'
                    ? 'Remote desktop error'
                    : 'Connecting live browser')
        : isPreviewConnecting
            ? 'Connecting preview'
        : previewHealthy
            ? 'Preview live'
            : previewStaleForMs >= 4000
                ? 'Preview stalled'
                : 'Preview reconnecting';
    const addressStatusLabel = !liveSessionLikely
        ? 'Offline'
        : remoteDesktopAvailable
            ? (panelControlMode === 'user'
                ? 'Interactive'
                : remoteDesktopStatus === 'connected'
                    ? 'View only'
                    : 'Connecting')
        : isPreviewConnecting
            ? 'Loading preview'
            : previewHealthy
                ? 'Live'
                : 'Lagging';
    const sessionExpiryLabel = useMemo(
        () => formatExpiryLabel(effectivePayload?.sessionExpiresAt),
        [effectivePayload?.sessionExpiresAt],
    );
    const liveStreamUrl = useMemo(() => {
        if (!sessionId || !chatId || !liveSessionLikely) {
            return '';
        }
        return getBrowserAgentLiveStreamUrl({ sessionId, chatId });
    }, [chatId, liveSessionLikely, sessionId]);
    const remoteDesktopWsUrl = useMemo(() => {
        if (!remoteDesktopAvailable || !sessionId || !chatId) {
            return '';
        }
        return getBrowserAgentRemoteDesktopWsUrl({ sessionId, chatId });
    }, [chatId, remoteDesktopAvailable, sessionId]);
    const recordingFrameCount = recordingFrames.length;
    const recordingVideo = recordingState?.video ?? null;
    const recordingVideoUrl = recordingVideo
        ? (recordingVideo.fileUri || getBrowserAgentRecordingVideoUrl({ sessionId, chatId }))
        : '';
    const recordingDownloadUrl = recordingVideo
        ? (recordingVideo.downloadUri || getBrowserAgentRecordingVideoUrl({ sessionId, chatId, download: true }))
        : '';
    const selectedRecordingFrame = recordingFrameCount > 0
        ? recordingFrames[Math.min(recordingIndex, recordingFrameCount - 1)]
        : null;
    const recordingTimestampLabel = useMemo(
        () => formatRecordingTimestamp(selectedRecordingFrame?.timestamp),
        [selectedRecordingFrame?.timestamp],
    );
    const playbackImageUrl = selectedRecordingFrame?.imageBase64
        ? `data:image/jpeg;base64,${selectedRecordingFrame.imageBase64}`
        : '';

    useEffect(() => {
        if (!isEditingAddress) {
            setAddressText(String(sessionSnapshot?.currentUrl ?? currentUrl).trim());
        }
    }, [currentUrl, isEditingAddress, sessionSnapshot?.currentUrl]);

    useEffect(() => {
        if (!liveSessionLikely) {
            setOptimisticControlMode('');
            return;
        }

        if (optimisticControlMode && optimisticControlMode === remoteControlMode) {
            setOptimisticControlMode('');
        }
    }, [liveSessionLikely, optimisticControlMode, remoteControlMode]);

    useEffect(() => {
        if (!sessionId || !chatId) {
            setSessionAvailable(false);
            return undefined;
        }

        let cancelled = false;
        let timeoutId = null;

        const refresh = async () => {
            try {
                const result = await fetchBrowserAgentSession({ sessionId, chatId });
                if (!cancelled) {
                    setSessionSnapshot(result);
                    setSessionAvailable(true);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown browser session.';
                if (!cancelled && message.toLowerCase().includes('unknown browser session')) {
                    setSessionAvailable(false);
                }
            } finally {
                if (!cancelled && liveSessionLikely) {
                    timeoutId = setTimeout(() => {
                        void refresh();
                    }, 2500);
                }
            }
        };

        void refresh();
        return () => {
            cancelled = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
        };
    }, [chatId, liveSessionLikely, sessionId]);

    useEffect(() => {
        setRecordingState(null);
        setRecordingFrames([]);
        setRecordingIndex(0);
        setIsRecordingLoading(false);
    }, [sessionId]);

    useEffect(() => {
        if (!liveStreamUrl) {
            setIsPreviewConnecting(false);
            return;
        }

        setIsPreviewConnecting(true);
    }, [liveStreamUrl]);

    useEffect(() => {
        if (!liveSessionLikely) {
            setIsPreviewConnecting(false);
            return;
        }

        if (Number(livePreview?.lastFrameAt) > 0) {
            setIsPreviewConnecting(false);
        }
    }, [livePreview?.lastFrameAt, liveSessionLikely]);

    useEffect(() => {
        const target = vncTargetRef.current;
        if (!remoteDesktopAvailable || !remoteDesktopWsUrl || !target) {
            setRemoteDesktopStatus(remoteDesktopAvailable ? 'connecting' : 'idle');
            setRemoteDesktopError('');
            if (rfbRef.current) {
                try {
                    rfbRef.current.disconnect();
                } catch {
                    // ignore disconnect failures
                }
                rfbRef.current = null;
            }
            if (target) {
                target.replaceChildren();
            }
            return undefined;
        }

        target.replaceChildren();
        setRemoteDesktopStatus('connecting');
        setRemoteDesktopError('');
        let disposed = false;
        let rfb = null;
        let handleConnect = null;
        let handleDisconnect = null;
        let handleSecurityFailure = null;
        let handleCredentialsRequired = null;

        void import('../../vendor/novnc/lib/rfb.js')
            .then((module) => {
                if (disposed) {
                    return;
                }

                const RFB = module.default ?? module;
                rfb = new RFB(target, remoteDesktopWsUrl, { shared: true });
                rfb.scaleViewport = true;
                rfb.clipViewport = true;
                rfb.resizeSession = false;
                rfb.showDotCursor = true;
                rfb.focusOnClick = true;
                rfb.qualityLevel = 8;
                rfb.compressionLevel = 2;
                rfb.viewOnly = true;
                rfbRef.current = rfb;

                handleConnect = () => {
                    setRemoteDesktopStatus('connected');
                    setRemoteDesktopError('');
                };
                handleDisconnect = (event) => {
                    setRemoteDesktopStatus('error');
                    const clean = event?.detail?.clean !== false;
                    setRemoteDesktopError(clean ? '' : 'Remote desktop disconnected unexpectedly.');
                };
                handleSecurityFailure = (event) => {
                    setRemoteDesktopStatus('error');
                    setRemoteDesktopError(String(event?.detail?.reason ?? 'Remote desktop security failed.'));
                };
                handleCredentialsRequired = () => {
                    setRemoteDesktopStatus('error');
                    setRemoteDesktopError('Remote desktop requested credentials unexpectedly.');
                };

                rfb.addEventListener('connect', handleConnect);
                rfb.addEventListener('disconnect', handleDisconnect);
                rfb.addEventListener('securityfailure', handleSecurityFailure);
                rfb.addEventListener('credentialsrequired', handleCredentialsRequired);
            })
            .catch((error) => {
                if (!disposed) {
                    setRemoteDesktopStatus('error');
                    setRemoteDesktopError(
                        error instanceof Error ? error.message : 'Failed to load remote desktop client.',
                    );
                }
            });

        return () => {
            disposed = true;
            if (rfb && handleConnect) {
                rfb.removeEventListener('connect', handleConnect);
            }
            if (rfb && handleDisconnect) {
                rfb.removeEventListener('disconnect', handleDisconnect);
            }
            if (rfb && handleSecurityFailure) {
                rfb.removeEventListener('securityfailure', handleSecurityFailure);
            }
            if (rfb && handleCredentialsRequired) {
                rfb.removeEventListener('credentialsrequired', handleCredentialsRequired);
            }
            if (rfbRef.current === rfb) {
                rfbRef.current = null;
            }
            try {
                rfb?.disconnect();
            } catch {
                // ignore disconnect failures
            }
            target.replaceChildren();
        };
    }, [remoteDesktopAvailable, remoteDesktopWsUrl]);

    useEffect(() => {
        const rfb = rfbRef.current;
        if (!rfb) {
            return;
        }

        rfb.viewOnly = panelControlMode !== 'user';
        if (panelControlMode === 'user') {
            rfb.focus();
        }
    }, [panelControlMode]);

    useEffect(() => {
        if (!sessionId || !chatId || liveSessionLikely) {
            setIsRecordingLoading(false);
            return undefined;
        }

        let cancelled = false;

        const loadRecording = async () => {
            setIsRecordingLoading(true);
            try {
                const result = await fetchBrowserAgentRecording({
                    sessionId,
                    chatId,
                    limit: 120,
                });
                if (!cancelled) {
                    setRecordingState(result?.recording ?? null);
                    const frames = Array.isArray(result?.frames) ? result.frames : [];
                    setRecordingFrames(frames);
                    setRecordingIndex(frames.length > 0 ? frames.length - 1 : 0);
                }
            } catch {
                if (!cancelled) {
                    setRecordingState(null);
                    setRecordingFrames([]);
                    setRecordingIndex(0);
                }
            } finally {
                if (!cancelled) {
                    setIsRecordingLoading(false);
                }
            }
        };

        void loadRecording();
        return () => {
            cancelled = true;
        };
    }, [chatId, liveSessionLikely, sessionId]);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(Boolean(document.fullscreenElement && panelRef.current && document.fullscreenElement.contains(panelRef.current)));
        };

        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
        };
    }, []);

    const runAction = useCallback(async (action, extra = {}) => {
        if (!sessionId || !chatId || !liveSessionLikely) {
            return false;
        }

        setIsPending(true);
        setErrorMessage('');
        try {
            await controlBrowserAgentSession({
                sessionId,
                chatId,
                action,
                ...extra,
            });
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Browser control failed.';
            if (String(message).toLowerCase().includes('unknown browser session')) {
                setSessionAvailable(false);
            }
            setErrorMessage(message);
            return false;
        } finally {
            setIsPending(false);
        }
    }, [chatId, liveSessionLikely, sessionId]);

    const handleContinue = useCallback(async ({ requireNote = false } = {}) => {
        if (!sessionId || !chatId || !liveSessionLikely) {
            return false;
        }
        if (!canSteerDirectly && panelControlMode !== 'user') {
            return false;
        }

        const note = steerText.trim();
        if (requireNote && !note) {
            return false;
        }

        setIsPending(true);
        setErrorMessage('');
        try {
            await continueBrowserAgentSessionRequest({
                sessionId,
                chatId,
                clientId,
                note,
            });
            setSteerText('');
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to continue Browser Agent.';
            if (String(message).toLowerCase().includes('unknown browser session')) {
                setSessionAvailable(false);
            }
            setErrorMessage(message);
            return false;
        } finally {
            setIsPending(false);
        }
    }, [canSteerDirectly, chatId, clientId, liveSessionLikely, panelControlMode, sessionId, steerText]);

    const handleTakeControl = useCallback(async () => {
        if (panelControlMode !== 'user') {
            setOptimisticControlMode('user');
            const succeeded = await runAction('take_control');
            if (!succeeded) {
                setOptimisticControlMode('');
            }
            return;
        }

        if (shouldResumeOnRelease) {
            setOptimisticControlMode('agent');
            const succeeded = await handleContinue();
            if (!succeeded) {
                setOptimisticControlMode('user');
            }
            return;
        }

        setOptimisticControlMode('agent');
        const succeeded = await runAction('release_control');
        if (!succeeded) {
            setOptimisticControlMode('user');
        }
    }, [handleContinue, panelControlMode, runAction, shouldResumeOnRelease]);

    useEffect(() => {
        if (panelControlMode !== 'user' || !liveSessionLikely || remoteDesktopAvailable) {
            return undefined;
        }

        const handleKeyDown = (event) => {
            if (event.defaultPrevented || isPending || isTextEntryTarget(event.target)) {
                return;
            }

            let action = '';
            let extra = null;

            if (event.key === 'ArrowUp' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
                action = 'scroll_up';
            } else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
                action = 'scroll_down';
            } else if (event.altKey && event.key === 'ArrowLeft') {
                action = 'go_back';
            } else if (event.altKey && event.key === 'ArrowRight') {
                action = 'go_forward';
            } else if (event.key === 'F5' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r')) {
                action = 'reload';
            } else if (event.key === 'Enter') {
                action = 'press_key';
                extra = { key: 'Enter' };
            } else if (event.key === 'Tab') {
                action = 'press_key';
                extra = { key: 'Tab' };
            } else if (event.key === 'Escape') {
                action = 'press_key';
                extra = { key: 'Escape' };
            }

            if (!action) {
                return;
            }

            event.preventDefault();
            void runAction(action, extra ?? {});
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isPending, liveSessionLikely, panelControlMode, remoteDesktopAvailable, runAction]);

    const handleTypeIntoPage = useCallback(async () => {
        const text = typingText.trim();
        if (!text) {
            return;
        }
        await runAction('type', { text });
        setTypingText('');
    }, [runAction, typingText]);

    const handleNavigate = useCallback(async () => {
        const normalizedUrl = normalizeNavigateUrl(addressText);
        if (!normalizedUrl) {
            return;
        }

        setIsPreviewConnecting(true);
        const succeeded = await runAction('navigate', { url: normalizedUrl });
        if (!succeeded) {
            setIsPreviewConnecting(false);
            return;
        }
        setAddressText(normalizedUrl);
        setIsEditingAddress(false);
        addressInputRef.current?.blur();
    }, [addressText, runAction]);

    const handleRefresh = useCallback(async () => {
        setIsPreviewConnecting(true);
        const succeeded = await runAction('reload');
        if (!succeeded) {
            setIsPreviewConnecting(false);
        }
    }, [runAction]);

    const handlePreviewClick = useCallback((event) => {
        if (remoteDesktopAvailable || panelControlMode !== 'user' || !liveSessionLikely || isPending) {
            return;
        }

        const image = imageRef.current;
        if (!image) {
            return;
        }

        const rect = image.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }

        const relativeX = (event.clientX - rect.left) / rect.width;
        const relativeY = (event.clientY - rect.top) / rect.height;
        if (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1) {
            return;
        }

        const x = Math.max(0, Math.min(viewport.width - 1, Math.round(relativeX * viewport.width)));
        const y = Math.max(0, Math.min(viewport.height - 1, Math.round(relativeY * viewport.height)));
        runAction('click', { x, y });
    }, [isPending, liveSessionLikely, panelControlMode, remoteDesktopAvailable, runAction, viewport.height, viewport.width]);

    const toggleFullscreen = useCallback(async () => {
        const node = panelRef.current;
        if (!node) {
            return;
        }

        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else {
                await node.requestFullscreen();
            }
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : 'Fullscreen is not available.');
        }
    }, []);

    return (
        <div className="browser-agent-panel" ref={panelRef}>
            <div className="browser-agent-panel-main">
                <section className={`browser-agent-live-shell${isFullscreen ? ' is-fullscreen' : ''}`}>
                <div className="browser-agent-live-toolbar">
                    <div className="browser-agent-live-meta">
                        <strong>Live Browser</strong>
                        <span>{viewport.width} x {viewport.height}</span>
                        {sessionExpiryLabel && <span>{sessionExpiryLabel}</span>}
                        <span className={`browser-agent-preview-badge${previewHealthy ? ' is-healthy' : ' is-stalled'}`}>
                            {previewStatusLabel}
                        </span>
                    </div>
                    <div className="browser-agent-live-actions">
                        <button type="button" onClick={toggleFullscreen}>Fullscreen</button>
                        <button
                            type="button"
                            onClick={handleTakeControl}
                            className={panelControlMode === 'user' ? 'active' : ''}
                            disabled={!liveSessionLikely}
                        >
                            {panelControlMode === 'user'
                                ? (shouldResumeOnRelease ? 'Resume agent' : 'Release control')
                                : 'Take control'}
                        </button>
                    </div>
                </div>
                {remoteDesktopAvailable ? (
                    <div className="browser-agent-vnc-status-row">
                        <div className="browser-agent-vnc-status-copy">
                            Full Chrome is running inside a private Linux display.
                        </div>
                        <div className={`browser-agent-address-status${remoteDesktopStatus === 'connecting' ? ' is-loading' : ''}`}>
                            {addressStatusLabel}
                        </div>
                    </div>
                ) : (
                    <div className="browser-agent-address-row">
                        <input
                            ref={addressInputRef}
                            type="text"
                            value={addressText}
                            onChange={(event) => setAddressText(event.target.value)}
                            onFocus={(event) => {
                                const input = event.currentTarget;
                                setIsEditingAddress(true);
                                requestAnimationFrame(() => {
                                    input.select();
                                });
                            }}
                            onBlur={() => setIsEditingAddress(false)}
                            placeholder="Enter URL"
                            disabled={isPending || !liveSessionLikely}
                            title={currentUrl || addressText}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void handleNavigate();
                                }
                            }}
                        />
                        <button
                            type="button"
                            onClick={() => {
                                void handleRefresh();
                            }}
                            disabled={isPending || !liveSessionLikely}
                        >
                            Refresh
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void handleNavigate();
                            }}
                            disabled={isPending || !liveSessionLikely || !addressText.trim()}
                        >
                            Go
                        </button>
                        <div className={`browser-agent-address-status${isPreviewConnecting ? ' is-loading' : ''}`}>
                            {addressStatusLabel}
                        </div>
                    </div>
                )}
                <div
                    className={`browser-agent-live-stage${panelControlMode === 'user' ? ' is-user-control' : ''}`}
                    onClick={handlePreviewClick}
                >
                    {remoteDesktopAvailable
                        ? (
                            <div
                                ref={vncTargetRef}
                                className={`browser-agent-live-vnc${panelControlMode === 'user' ? ' is-interactive' : ' is-view-only'}`}
                            />
                        )
                        : liveStreamUrl
                        ? (
                            <img
                                ref={imageRef}
                                src={liveStreamUrl}
                                alt="Browser live preview"
                                className="browser-agent-live-image"
                                onLoad={() => {
                                    setIsPreviewConnecting(false);
                                }}
                                onError={() => {
                                    setIsPreviewConnecting(false);
                                }}
                            />
                        )
                        : recordingVideoUrl
                            ? (
                                <video
                                    className="browser-agent-live-video"
                                    src={recordingVideoUrl}
                                    controls
                                    preload="metadata"
                                    playsInline
                                />
                        )
                            : playbackImageUrl
                            ? <img ref={imageRef} src={playbackImageUrl} alt="Recorded Browser Agent preview" className="browser-agent-live-image" />
                            : <div className="browser-agent-live-empty">{isRecordingLoading ? 'Loading recorded browser run...' : (sessionAvailable && sessionLive ? 'Live preview unavailable.' : 'Browser session is no longer live.')}</div>}
                    {panelControlMode === 'user' && liveSessionLikely && remoteDesktopAvailable && (
                        <div className="browser-agent-live-overlay">
                            The browser is fully interactive here. Click once to focus it, then use your keyboard and mouse directly.
                        </div>
                    )}
                    {panelControlMode === 'user' && liveSessionLikely && !remoteDesktopAvailable && (
                        <div className="browser-agent-live-overlay">
                            Click inside the preview to control the page directly.
                        </div>
                    )}
                </div>
                </section>

                {!liveSessionLikely && (recordingVideo || recordingFrameCount > 0) && (
                    <section className="browser-agent-recording">
                        <div className="browser-agent-recording-meta">
                            <strong>Recorded Browser Run</strong>
                            {recordingVideo
                                ? <span>{recordingVideo.mimeType === 'video/mp4' ? 'MP4' : 'WEBM'}</span>
                                : <span>Frame {recordingIndex + 1} / {recordingFrameCount}</span>}
                            {!recordingVideo && recordingTimestampLabel && <span>{recordingTimestampLabel}</span>}
                        </div>
                        {recordingVideo && (
                            <>
                                <div className="browser-agent-recording-links">
                                    <a href={recordingVideoUrl} target="_blank" rel="noreferrer">Open video</a>
                                    <a href={recordingDownloadUrl}>Download</a>
                                </div>
                                <div
                                    className="browser-agent-recording-path"
                                    title={recordingVideo.localPath}
                                >
                                    {recordingVideo.localPath}
                                </div>
                            </>
                        )}
                        {!recordingVideo && (
                            <input
                                type="range"
                                min="0"
                                max={Math.max(recordingFrameCount - 1, 0)}
                                value={Math.min(recordingIndex, Math.max(recordingFrameCount - 1, 0))}
                                onChange={(event) => setRecordingIndex(Number(event.target.value) || 0)}
                                className="browser-agent-recording-slider"
                            />
                        )}
                        <div className="browser-agent-recording-note">
                            Only Browser Agent activity is recorded. Manual control is not included.
                        </div>
                    </section>
                )}

                {sessionAvailable && sessionExpiryLabel && panelControlMode !== 'user' && (
                    <div className="browser-agent-request-note">
                        Browser stays open temporarily after the task finishes, so you can take control or send a follow-up step.
                    </div>
                )}

                {(!sessionAvailable || !sessionLive) && (isRecordingLoading || recordingVideo || recordingFrameCount > 0) && (
                    <div className="browser-agent-request-note">
                        {isRecordingLoading
                            ? 'This browser session is no longer live. Loading the recorded Browser Agent run.'
                            : 'This browser session is no longer live. Live controls are disabled, but you can review the recorded Browser Agent run below.'}
                    </div>
                )}

                {previewHealthy === false && sessionAvailable && sessionLive && !remoteDesktopAvailable && (
                    <div className="browser-agent-request-note">
                        Live preview is currently lagging or stalled.
                    </div>
                )}

                {liveSessionLikely && !remoteDesktopAvailable && remoteDesktopEnabled && remoteDesktop?.reason && (
                    <div className="browser-agent-request-note">
                        Linux remote desktop is unavailable: {remoteDesktop.reason}
                    </div>
                )}

                {liveSessionLikely && userAction?.required && (
                    <section className={`browser-agent-request browser-agent-request-${questionType}`}>
                        <div className="browser-agent-request-label">{formatQuestionType(questionType)}</div>
                        <div className="browser-agent-request-text">{userAction.question || 'Browser Agent needs your help.'}</div>
                        {!directToUser && (
                            <div className="browser-agent-request-note">
                                This will be handled through the Orchestrator chat, not directly in the browser panel.
                            </div>
                        )}
                    </section>
                )}

                {liveSessionLikely && (panelControlMode === 'user' || directToUser || canSteerDirectly) && (
                    <section className="browser-agent-controls">
                        {panelControlMode === 'user' && remoteDesktopAvailable && (
                            <div className="browser-agent-request-note">
                                Keyboard and mouse are attached directly to the live Chrome window in the preview above.
                                {remoteDesktopError ? ` ${remoteDesktopError}` : ''}
                            </div>
                        )}
                        {panelControlMode === 'user' && !remoteDesktopAvailable && (
                            <>
                                <div className="browser-agent-control-grid">
                                    <button type="button" onClick={() => runAction('scroll_up')} disabled={isPending || !liveSessionLikely}>Scroll Up</button>
                                    <button type="button" onClick={() => runAction('scroll_down')} disabled={isPending || !liveSessionLikely}>Scroll Down</button>
                                    <button type="button" onClick={() => runAction('go_back')} disabled={isPending || !liveSessionLikely}>Back</button>
                                    <button type="button" onClick={() => runAction('go_forward')} disabled={isPending || !liveSessionLikely}>Forward</button>
                                    <button type="button" onClick={() => runAction('reload')} disabled={isPending || !liveSessionLikely}>Reload</button>
                                    <button type="button" onClick={() => runAction('press_key', { key: 'Enter' })} disabled={isPending || !liveSessionLikely}>Enter</button>
                                    <button type="button" onClick={() => runAction('press_key', { key: 'Tab' })} disabled={isPending || !liveSessionLikely}>Tab</button>
                                    <button type="button" onClick={() => runAction('press_key', { key: 'Escape' })} disabled={isPending || !liveSessionLikely}>Esc</button>
                                </div>
                                <div className="browser-agent-input-row">
                                    <input
                                        type="text"
                                        value={typingText}
                                        onChange={(event) => setTypingText(event.target.value)}
                                        placeholder="Type into the focused field and press Enter"
                                        disabled={isPending || !liveSessionLikely}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' && typingText.trim()) {
                                                event.preventDefault();
                                                void handleTypeIntoPage();
                                            }
                                        }}
                                    />
                                </div>
                                <div className="browser-agent-shortcuts">
                                    Keyboard: Up/Down scroll, Alt+Left/Right history, Cmd/Ctrl+R reload, Enter, Tab, Esc.
                                </div>
                            </>
                        )}

                        <div className="browser-agent-input-row">
                            <input
                                type="text"
                                value={steerText}
                                onChange={(event) => setSteerText(event.target.value)}
                                placeholder={
                                    panelControlMode === 'user'
                                        ? (shouldResumeOnRelease
                                            ? 'Optional note before resuming'
                                            : 'Write a follow-up task for Browser Agent')
                                        : canSteerDirectly
                                            ? 'Steer Browser Agent'
                                            : 'Reply through chat with Orchestrator'
                                }
                                disabled={isPending || !liveSessionLikely || !canSteerDirectly}
                                onKeyDown={(event) => {
                                    if (
                                        event.key === 'Enter'
                                        && canSteerDirectly
                                        && (!needsNoteForBottomAction || steerText.trim())
                                    ) {
                                        event.preventDefault();
                                        void handleContinue({ requireNote: needsNoteForBottomAction });
                                    }
                                }}
                            />
                            <button
                                type="button"
                                onClick={() => {
                                    void handleContinue({ requireNote: needsNoteForBottomAction });
                                }}
                                disabled={
                                    isPending
                                    || !liveSessionLikely
                                    || !canSteerDirectly
                                    || (needsNoteForBottomAction && !steerText.trim())
                                }
                            >
                                {getContinueLabel({ controlMode: panelControlMode, questionType, shouldResumeOnRelease })}
                            </button>
                        </div>
                        {!canSteerDirectly && (
                            <div className="browser-agent-request-note">
                                This question should be answered in chat through the Orchestrator.
                            </div>
                        )}
                        {errorMessage && <div className="browser-agent-error">{errorMessage}</div>}
                    </section>
                )}
            </div>

            <BrowserActivityLog
                entries={activityLog}
                title="Activity Log"
                className="browser-agent-panel-log"
                autoScroll
            />
        </div>
    );
}
