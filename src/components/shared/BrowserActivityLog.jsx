import './BrowserActivityLog.css';

function normalizeEntry(entry, index) {
    if (!entry || typeof entry !== 'object') {
        const content = String(entry ?? '').trim();
        if (!content) {
            return null;
        }

        return {
            id: `browser-activity-log-${index + 1}`,
            content,
            isLive: false,
        };
    }

    const content = String(entry.content ?? entry.message ?? '').trim();
    if (!content) {
        return null;
    }

    return {
        id: String(entry.id ?? '').trim() || `browser-activity-log-${index + 1}`,
        content,
        isLive: entry.isLive === true || entry.isThinking === true,
    };
}

export function BrowserActivityLog({
    entries = [],
    title = 'Activity Log',
    emptyLabel = 'No activity yet.',
    showCount = true,
    className = '',
}) {
    const normalizedEntries = Array.isArray(entries)
        ? entries.map(normalizeEntry).filter(Boolean)
        : [];
    const rootClassName = ['browser-activity-log', className].filter(Boolean).join(' ');

    return (
        <section className={rootClassName}>
            <div className="browser-activity-log-header">
                <span>{title}</span>
                {showCount && <span>{normalizedEntries.length} entries</span>}
            </div>
            <div className="browser-activity-log-list">
                {normalizedEntries.length > 0
                    ? normalizedEntries.map((entry, index) => (
                        <div
                            key={entry.id}
                            className={`browser-activity-log-entry${entry.isLive ? ' is-live' : ''}`}
                        >
                            <span className="browser-activity-log-index">{index + 1}</span>
                            <div className="browser-activity-log-text">{entry.content}</div>
                        </div>
                    ))
                    : <div className="browser-activity-log-empty">{emptyLabel}</div>}
            </div>
        </section>
    );
}
