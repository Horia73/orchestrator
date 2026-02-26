import { useMemo, useState } from 'react';
import './ToolBlock.css';

function formatJson(value) {
    try {
        return JSON.stringify(value ?? {}, null, 2);
    } catch {
        return '{}';
    }
}

function formatResult(responseValue) {
    if (typeof responseValue === 'object') {
        return formatJson(responseValue);
    }

    return String(responseValue ?? '');
}

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

function getItemLabel(entry) {
    const toolName = entry?.functionCall?.name ?? 'unknown_tool';
    const args = entry?.functionCall?.args ?? {};
    const response = entry?.functionResponse?.response ?? null;
    const isExecuting = entry?.isExecuting === true && !entry?.functionResponse;
    const hasError = typeof response?.error === 'string' && response.error.trim().length > 0;

    if (toolName === 'view_file') {
        const filePath = response?.relativePath || response?.path || args?.AbsolutePath;
        const displayName = getLastPathSegment(filePath);
        if (isExecuting) return `Reading ${displayName}...`;
        return hasError ? `Failed to read ${displayName}` : `Read ${displayName}`;
    }

    if (toolName === 'list_dir') {
        if (isExecuting) return 'Listing files...';
        return hasError ? 'Failed to list files' : 'Listed files';
    }

    if (toolName === 'view_file_outline') {
        const filePath = response?.relativePath || response?.path || args?.AbsolutePath;
        const displayName = getLastPathSegment(filePath);
        if (isExecuting) return `Inspecting ${displayName}...`;
        return hasError ? `Failed outline for ${displayName}` : `Outlined ${displayName}`;
    }

    if (toolName === 'view_code_item') {
        const filePath = response?.relativePath || response?.path || args?.File;
        const displayName = getLastPathSegment(filePath);
        if (isExecuting) return `Inspecting code in ${displayName}...`;
        if (hasError) return `Failed code view for ${displayName}`;
        const count = Number(response?.matchCount ?? response?.items?.length ?? 0);
        return `Viewed ${count} code item${count === 1 ? '' : 's'} in ${displayName}`;
    }

    if (toolName === 'view_content_chunk') {
        if (isExecuting) return 'Reading content chunk...';
        if (hasError) return 'Failed to read content chunk';
        const position = Number(response?.position ?? 0);
        const totalChunks = Number(response?.total_chunks ?? 0);
        if (totalChunks > 0) {
            return `Read chunk ${position + 1}/${totalChunks}`;
        }
        return 'Read content chunk';
    }

    if (toolName === 'find_by_name') {
        if (isExecuting) return 'Searching files...';
        if (hasError) return 'Failed to search files';
        const count = Number(response?.matchCount ?? response?.matches?.length ?? 0);
        return count > 0
            ? `Found ${count} match${count === 1 ? '' : 'es'}`
            : 'No matches found';
    }

    if (toolName === 'grep_search') {
        if (isExecuting) return 'Searching text...';
        if (hasError) return 'Failed to search text';
        const count = Number(response?.matchCount ?? response?.matches?.length ?? 0);
        return count > 0
            ? `Matched ${count} line${count === 1 ? '' : 's'}`
            : 'No text matches';
    }

    return `Used ${toolName}`;
}

function getSummary(entries) {
    let viewCount = 0;
    let listCount = 0;
    let outlineCount = 0;
    let codeItemCount = 0;
    let contentChunkCount = 0;
    let findCount = 0;
    let grepCount = 0;

    for (const entry of entries) {
        const toolName = entry?.functionCall?.name ?? '';
        if (toolName === 'view_file') viewCount += 1;
        if (toolName === 'list_dir') listCount += 1;
        if (toolName === 'view_file_outline') outlineCount += 1;
        if (toolName === 'view_code_item') codeItemCount += 1;
        if (toolName === 'view_content_chunk') contentChunkCount += 1;
        if (toolName === 'find_by_name') findCount += 1;
        if (toolName === 'grep_search') grepCount += 1;
    }

    const parts = [];
    if (viewCount > 0) parts.push(`${viewCount} file${viewCount === 1 ? '' : 's'}`);
    if (listCount > 0) parts.push(`${listCount} list${listCount === 1 ? '' : 's'}`);
    if (outlineCount > 0) parts.push(`${outlineCount} outline${outlineCount === 1 ? '' : 's'}`);
    if (codeItemCount > 0) parts.push(`${codeItemCount} code item${codeItemCount === 1 ? '' : 's'}`);
    if (contentChunkCount > 0) parts.push(`${contentChunkCount} chunk${contentChunkCount === 1 ? '' : 's'}`);
    if (findCount > 0) parts.push(`${findCount} search${findCount === 1 ? '' : 'es'}`);
    if (grepCount > 0) parts.push(`${grepCount} grep${grepCount === 1 ? '' : 's'}`);

    if (parts.length === 0) return 'Explored';
    return `Explored ${parts.join(', ')}`;
}

export function FileManagementBlock({ entries = [] }) {
    const [isOpen, setIsOpen] = useState(false);
    const [openDetails, setOpenDetails] = useState({});

    const title = useMemo(() => getSummary(entries), [entries]);
    const hasRunningEntries = useMemo(
        () => entries.some((entry) => entry?.isExecuting === true && !entry?.functionResponse),
        [entries],
    );

    const toggleDetails = (index) => {
        setOpenDetails((current) => ({
            ...current,
            [index]: !current[index],
        }));
    };

    return (
        <div className="file-tools-block">
            <button
                type="button"
                className="file-tools-header"
                onClick={() => setIsOpen((current) => !current)}
            >
                <span className={`file-tools-title${hasRunningEntries ? ' status-running-text' : ''}`}>{title}</span>
                <span className={`file-tools-chevron ${isOpen ? 'open' : ''}`}>▼</span>
            </button>

            {isOpen && (
                <div className="file-tools-list">
                    {entries.map((entry, index) => {
                        const callId = typeof entry?.functionCall?.id === 'string'
                            ? entry.functionCall.id.trim()
                            : '';
                        const itemKey = callId || `${entry?.functionCall?.name ?? 'tool'}-${index}`;
                        const isDetailsOpen = !!openDetails[index];
                        const hasResponse = !!entry?.functionResponse;
                        const isRunning = entry?.isExecuting === true && !entry?.functionResponse;

                        return (
                            <div key={itemKey} className="file-tools-item">
                                <button
                                    type="button"
                                    className="file-tools-item-row"
                                    onClick={() => toggleDetails(index)}
                                >
                                    <span className={`file-tools-item-label${isRunning ? ' status-running-text' : ''}`}>
                                        {getItemLabel(entry)}
                                    </span>
                                    <span className={`file-tools-item-chevron ${isDetailsOpen ? 'open' : ''}`}>
                                        ▼
                                    </span>
                                </button>

                                {isDetailsOpen && (
                                    <div className="file-tools-details">
                                        <div className="tool-section">
                                            <div className="tool-section-title">Arguments</div>
                                            <pre>{formatJson(entry?.functionCall?.args ?? {})}</pre>
                                        </div>
                                        {hasResponse && (
                                            <div className="tool-section">
                                                <div className="tool-section-title">Result</div>
                                                <pre>{formatResult(entry.functionResponse.response)}</pre>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
