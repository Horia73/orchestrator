import { useState, useRef, useEffect } from 'react';
import { MarkdownContent } from './MarkdownContent.jsx';

const MAX_TITLE_LENGTH = 62;

function extractThinkingTitle(thought) {
    const raw = String(thought ?? '').trimEnd();
    if (!raw) return null;

    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line) {
            return line.length > MAX_TITLE_LENGTH
                ? line.slice(0, MAX_TITLE_LENGTH) + '…'
                : line;
        }
    }
    return null;
}

export function ThoughtBlock({ thought, isThinking = false, showWorkedWhenIdle = false }) {
    const [open, setOpen] = useState(false);
    const thinkingStartRef = useRef(null);
    const [thinkingSeconds, setThinkingSeconds] = useState(0);

    useEffect(() => {
        if (isThinking) {
            if (thinkingStartRef.current === null) {
                thinkingStartRef.current = Date.now();
            }
            return;
        }
        // isThinking just became false — finalize duration
        if (thinkingStartRef.current !== null) {
            const elapsed = Math.max(1, Math.round((Date.now() - thinkingStartRef.current) / 1000));
            setThinkingSeconds(elapsed);
            thinkingStartRef.current = null;
        }
    }, [isThinking]);

    const hasThought = String(thought ?? '').trim().length > 0;
    const canToggle = hasThought;

    let title;
    let isRunningTitle;

    if (isThinking && hasThought) {
        // Show the latest thought title streaming in
        title = extractThinkingTitle(thought) ?? 'Thinking...';
        isRunningTitle = true;
    } else if (isThinking && !hasThought) {
        // Tool-execution step with no thought — keep "Working..." unchanged
        title = 'Working...';
        isRunningTitle = true;
    } else if (hasThought) {
        title = thinkingSeconds > 0 ? `Thought for ${thinkingSeconds}s` : 'Thought';
        isRunningTitle = false;
    } else if (showWorkedWhenIdle) {
        title = 'Worked';
        isRunningTitle = false;
    } else {
        title = '';
    }

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
                    <span className={`thought-title${isRunningTitle ? ' status-running-text' : ''}`}>{title}</span>
                    <span className="thought-arrow">{open ? '▼' : '▶'}</span>
                </button>
            ) : (
                <div className="thought-toggle thought-toggle-static">
                    <span className={`thought-title${isRunningTitle ? ' status-running-text' : ''}`}>{title}</span>
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
