import { IconCheckCircle, IconChecklist } from '../shared/icons.jsx';
import { formatTodoStatusLabel } from './todoUtils.js';
import './TodoBoard.css';

function formatUpdatedAt(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return '';
    }

    try {
        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(numericValue));
    } catch {
        return '';
    }
}

function TodoSummaryPill({ label, value, status }) {
    if (!value) {
        return null;
    }

    return (
        <span className={`todo-board-pill status-${status}`}>
            <span>{label}</span>
            <strong>{value}</strong>
        </span>
    );
}

export function TodoBoard({ todoState, compact = false }) {
    const todoList = todoState?.todoList ?? todoState ?? null;
    const items = Array.isArray(todoList?.items) ? todoList.items : [];

    if (!todoList || items.length === 0) {
        return null;
    }

    const updatedAtLabel = formatUpdatedAt(todoList.updatedAt);

    return (
        <section className={`todo-board${compact ? ' compact' : ''}`} aria-label="Task progress">
            <header className="todo-board-header">
                <div className="todo-board-title-wrap">
                    <span className="todo-board-icon"><IconChecklist /></span>
                    <div>
                        <h3 className="todo-board-title">{todoList.title}</h3>
                        {updatedAtLabel && <p className="todo-board-subtitle">Updated {updatedAtLabel}</p>}
                    </div>
                </div>
                <div className="todo-board-summary">
                    <TodoSummaryPill label="Doing" value={todoList.summary?.in_progress ?? 0} status="in_progress" />
                    <TodoSummaryPill label="Done" value={todoList.summary?.completed ?? 0} status="completed" />
                    <TodoSummaryPill label="Blocked" value={todoList.summary?.blocked ?? 0} status="blocked" />
                </div>
            </header>

            <div className="todo-board-items">
                {items.map((item) => (
                    <article
                        key={item.id}
                        className={`todo-board-item status-${item.status}`}
                    >
                        <span className="todo-board-item-mark">
                            {item.status === 'completed' ? <IconCheckCircle /> : <span className="todo-board-item-dot" />}
                        </span>
                        <div className="todo-board-item-copy">
                            <div className="todo-board-item-topline">
                                <span className="todo-board-item-label">{item.label}</span>
                                <span className={`todo-board-item-status status-${item.status}`}>
                                    {formatTodoStatusLabel(item.status)}
                                </span>
                            </div>
                            {item.details && (
                                <p className="todo-board-item-details">{item.details}</p>
                            )}
                        </div>
                    </article>
                ))}
            </div>
        </section>
    );
}
