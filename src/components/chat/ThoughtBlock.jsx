import { useState } from 'react';
import { MarkdownContent } from './MarkdownContent.jsx';

export function ThoughtBlock({ thought, isThinking = false, showWorkedWhenIdle = false }) {
    const [open, setOpen] = useState(false);
    const hasThought = String(thought ?? '').trim().length > 0;
    const canToggle = hasThought;
    const title = isThinking
        ? (hasThought ? 'Thinking...' : 'Working...')
        : hasThought
            ? 'Thought'
            : showWorkedWhenIdle
                ? 'Worked'
                : '';

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
                    <span className="thought-title">{title}</span>
                    <span className="thought-arrow">{open ? 'v' : '>'}</span>
                </button>
            ) : (
                <div className="thought-toggle thought-toggle-static">
                    <span className="thought-title">{title}</span>
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
