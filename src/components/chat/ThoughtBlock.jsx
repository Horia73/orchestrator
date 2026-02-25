import { useState } from 'react';
import { MarkdownContent } from './MarkdownContent.jsx';

export function ThoughtBlock({ thought, isThinking = false, defaultOpen = false }) {
    const [open, setOpen] = useState(defaultOpen);
    const hasThought = String(thought ?? '').trim().length > 0;

    return (
        <section className={`thought-block${isThinking ? ' is-thinking' : ''}`}>
            <button
                type="button"
                className="thought-toggle"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
            >
                <span className="thought-title">{isThinking ? 'Thinking...' : 'Thought'}</span>
                <span className={`thought-arrow${open ? ' open' : ''}`}>v</span>
            </button>

            {open && (
                <div className="thought-content">
                    {hasThought ? (
                        <MarkdownContent text={thought} variant="ai" />
                    ) : (
                        <p className="thought-placeholder">
                            {isThinking ? 'Model is still thinking...' : 'No thought text was returned.'}
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}
