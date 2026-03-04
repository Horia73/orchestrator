import { useEffect, useMemo, useRef, useState } from 'react';
import { IconPencil } from '../shared/icons.jsx';
import { captureCollapseScrollAnchor, restoreCollapseScrollAnchor } from './scrollAnchor.js';
import './ToolBlock.css';

function normalizePathValue(pathValue) {
    const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!rawPath) return '';

    const normalizedPath = rawPath.replace(/\\/g, '/');
    const withoutTrailingSlash = normalizedPath.endsWith('/')
        ? normalizedPath.slice(0, -1)
        : normalizedPath;

    return withoutTrailingSlash;
}

function getPathParts(pathValue) {
    const normalizedPath = normalizePathValue(pathValue);
    if (!normalizedPath) {
        return {
            fullPath: '',
            directory: '',
            name: 'file',
        };
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    const name = segments.pop() || normalizedPath;
    const directory = segments.length > 0 ? `${segments.join('/')}/` : '';

    return {
        fullPath: normalizedPath,
        directory,
        name,
    };
}

function getToolPath(entry) {
    const args = entry?.functionCall?.args ?? {};
    const response = entry?.functionResponse?.response ?? {};
    return response?.relativePath || response?.path || args?.TargetFile || '';
}

function getDelta(entry) {
    const response = entry?.functionResponse?.response ?? {};
    const added = Number(response?.addedLines ?? 0) || 0;
    const removed = Number(response?.removedLines ?? 0) || 0;
    return { added, removed };
}

function getOperation(entry) {
    const toolName = entry?.functionCall?.name ?? '';
    const response = entry?.functionResponse?.response ?? {};

    if (toolName === 'write_to_file' && response?.created) {
        return 'created';
    }

    return 'edited';
}

function getSummary(entries) {
    const files = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    let allAreCreated = entries.length > 0;
    let hasExecuting = false;
    let executingOnlyCreate = true;

    for (const entry of entries) {
        const toolPath = normalizePathValue(getToolPath(entry));
        files.push(toolPath);
        const delta = getDelta(entry);
        totalAdded += delta.added;
        totalRemoved += delta.removed;
        if (getOperation(entry) !== 'created') {
            allAreCreated = false;
        }

        const isExecuting = entry?.isExecuting === true && !entry?.functionResponse;
        if (isExecuting) {
            hasExecuting = true;
            if ((entry?.functionCall?.name ?? '') !== 'write_to_file') {
                executingOnlyCreate = false;
            }
        }
    }

    const uniqueFiles = [...new Set(files.filter(Boolean))];
    const primaryPath = uniqueFiles.length === 1 ? getPathParts(uniqueFiles[0]) : null;
    const primaryLabel = primaryPath
        ? primaryPath.fullPath
        : `${uniqueFiles.length} files`;

    let prefix = 'Edited';
    if (hasExecuting) {
        prefix = executingOnlyCreate ? 'Creating' : 'Editing';
    } else if (allAreCreated) {
        prefix = 'Created';
    }

    return {
        prefix,
        primaryLabel,
        primaryPath,
        totalAdded,
        totalRemoved,
        isRunning: hasExecuting,
    };
}

function renderDiffLineNumber(line) {
    if (line?.type === 'added') return String(line?.newLineNumber ?? '');
    if (line?.type === 'removed') return String(line?.oldLineNumber ?? '');
    return String(line?.lineNumber ?? '');
}

function renderDiffLineContent(line) {
    return String(line?.text ?? '');
}

function formatLineCount(value) {
    const count = Math.max(0, Number(value) || 0);
    return `${count} line${count === 1 ? '' : 's'}`;
}

export function EditManagementBlock({ entries = [] }) {
    const [isOpen, setIsOpen] = useState(false);
    const rootRef = useRef(null);
    const collapseAnchorRef = useRef(null);
    const restoreScrollCleanupRef = useRef(null);
    const summary = useMemo(() => getSummary(entries), [entries]);

    useEffect(() => () => {
        if (restoreScrollCleanupRef.current) {
            restoreScrollCleanupRef.current();
            restoreScrollCleanupRef.current = null;
        }
    }, []);

    const openEditList = () => {
        if (restoreScrollCleanupRef.current) {
            restoreScrollCleanupRef.current();
            restoreScrollCleanupRef.current = null;
        }
        collapseAnchorRef.current = captureCollapseScrollAnchor(rootRef.current);
        setIsOpen(true);
    };

    const closeEditList = () => {
        if (restoreScrollCleanupRef.current) {
            restoreScrollCleanupRef.current();
        }
        setIsOpen(false);
        restoreScrollCleanupRef.current = restoreCollapseScrollAnchor(collapseAnchorRef.current);
    };

    const toggleEditList = () => {
        if (isOpen) {
            closeEditList();
        } else {
            openEditList();
        }
    };

    return (
        <div ref={rootRef} className="edit-tools-block">
            <button
                type="button"
                className="edit-tools-header"
                onClick={toggleEditList}
            >
                <span className="tool-row-icon"><IconPencil /></span>
                <span className={`edit-tools-prefix${summary.isRunning ? ' status-running-text' : ''}`}>{summary.prefix}</span>
                {summary.primaryPath
                    ? (
                        <span className="edit-tools-target-group" title={summary.primaryPath.fullPath}>
                            {summary.primaryPath.directory && (
                                <span className="edit-tools-target-path">{summary.primaryPath.directory}</span>
                            )}
                            <span className="edit-tools-target-name">{summary.primaryPath.name}</span>
                        </span>
                    )
                    : (
                        <span className="edit-tools-target">{summary.primaryLabel}</span>
                    )}
                <span className="edit-tools-delta edit-tools-delta-add">+{summary.totalAdded}</span>
                <span className="edit-tools-delta edit-tools-delta-remove">-{summary.totalRemoved}</span>
                <span className={`edit-tools-chevron ${isOpen ? 'open' : ''}`}>▼</span>
            </button>

            {isOpen && (
                <div className="edit-tools-list">
                    {entries.map((entry, index) => {
                        const callId = typeof entry?.functionCall?.id === 'string'
                            ? entry.functionCall.id.trim()
                            : '';
                        const itemKey = callId || `${entry?.functionCall?.name ?? 'tool'}-${index}`;
                        const response = entry?.functionResponse?.response ?? {};
                        const toolName = String(entry?.functionCall?.name ?? '').trim();
                        const hasError = typeof response?.error === 'string' && response.error.trim().length > 0;
                        const diffLines = Array.isArray(response?.diffPreview?.lines)
                            ? response.diffPreview.lines
                            : [];
                        const isExecuting = entry?.isExecuting === true && !entry?.functionResponse;
                        const isCreatedFile = toolName === 'write_to_file' && response?.created === true;
                        const isOverwriteWrite = toolName === 'write_to_file' && response?.overwritten === true;
                        const pathParts = getPathParts(getToolPath(entry));

                        return (
                            <article key={itemKey} className="edit-file-card">
                                <div className="edit-file-header">
                                    <div className="edit-file-path" title={pathParts.fullPath || pathParts.name}>
                                        {pathParts.directory && (
                                            <span className="edit-file-path-dir">{pathParts.directory}</span>
                                        )}
                                        <span className="edit-file-path-name">{pathParts.name}</span>
                                    </div>
                                </div>

                                {isExecuting && (
                                    <div className="edit-file-empty status-running-text">
                                        In progress...
                                    </div>
                                )}

                                {!isExecuting && hasError && (
                                    <div className="edit-file-error">{response.error}</div>
                                )}

                                {!isExecuting && !hasError && isCreatedFile && (
                                    <div className="edit-file-note">
                                        Created file with {formatLineCount(response?.addedLines)}.
                                    </div>
                                )}

                                {!isExecuting && !hasError && !isCreatedFile && isOverwriteWrite && (
                                    <div className="edit-file-note">
                                        Full-file overwrite preview
                                    </div>
                                )}

                                {!isExecuting && !hasError && diffLines.length > 0 && (
                                    <div className="edit-diff-preview">
                                        {diffLines.map((line, lineIndex) => (
                                            <div
                                                key={`${itemKey}-line-${lineIndex}`}
                                                className={`edit-diff-row edit-diff-row-${line?.type ?? 'context'}`}
                                            >
                                                <span className="edit-diff-line-no">{renderDiffLineNumber(line)}</span>
                                                <code className="edit-diff-line-text">{renderDiffLineContent(line)}</code>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {!isExecuting && !hasError && diffLines.length === 0 && (
                                    <div className="edit-file-empty">No preview available.</div>
                                )}
                            </article>
                        );
                    })}
                    <button
                        type="button"
                        className="tool-show-less"
                        onClick={closeEditList}
                    >
                        Show less
                    </button>
                </div>
            )}
        </div>
    );
}
