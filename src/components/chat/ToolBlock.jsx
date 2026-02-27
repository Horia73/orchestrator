import { useEffect, useMemo, useState } from 'react';
import { fetchCommandStatus } from '../../api/chatApi.js';
import { getAgentToolMetadata } from './agentCallUtils.js';
import './ToolBlock.css';

const COMMAND_TOOL_NAMES = new Set([
    'run_command',
    'command_status',
    'send_command_input',
    'read_terminal',
]);
const COMMAND_OUTPUT_CHARS = 32_000;
const EMPTY_ARGS = Object.freeze({});

function parseTimestamp(value) {
    const millis = Date.parse(String(value ?? ''));
    if (!Number.isFinite(millis)) return null;
    return millis;
}

function formatJson(value) {
    try {
        return JSON.stringify(value ?? {}, null, 2);
    } catch {
        return '{}';
    }
}

function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    return `${Math.floor(safeSeconds)}s`;
}

function getCommandText(toolName, args, runtimeSnapshot) {
    if (typeof runtimeSnapshot?.command === 'string' && runtimeSnapshot.command.trim()) {
        return runtimeSnapshot.command.trim();
    }

    if (toolName === 'run_command') {
        return String(args?.CommandLine ?? '').trim();
    }

    return '';
}

function getCommandId(args, runtimeSnapshot, responseObject) {
    const responseId = String(runtimeSnapshot?.commandId ?? responseObject?.commandId ?? '').trim();
    if (responseId) return responseId;

    const argId = String(args?.CommandId ?? '').trim();
    return argId;
}

function getCommandStatusLabel(isRunning, status, hasError) {
    if (hasError) return 'error';
    if (isRunning) return 'running';
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'terminated') return 'stopped';
    return 'done';
}

function getAgentThoughtText(responseObject) {
    if (!responseObject || typeof responseObject !== 'object') {
        return '';
    }

    return String(responseObject.agentThought ?? responseObject.thought ?? '').trim();
}

function normalizeAgentStatus({ isExecuting, hasResponse, responseObject, hasError }) {
    const rawStatus = String(responseObject?.status ?? '').trim().toLowerCase();
    const responseError = String(responseObject?.error ?? '').trim().toLowerCase();
    const hasAgentThought = getAgentThoughtText(responseObject).length > 0;

    if (isExecuting && !hasResponse) {
        return hasAgentThought ? 'thinking' : 'working';
    }

    if (rawStatus === 'stopped') {
        return 'stopped';
    }

    if (responseError.includes('stopped')) {
        return 'stopped';
    }

    if (rawStatus === 'thinking') {
        return 'thinking';
    }

    if (rawStatus === 'working') {
        return 'working';
    }

    if (
        hasError
        || rawStatus === 'error'
        || responseError.includes('failed')
        || responseError.includes('error')
    ) {
        return 'error';
    }

    if (
        hasResponse
        || rawStatus === 'completed'
        || rawStatus === 'done'
        || rawStatus === 'success'
        || rawStatus === 'ok'
    ) {
        return 'done';
    }

    return 'working';
}

function formatAgentStatusLabel(status) {
    if (status === 'thinking') return 'Thinking...';
    if (status === 'working') return 'Working...';
    if (status === 'done') return 'Done';
    if (status === 'stopped') return 'Stopped';
    if (status === 'error') return 'Failed';
    return 'Working...';
}

