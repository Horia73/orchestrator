import { useState, useEffect } from 'react';
import { MarkdownContent } from './MarkdownContent.jsx';

const MAX_TITLE_LENGTH = 62;

function extractThinkingTitle(thought) {
    const raw = String(thought ?? '').trim();
    if (!raw) return null;

    const lines = raw.split('\n');

    // First, try to find an explicit heading or bold line from bottom up
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if ((line.startsWith('**') && line.endsWith('**') && line.length > 4) ||
            (line.startsWith('#') && line.length > 2)) {
            let cleanLine = line.replace(/(\*\*|[*_~`#>])/g, '').trim();
            if (cleanLine) {
                return cleanLine.length > MAX_TITLE_LENGTH
                    ? cleanLine.slice(0, MAX_TITLE_LENGTH) + '…'
                    : cleanLine;
            }
        }
    }

    // Next, look for a "title-like" chunk by splitting on double newlines
    // A title is typically a single short line separated by empty lines.
    const chunks = raw.split(/\n\s*\n/);
    for (let i = chunks.length - 1; i >= 0; i--) {
        const chunkLines = chunks[i].trim().split('\n');
        if (chunkLines.length === 1 && chunkLines[0].length > 0 && chunkLines[0].length < 150) {
            let cleanLine = chunkLines[0].replace(/(\*\*|[*_~`#>])/g, '').trim();
            if (cleanLine) {
                return cleanLine.length > MAX_TITLE_LENGTH
                    ? cleanLine.slice(0, MAX_TITLE_LENGTH) + '…'
                    : cleanLine;
            }
        }
    }

    // Fallback: If no clear title chunk exists, return the top-most line
    // (We don't pick the bottom-most line because it's usually just a paragraph sentence!)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            let cleanLine = line.replace(/(\*\*|[*_~`#>])/g, '').trim();
            if (!cleanLine) cleanLine = line;
            return cleanLine.length > MAX_TITLE_LENGTH
                ? cleanLine.slice(0, MAX_TITLE_LENGTH) + '…'
                : cleanLine;
        }
    }
    return null;
}

export function ThoughtBlock({ thought, isThinking = false, showWorkedWhenIdle = false, thinkingDurationMs = 0 }) {
    const [open, setOpen] = useState(false);
    const persistedSeconds = Math.max(0, Math.floor((thinkingDurationMs || 0) / 1000));
    const [thinkingSeconds, setThinkingSeconds] = useState(persistedSeconds);

    useEffect(() => {
        let interval = null;
        let cancelled = false;

        if (isThinking) {
            const startMs = Date.now() - persistedSeconds * 1000;
            const updateElapsed = () => {
                if (cancelled) {
                    return;
                }

                const elapsedSeconds = Math.floor((Date.now() - startMs) / 1000);
                setThinkingSeconds(Math.max(persistedSeconds, elapsedSeconds));
            };

            queueMicrotask(updateElapsed);
            interval = setInterval(updateElapsed, 1000);
        } else {
            queueMicrotask(() => {
                if (!cancelled) {
                    setThinkingSeconds((current) => Math.max(persistedSeconds, current));
                }
            });
        }

        return () => {
            cancelled = true;
            if (interval) clearInterval(interval);
        };
    }, [isThinking, persistedSeconds]);

    const hasThought = String(thought ?? '').trim().length > 0;
    const canToggle = hasThought;

    const baseTitle = extractThinkingTitle(thought);

    let title;
    let isRunningTitle;

    if (isThinking && hasThought) {
        // Show the latest thought title streaming in
        title = baseTitle ?? 'Thinking...';
        isRunningTitle = true;
    } else if (isThinking && !hasThought) {
        // Tool-execution step with no thought — keep "Working..." unchanged
        title = 'Working...';
        isRunningTitle = true;
    } else if (hasThought) {
        title = 'Thought';
        isRunningTitle = false;
    } else if (showWorkedWhenIdle) {
        title = 'Worked';
        isRunningTitle = false;
    } else {
        title = '';
    }

    const timeDisplay = isRunningTitle
        ? ` (${thinkingSeconds}s)`
        : (thinkingSeconds > 0 ? ` (${thinkingSeconds}s)` : '');

    if (!title) {
        return null;
    }

    return (
        <section className={`thought-block${isThinking ? ' is-thinking' : ''}`}>
            {canToggle ? (
                <button
                    type="button"
                    className="thought-toggle"
                    aria-expanded={open}
                    onClick={() => setOpen((current) => !current)}
                >
                    {isRunningTitle && <span className="thought-spinner" />}
                    <span className={`thought-title${isRunningTitle ? ' status-running-text' : ''}`}>
                        {title}
                        {timeDisplay}
                    </span>
                    {!open && <span className="thought-arrow">&#9654;</span>}
                </button>
            ) : (
                <div className="thought-toggle thought-toggle-static">
                    {isRunningTitle && <span className="thought-spinner" />}
                    <span className={`thought-title${isRunningTitle ? ' status-running-text' : ''}`}>
                        {title}
                        {timeDisplay}
                    </span>
                </div>
            )}

            {canToggle && open && (
                <div className="thought-content">
                    <MarkdownContent text={thought} variant="ai" />
                    <button
                        type="button"
                        className="thought-show-less"
                        onClick={() => setOpen(false)}
                    >
                        Show less
                    </button>
                </div>
            )}
        </section>
    );
}
