import { useEffect, useId, useState } from 'react';
import { IconCheckCircle, IconChecklist, IconChevronDown, IconChevronRight } from '../shared/icons.jsx';
import { AnimatedCollapse } from '../shared/AnimatedCollapse.jsx';
import { formatTodoStatusLabel } from './todoUtils.js';
import './TodoBoard.css';

const TODO_BOARD_COLLAPSE_STORAGE_KEY = 'orchestrator.todo_board.collapsed.v1';

function loadCollapsedState(persistenceKey) {
    if (!persistenceKey || typeof window === 'undefined') {
        return false;
    }

    try {
        const raw = window.localStorage.getItem(TODO_BOARD_COLLAPSE_STORAGE_KEY);
        if (!raw) {
            return false;
        }

        const parsed = JSON.parse(raw);
        return parsed?.[String(persistenceKey)] === true;
    } catch {
        return false;
    }
}

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

export function TodoBoard({
    todoState,
    compact = false,
    collapsible = false,
    docked = false,
    persistenceKey = '',
}) {
    const todoList = todoState?.todoList ?? todoState ?? null;
    const items = Array.isArray(todoList?.items) ? todoList.items : [];
    const hasItems = Boolean(todoList) && items.length > 0;
    const itemsId = useId();
    const [isCollapsed, setIsCollapsed] = useState(() => (
        collapsible ? loadCollapsedState(persistenceKey) : false
    ));

    useEffect(() => {
        if (!collapsible || !persistenceKey || typeof window === 'undefined') {
            return;
        }

        try {
            const raw = window.localStorage.getItem(TODO_BOARD_COLLAPSE_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            const nextState = parsed && typeof parsed === 'object' ? parsed : {};
            nextState[String(persistenceKey)] = isCollapsed;
            window.localStorage.setItem(
                TODO_BOARD_COLLAPSE_STORAGE_KEY,
                JSON.stringify(nextState),
            );
        } catch {
            // Ignore storage failures.
        }
    }, [collapsible, isCollapsed, persistenceKey]);

    if (!hasItems) {
        return null;
    }

    const updatedAtLabel = formatUpdatedAt(todoList.updatedAt);
    const rootClassName = `todo-board${compact ? ' compact' : ''}${collapsible ? ' collapsible' : ''}${docked ? ' docked' : ''}${isCollapsed ? ' collapsed' : ''}`;

    return (
        <section className={rootClassName} aria-label="Task progress">
            <header className="todo-board-header">
                <div className="todo-board-toolbar">
                    <div className="todo-board-title-wrap">
                        <span className="todo-board-icon"><IconChecklist /></span>
                        <h3 className="todo-board-title">{todoList.title}</h3>
                    </div>
                    {updatedAtLabel && <span className="todo-board-subtitle">Updated {updatedAtLabel}</span>}
                    <div className="todo-board-summary">
                        <TodoSummaryPill label="Doing" value={todoList.summary?.in_progress ?? 0} status="in_progress" />
                        <TodoSummaryPill label="Done" value={todoList.summary?.completed ?? 0} status="completed" />
                        <TodoSummaryPill label="Blocked" value={todoList.summary?.blocked ?? 0} status="blocked" />
                    </div>
                    {collapsible && (
                        <button
                            type="button"
                            className="todo-board-toggle"
                            aria-expanded={!isCollapsed}
                            aria-controls={itemsId}
                            onClick={() => setIsCollapsed((prev) => !prev)}
                        >
                            <span className="todo-board-toggle-label">{isCollapsed ? 'Expand' : 'Collapse'}</span>
                            <span className="todo-board-toggle-icon" aria-hidden="true">
                                {isCollapsed ? <IconChevronRight /> : <IconChevronDown />}
                            </span>
                        </button>
                    )}
                </div>
            </header>

            <AnimatedCollapse
                isOpen={!isCollapsed}
                className="todo-board-items-shell"
                innerClassName="todo-board-items-shell-inner"
            >
                <div className="todo-board-items" id={itemsId}>
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
            </AnimatedCollapse>
        </section>
    );
}