export function ToolBlock({
    functionCall,
    functionResponse,
    isExecuting,
    onAgentCallToggle,
    isAgentCallOpen = false,
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [polledSnapshot, setPolledSnapshot] = useState(null);
    const [nowMs, setNowMs] = useState(0);
    const hasFunctionCall = !!functionCall;
    const call = functionCall ?? {};

    const hasResponse = !!functionResponse;
    const name = call.name || 'unknown_tool';
    const agentMeta = getAgentToolMetadata(name);
    const isAgentTool = !!agentMeta;
    const args = call.args && typeof call.args === 'object'
        ? call.args
        : EMPTY_ARGS;
    const responseObject = functionResponse?.response ?? null;
    const hasError = typeof responseObject?.error === 'string' && responseObject.error.trim().length > 0;
    const isCommandTool = COMMAND_TOOL_NAMES.has(name);
    const isRunCommandTool = name === 'run_command';
    const responseSnapshot = responseObject && typeof responseObject === 'object'
        ? responseObject
        : null;
    const runtimeSnapshot = polledSnapshot ?? responseSnapshot;
    const agentStatus = normalizeAgentStatus({
        isExecuting,
        hasResponse,
        responseObject,
        hasError,
    });

    const commandId = useMemo(
        () => getCommandId(args, runtimeSnapshot, responseObject),
        [args, runtimeSnapshot, responseObject],
    );

    const commandText = useMemo(
        () => getCommandText(name, args, runtimeSnapshot),
        [name, args, runtimeSnapshot],
    );
    const hasCommandId = Boolean(commandId);
    const supportsLiveTracking = isRunCommandTool;

    const hasPolledSnapshot = polledSnapshot && typeof polledSnapshot === 'object';
    const runtimeStatus = String(runtimeSnapshot?.status ?? '').trim().toLowerCase();
    const runtimeRunning = (
        runtimeSnapshot?.running === true || runtimeStatus === 'running'
    ) && (!supportsLiveTracking || hasCommandId);
    const isCommandRunning = isRunCommandTool && (
        runtimeRunning
        || (isExecuting && !hasResponse && !hasPolledSnapshot)
    );
    const isRunning = isRunCommandTool
        ? isCommandRunning
        : (isExecuting && !hasResponse);

    useEffect(() => {
        if (!(supportsLiveTracking && isCommandRunning)) return undefined;

        const intervalId = setInterval(() => {
            setNowMs(Date.now());
        }, 1000);
        return () => clearInterval(intervalId);
    }, [supportsLiveTracking, isCommandRunning]);

    const elapsedSeconds = useMemo(() => {
        if (!isCommandTool) return 0;
        const durationMs = Number(runtimeSnapshot?.durationMs ?? responseObject?.durationMs);
        if (!supportsLiveTracking && Number.isFinite(durationMs) && durationMs >= 0) {
            return Math.floor(durationMs / 1000);
        }

        if (!isCommandRunning && Number.isFinite(durationMs) && durationMs >= 0) {
            return Math.floor(durationMs / 1000);
        }

        const parsedStart = parseTimestamp(runtimeSnapshot?.startedAt ?? responseObject?.startedAt);
        if (!parsedStart) return 0;

        if (!supportsLiveTracking) return 0;

        if (!Number.isFinite(nowMs) || nowMs <= 0) return 0;
        return Math.max(0, Math.floor((nowMs - parsedStart) / 1000));
    }, [isCommandTool, supportsLiveTracking, isCommandRunning, runtimeSnapshot?.durationMs, responseObject?.durationMs, runtimeSnapshot?.startedAt, responseObject?.startedAt, nowMs]);

    const shouldPollCommand = supportsLiveTracking && Boolean(commandId) && (
        runtimeRunning
        || (isExecuting && !hasResponse && !hasPolledSnapshot)
    );

    useEffect(() => {
        if (!shouldPollCommand) return undefined;

        let cancelled = false;
        let delayTimer = null;

        const runPolling = async () => {
            while (!cancelled) {
                try {
                    const nextSnapshot = await fetchCommandStatus({
                        commandId,
                        waitSeconds: 1,
                        chars: COMMAND_OUTPUT_CHARS,
                    });
                    if (cancelled) return;

                    setPolledSnapshot(nextSnapshot);
                    if (nextSnapshot?.running !== true) return;
                } catch {
                    setPolledSnapshot((current) => {
                        const base = current && typeof current === 'object' ? current : {};
                        return {
                            ...base,
                            commandId: commandId || base.commandId,
                            running: false,
                            status: base.status === 'running' ? 'unknown' : (base.status || 'unknown'),
                        };
                    });
                    return;
                }

                await new Promise((resolve) => {
                    delayTimer = setTimeout(resolve, 200);
                });
            }
        };

        runPolling();

        return () => {
            cancelled = true;
            if (delayTimer) clearTimeout(delayTimer);
        };
    }, [shouldPollCommand, commandId]);

    const commandStatusLabel = getCommandStatusLabel(
        isRunCommandTool ? isCommandRunning : false,
        runtimeStatus,
        hasError,
    );
    let titleMain = `Used ${name}`;
    let titleDetail = '';

    if (isAgentTool) {
        if (agentStatus === 'thinking' || agentStatus === 'working') {
            titleMain = `Calling ${agentMeta.agentName}`;
        } else if (agentStatus === 'stopped') {
            titleMain = `${agentMeta.agentName} stopped`;
        } else if (agentStatus === 'error') {
            titleMain = `${agentMeta.agentName} failed`;
        } else {
            titleMain = `Called ${agentMeta.agentName}`;
        }
        titleDetail = String(args?.prompt ?? '').trim();
    } else if (name === 'run_command') {
        if (isCommandRunning) {
            titleMain = 'Running command';
        } else if (commandStatusLabel === 'stopped') {
            titleMain = 'Stopped';
        } else {
            titleMain = 'Ran command';
        }
        titleDetail = commandText || commandId || '';
    } else if (name === 'command_status') {
        if (commandStatusLabel === 'stopped') {
            titleMain = 'Stopped';
        } else if (commandStatusLabel === 'failed' || commandStatusLabel === 'error') {
            titleMain = 'Command status failed';
        } else if (commandStatusLabel === 'completed') {
            titleMain = 'Command completed';
        } else if (isExecuting && !hasResponse) {
            titleMain = 'Checking command status';
        } else {
            titleMain = 'Command status';
        }
        titleDetail = commandId || commandText || '';
    } else if (name === 'send_command_input') {
        if (commandStatusLabel === 'stopped') {
            titleMain = 'Stopped';
        } else if (commandStatusLabel === 'failed' || commandStatusLabel === 'error') {
            titleMain = 'Command input failed';
        } else if (isExecuting && !hasResponse) {
            titleMain = 'Sending command input';
        } else {
            titleMain = 'Sent command input';
        }
        titleDetail = commandId || commandText || '';
    } else if (name === 'read_terminal') {
        titleMain = isExecuting && !hasResponse ? 'Reading terminal' : 'Read terminal';
        titleDetail = commandId || commandText || '';
    } else if (name === 'read_url_content') {
        if (isExecuting && !hasResponse) {
            titleMain = 'Fetching URL...';
        } else if (hasResponse) {
            titleMain = hasError ? 'Failed to fetch URL' : 'Fetched URL';
        }
        titleDetail = String(args?.Url ?? '').trim();
    } else if (name === 'search_web') {
        if (isExecuting && !hasResponse) {
            titleMain = 'Searching web...';
        } else if (hasResponse) {
            titleMain = hasError ? 'Web search failed' : 'Searched web';
        }
        titleDetail = String(args?.query ?? '').trim();
    }

    const terminalOutput = String(runtimeSnapshot?.output ?? responseObject?.output ?? '');
    const commandLine = commandText || String(responseObject?.command ?? '').trim();
    const terminalContent = hasError
        ? String(responseObject.error)
        : (terminalOutput || (isRunCommandTool && isCommandRunning ? 'Waiting for command output...' : 'No terminal output.'));

    const commandInputPreview = String(args?.Input ?? '');
    const hasCommandOutput = terminalOutput.trim().length > 0;

    const hasDuration = Number.isFinite(Number(runtimeSnapshot?.durationMs ?? responseObject?.durationMs));
    const shouldShowCommandMeta = isCommandTool && (supportsLiveTracking || hasDuration);
    const summaryData = hasResponse
        ? (typeof responseObject === 'object' ? formatJson(responseObject) : String(responseObject))
        : null;
    const canToggleAgentPanel = isAgentTool && typeof onAgentCallToggle === 'function';
    const handleHeaderClick = () => {
        if (canToggleAgentPanel) {
            onAgentCallToggle();
            return;
        }
        setIsOpen((current) => !current);
    };

    if (!hasFunctionCall) return null;

    return (
        <div className={`tool-block${isAgentTool ? ' agent-call' : ''}${isAgentCallOpen ? ' is-active' : ''}`}>
            <div className="tool-block-header" onClick={handleHeaderClick}>
                <div className="tool-block-title">
                    <span className={`tool-name${isRunning ? ' status-running-text' : ''}`}>
                        {titleMain}
                    </span>
                    {titleDetail && (
                        <span className="tool-command-preview" title={titleDetail}>
                            {titleDetail}
                        </span>
                    )}
                </div>

                <div className="tool-block-right">
                    {isAgentTool && (
                        <span className={`tool-agent-status status-${agentStatus}`}>
                            {formatAgentStatusLabel(agentStatus)}
                        </span>
                    )}
                    {canToggleAgentPanel && (
                        <div className={`tool-chevron ${isAgentCallOpen ? 'open' : ''}`}>
                            {isAgentCallOpen ? '▼' : '▶'}
                        </div>
                    )}
                    {shouldShowCommandMeta && (
                        <span className="tool-command-elapsed">
                            {formatDuration(elapsedSeconds)}
                        </span>
                    )}
                    {isRunning && <div className="tool-spinner" title="Tool is running..."></div>}
                    {!canToggleAgentPanel && (
                        <div className={`tool-chevron ${isOpen ? 'open' : ''}`}>
                            {isOpen ? '▲' : '▼'}
                        </div>
                    )}
                </div>
            </div>

            {isOpen && (
                <div className="tool-block-content">
                    {isCommandTool ? (
                        isRunCommandTool ? (
                            <div className="tool-terminal">
                                <div className="tool-terminal-head">
                                    <span className="tool-terminal-status">{commandStatusLabel}</span>
                                    {commandId && <span className="tool-terminal-id">{commandId}</span>}
                                </div>
                                <div className="tool-terminal-line">
                                    <span className="tool-terminal-prompt">$</span>
                                    <span className="tool-terminal-command">{commandLine || '(no command text)'}</span>
                                </div>
                                <div className="tool-terminal-output-wrap">
                                    <pre className="tool-terminal-output">{terminalContent}</pre>
                                    {isCommandRunning && <span className="tool-terminal-cursor">█</span>}
                                </div>
                            </div>
                        ) : (
                            <div className="tool-command-details">
                                <div className="tool-section">
                                    <div className="tool-section-title">Command</div>
                                    <pre>{commandLine || '(no command text in this snapshot)'}</pre>
                                </div>

                                {name === 'send_command_input' && (
                                    <>
                                        <div className="tool-section">
                                            <div className="tool-section-title">Input Sent</div>
                                            <pre>{commandInputPreview || '(empty)'}</pre>
                                        </div>
                                        <div className="tool-section">
                                            <div className="tool-section-title">Terminate Signal</div>
                                            <pre>{String(Boolean(args?.Terminate))}</pre>
                                        </div>
                                    </>
                                )}

                                <div className="tool-section">
                                    <div className="tool-section-title">Status</div>
                                    <pre>{commandStatusLabel}</pre>
                                </div>

                                {commandId && (
                                    <div className="tool-section">
                                        <div className="tool-section-title">Command ID</div>
                                        <pre>{commandId}</pre>
                                    </div>
                                )}

                                <div className="tool-section">
                                    <div className="tool-section-title">Output Snapshot</div>
                                    <pre>{hasCommandOutput ? terminalOutput : 'No output in this snapshot.'}</pre>
                                </div>

                                {hasResponse && (
                                    <div className="tool-section">
                                        <div className="tool-section-title">Raw Result</div>
                                        <pre>{summaryData}</pre>
                                    </div>
                                )}
                            </div>
                        )
                    ) : (
                        <>
                            <div className="tool-section">
                                <div className="tool-section-title">Arguments</div>
                                <pre>{formatJson(args)}</pre>
                            </div>
                            {hasResponse && (
                                <div className="tool-section">
                                    <div className="tool-section-title">Result</div>
                                    <pre>{summaryData}</pre>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
