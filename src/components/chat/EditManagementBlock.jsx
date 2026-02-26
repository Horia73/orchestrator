import { useMemo, useState } from 'react';
import './ToolBlock.css';

function getLastPathSegment(pathValue) {
    const rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
    if (!rawPath) return 'file';

    const normalizedPath = rawPath.replace(/\\/g, '/');
    const withoutTrailingSlash = normalizedPath.endsWith('/')
        ? normalizedPath.slice(0, -1)
        : normalizedPath;

    if (!withoutTrailingSlash) return 'file';

    const segments = withoutTrailingSlash.split('/').filter(Boolean);
    return segments[segments.length - 1] || 'file';
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
        files.push(getLastPathSegment(getToolPath(entry)));
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
    const primaryLabel = uniqueFiles.length === 1
        ? uniqueFiles[0]
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

export function EditManagementBlock({ entries = [] }) {
    const [isOpen, setIsOpen] = useState(false);
    const summary = useMemo(() => getSummary(entries), [entries]);

    return (
        <div className="edit-tools-block">
            <button
                type="button"
                className="edit-tools-header"
                onClick={() => setIsOpen((current) => !current)}
            >
                <span className={`edit-tools-prefix${summary.isRunning ? ' status-running-text' : ''}`}>{summary.prefix}</span>
                <span className="edit-tools-target">{summary.primaryLabel}</span>
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
                        const hasError = typeof response?.error === 'string' && response.error.trim().length > 0;
                        const diffLines = Array.isArray(response?.diffPreview?.lines)
                            ? response.diffPreview.lines
                            : [];
                        const isExecuting = entry?.isExecuting === true && !entry?.functionResponse;

                        return (
                            <article key={itemKey} className="edit-file-card">
                                {isExecuting && (
                                    <div className="edit-file-empty status-running-text">
                                        In progress...
                                    </div>
                                )}

                                {!isExecuting && hasError && (
                                    <div className="edit-file-error">{response.error}</div>
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
                </div>
            )}
        </div>
    );
}
