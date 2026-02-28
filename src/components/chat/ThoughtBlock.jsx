import { useState, useRef, useEffect } from 'react';
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

export function ThoughtBlock({ thought, isThinking = false, showWorkedWhenIdle = false }) {
    const [open, setOpen] = useState(false);
    const thinkingStartRef = useRef(null);
    const [thinkingSeconds, setThinkingSeconds] = useState(0);

    useEffect(() => {
        let interval;
        if (isThinking) {
            const startMs = thinkingStartRef.current ?? Date.now();
            if (thinkingStartRef.current === null) {
                thinkingStartRef.current = startMs;
            }

            interval = setInterval(() => {
                setThinkingSeconds(Math.floor((Date.now() - startMs) / 1000));
            }, 1000);
        } else {
            if (thinkingStartRef.current !== null) {
                const elapsed = Math.max(1, Math.floor((Date.now() - thinkingStartRef.current) / 1000));
                setThinkingSeconds(elapsed);
                thinkingStartRef.current = null;
            }
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [isThinking]);

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
                    <span className="thought-arrow">{open ? '▼' : '▶'}</span>
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
                </div>
            )}
        </section>
    );
}
