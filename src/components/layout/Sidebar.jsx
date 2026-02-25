import { useEffect, useMemo, useRef, useState } from 'react';
import './Sidebar.css';
import {
    IconChevronDown,
    IconChevronRight,
    IconClose,
    IconPlus,
    IconSearch,
    IconSettings,
    IconTrash,
} from '../shared/icons.jsx';

function normalizeSearchQuery(value) {
    return String(value ?? '').trim().toLowerCase();
}

export function Sidebar({
    collapsed,
    onToggle,
    onNewChat,
    recentChats,
    onSelectChat,
    onDeleteChat,
    onOpenSettings,
}) {
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [query, setQuery] = useState('');
    const searchInputRef = useRef(null);
    const searchPanelRef = useRef(null);
    const searchToggleRef = useRef(null);

    useEffect(() => {
        if (isSearchOpen && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [isSearchOpen]);

    useEffect(() => {
        if (!isSearchOpen) return;

        const handleDocumentClick = (event) => {
            const target = event.target;

            if (searchPanelRef.current?.contains(target) || searchToggleRef.current?.contains(target)) {
                return;
            }

            setIsSearchOpen(false);
            setQuery('');
        };

        document.addEventListener('click', handleDocumentClick);
        return () => document.removeEventListener('click', handleDocumentClick);
    }, [isSearchOpen]);

    const filteredChats = useMemo(() => {
        const normalizedQuery = normalizeSearchQuery(query);
        if (!normalizedQuery) return recentChats;

        return recentChats.filter((chat) => chat.label.toLowerCase().includes(normalizedQuery));
    }, [query, recentChats]);

    return (
        <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} id="sidebar">

            {/* Toggle — rides the right edge of the sidebar */}
            <button
                className="sidebar-toggle-btn"
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                onClick={onToggle}
            >
                {collapsed ? <IconChevronRight /> : <IconChevronDown />}
            </button>

            <div className="sidebar-inner">
                {/* Header — just the logo now, toggle is above */}
                <div className="sidebar-header">
                    <span className="logo-text">Gemini UI</span>
                </div>

                {/* Nav */}
                <nav className="sidebar-nav">
                    <button
                        className="nav-item"
                        id="newChatBtn"
                        onClick={onNewChat}
                    >
                        <IconPlus />
                        <span className="nav-label">New chat</span>
                    </button>
                    <button
                        className={`nav-item${isSearchOpen ? ' active' : ''}`}
                        id="searchBtn"
                        ref={searchToggleRef}
                        onClick={() => {
                            setIsSearchOpen((current) => !current);
                            if (isSearchOpen) {
                                setQuery('');
                            }
                        }}
                    >
                        <IconSearch />
                        <span className="nav-label">Search</span>
                    </button>
                </nav>

                {isSearchOpen && (
                    <div className="sidebar-search" ref={searchPanelRef}>
                        <div className="search-shell">
                            <span className="search-leading" aria-hidden="true">
                                <IconSearch />
                            </span>

                            <input
                                ref={searchInputRef}
                                className="search-input"
                                type="text"
                                autoComplete="off"
                                aria-label="Search conversations"
                                value={query}
                                placeholder="Search conversations"
                                onChange={(event) => setQuery(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key !== 'Escape') return;
                                    setIsSearchOpen(false);
                                    setQuery('');
                                    searchToggleRef.current?.focus();
                                }}
                            />

                            {query && (
                                <button
                                    className="search-clear-btn"
                                    title="Clear search"
                                    aria-label="Clear search"
                                    onClick={() => {
                                        setQuery('');
                                        searchInputRef.current?.focus();
                                    }}
                                >
                                    <IconClose />
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Recents */}
                <div className="sidebar-recents">
                    <div className="recents-label">Recents</div>

                    {filteredChats.length === 0 && (
                        <div className="recents-empty">
                            {query ? 'No chats match your search' : 'No chats yet'}
                        </div>
                    )}

                    {filteredChats.map((item) => (
                        <div
                            key={item.id}
                            className={`recent-row${item.active ? ' active' : ''}`}
                        >
                            <button
                                className="recent-item"
                                onClick={() => onSelectChat(item.id)}
                                title={item.label}
                            >
                                {item.label}
                            </button>

                            <button
                                className="recent-delete-btn"
                                title="Delete chat"
                                aria-label={`Delete ${item.label}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onDeleteChat(item.id);
                                }}
                            >
                                <IconTrash />
                            </button>
                        </div>
                    ))}
                </div>

                {/* Footer */}
                <div className="sidebar-footer">
                    <button className="nav-item" id="settingsBtn" onClick={onOpenSettings}>
                        <IconSettings />
                        <span className="nav-label">Settings</span>
                    </button>
                </div>
            </div>

        </aside>
    );
}
