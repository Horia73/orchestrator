import './TopNavBar.css';
import { IconPanel } from '../shared/icons.jsx';

function IconTrash() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    );
}

/**
 * TopNavBar
 *
 * Props:
 *  - title          {string}    — conversation title shown on the left
 *  - onClear        {Function}  — called when the Clear button is clicked (pass null/undefined to hide the button)
 *  - onOpenSidebar  {Function}  — called when the mobile hamburger icon is clicked
 *  - sidebarOpen    {boolean}   — when true, the hamburger icon is hidden (sidebar is already open)
 */
export function TopNavBar({ title, onClear, onOpenSidebar, sidebarOpen = false }) {
    return (
        <header className="top-nav-bar">
            {/* Mobile hamburger — hidden on desktop, hidden when sidebar is open */}
            <button
                className={`top-nav-hamburger${sidebarOpen ? ' hidden' : ''}`}
                onClick={onOpenSidebar}
                title="Open sidebar"
                aria-label="Open sidebar"
            >
                <IconPanel />
            </button>

            {/* Conversation title */}
            <span className="top-nav-title" title={title}>
                {title || ''}
            </span>

            {/* Clear button — only shown when onClear is provided */}
            {onClear ? (
                <button
                    className="top-nav-clear-btn"
                    type="button"
                    onClick={onClear}
                    title="Clear conversation"
                >
                    <IconTrash />
                    <span>Clear</span>
                </button>
            ) : (
                /* Placeholder to keep title centred on desktop */
                <span className="top-nav-clear-placeholder" aria-hidden="true" />
            )}
        </header>
    );
}
