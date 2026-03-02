import { MarkdownContent } from './MarkdownContent.jsx';
import { IconClose } from '../shared/icons.jsx';

function formatJson(value) {
    try {
        return JSON.stringify(value ?? {}, null, 2);
    } catch {
        return '{}';
    }
}

function getToolDisplayName(toolName) {
    const MAP = {
        view_file: 'File Contents',
        list_dir: 'Directory Listing',
        find_by_name: 'File Search',
        grep_search: 'Text Search',
        view_file_outline: 'File Outline',
        view_code_item: 'Code Item',
        view_content_chunk: 'Content Chunk',
        write_to_file: 'File Created',
        replace_file_content: 'File Edited',
        multi_replace_file_content: 'File Edited',
        read_url_content: 'URL Content',
        search_web: 'Web Search Results',
    };
    return MAP[toolName] || toolName;
}

function getFilePath(toolName, args, response) {
    return String(
        response?.relativePath
        || response?.path
        || args?.AbsolutePath
        || args?.DirectoryPath
        || args?.TargetFile
        || args?.File
        || args?.Url
        || args?.query
        || '',
    ).trim();
}

function renderFileContent(response) {
    const content = String(response?.content ?? response?.text ?? '').trim();
    if (content) {
        return <pre className="tool-panel-file-content">{content}</pre>;
    }
    return null;
}

function renderDirListing(response) {
    const entries = response?.entries ?? response?.files;
    if (Array.isArray(entries) && entries.length > 0) {
        return (
            <div className="tool-panel-dir-listing">
                {entries.map((entry, i) => {
                    const name = typeof entry === 'string' ? entry : String(entry?.name ?? entry?.path ?? '');
                    const isDir = typeof entry === 'object' && (entry?.type === 'directory' || entry?.isDirectory);
                    return (
                        <div key={i} className="tool-panel-dir-entry">
                            <span className="tool-panel-dir-icon">{isDir ? '📁' : '📄'}</span>
                            <span>{name}</span>
                        </div>
                    );
                })}
            </div>
        );
    }
    return null;
}

function renderSearchResults(response) {
    const results = response?.results ?? response?.matches;
    if (Array.isArray(results) && results.length > 0) {
        return (
            <div className="tool-panel-search-results">
                {results.map((result, i) => {
                    if (typeof result === 'string') {
                        return <div key={i} className="tool-panel-search-item">{result}</div>;
                    }
                    const title = String(result?.title ?? result?.file ?? result?.path ?? '');
                    const snippet = String(result?.snippet ?? result?.content ?? result?.text ?? '');
                    const url = String(result?.url ?? result?.link ?? '');
                    return (
                        <div key={i} className="tool-panel-search-item">
                            {title && <div className="tool-panel-search-title">{title}</div>}
                            {url && <div className="tool-panel-search-url">{url}</div>}
                            {snippet && <div className="tool-panel-search-snippet">{snippet}</div>}
                        </div>
                    );
                })}
            </div>
        );
    }
    return null;
}

function renderDiffPreview(response) {
    const lines = response?.diffPreview?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;

    return (
        <div className="tool-panel-diff">
            {lines.map((line, i) => (
                <div
                    key={i}
                    className={`tool-panel-diff-line tool-panel-diff-${line?.type ?? 'context'}`}
                >
                    <span className="tool-panel-diff-no">
                        {line?.type === 'added' ? String(line?.newLineNumber ?? '') : line?.type === 'removed' ? String(line?.oldLineNumber ?? '') : String(line?.lineNumber ?? '')}
                    </span>
                    <code className="tool-panel-diff-text">{String(line?.text ?? '')}</code>
                </div>
            ))}
        </div>
    );
}

function renderGenericResult(response) {
    if (!response || typeof response !== 'object') {
        return <pre className="tool-panel-file-content">{String(response ?? '')}</pre>;
    }

    // Try to extract text content
    const textContent = String(
        response?.content ?? response?.text ?? response?.output ?? response?.result ?? '',
    ).trim();

    if (textContent) {
        // Check if it looks like markdown
        if (textContent.includes('```') || textContent.includes('##') || textContent.includes('- ')) {
            return <MarkdownContent text={textContent} variant="ai" />;
        }
        return <pre className="tool-panel-file-content">{textContent}</pre>;
    }

    return <pre className="tool-panel-file-content">{formatJson(response)}</pre>;
}

export function ToolDetailPanel({ selection, onClose }) {
    if (!selection) return null;

    const { toolName, toolPart } = selection;
    const args = toolPart?.functionCall?.args ?? {};
    const response = toolPart?.functionResponse?.response ?? null;
    const isExecuting = toolPart?.isExecuting === true;
    const hasError = typeof response?.error === 'string' && response.error.trim().length > 0;

    const displayName = getToolDisplayName(toolName);
    const filePath = getFilePath(toolName, args, response);

    const renderContent = () => {
        if (isExecuting) {
            return <div className="tool-panel-loading">Loading...</div>;
        }

        if (hasError) {
            return <div className="tool-panel-error">{response.error}</div>;
        }

        if (!response) {
            return <div className="tool-panel-loading">No result available</div>;
        }

        // File view tools
        if (['view_file', 'view_file_outline', 'view_code_item', 'view_content_chunk'].includes(toolName)) {
            return renderFileContent(response) || renderGenericResult(response);
        }

        // Directory listing
        if (toolName === 'list_dir') {
            return renderDirListing(response) || renderGenericResult(response);
        }

        // Search tools
        if (['find_by_name', 'grep_search', 'search_web'].includes(toolName)) {
            return renderSearchResults(response) || renderGenericResult(response);
        }

        // URL content
        if (toolName === 'read_url_content') {
            return renderGenericResult(response);
        }

        // Edit tools — show diff
        if (['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
            return renderDiffPreview(response) || renderGenericResult(response);
        }

        return renderGenericResult(response);
    };

    return (
        <aside className="tool-detail-panel" aria-label="Tool detail panel">
            <header className="tool-detail-header">
                <div className="tool-detail-header-text">
                    <h2 className="tool-detail-title">{displayName}</h2>
                    {filePath && <p className="tool-detail-subtitle" title={filePath}>{filePath}</p>}
                </div>
                <button
                    className="tool-detail-close"
                    onClick={onClose}
                    title="Close panel"
                    type="button"
                >
                    <IconClose />
                </button>
            </header>
            <div className="tool-detail-body">
                {renderContent()}
            </div>
        </aside>
    );
}
