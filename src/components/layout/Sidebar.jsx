import { useEffect, useMemo, useRef, useState } from 'react';
import './Sidebar.css';
import {
    IconClose,
    IconPanel,
    IconPlus,
    IconSearch,
    IconSettings,
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
    onOpenSettings,
    uiSettings,
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
    const inboxChat = useMemo(
        () => recentChats.find((chat) => chat.kind === 'inbox') ?? null,
        [recentChats],
    );
    const regularChats = useMemo(
        () => filteredChats.filter((chat) => chat.kind !== 'inbox'),
        [filteredChats],
    );

    const renderChatRow = (item) => (
        <div
            key={item.id}
            className={`recent-row${item.active ? ' active' : ''}${item.unreadCount > 0 ? ' unread' : ''}`}
        >
            <button
                className="recent-item"
                onClick={() => onSelectChat(item.id)}
                title={item.label}
            >
                <span className="label">{item.label}</span>
                <span className="recent-meta">
                    {item.isRunning && (
                        <span className="running-badge" title="Working">
                            Working
                        </span>
                    )}
                    {item.unreadCount > 0 && (
                        <span className="unread-badge">{item.unreadCount}</span>
                    )}
                </span>
            </button>
        </div>
    );

    return (
        <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} id="sidebar">

            {/* Toggle — rides the right edge of the sidebar */}
            <button
                className="sidebar-toggle-btn"
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                onClick={onToggle}
            >
                <IconPanel />
            </button>

            <div className="sidebar-inner">
                {/* Header — just the logo now, toggle is above */}
                <div className="sidebar-header">
                    <span className="logo-text">{uiSettings?.aiName ?? 'AI Chat'}</span>
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
                    {inboxChat && (
                        <button
                            className={`nav-item${inboxChat.active ? ' active' : ''}`}
                            id="inboxBtn"
                            onClick={() => onSelectChat(inboxChat.id)}
                        >
                            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 12.839a2.25 2.25 0 0 0-.1.661Z" />
                            </svg>
                            <span className="nav-label">Inbox</span>
                            {inboxChat.isRunning && (
                                <span className="nav-status-dot" title="Working" aria-label="Working" />
                            )}
                            {inboxChat.unreadCount > 0 && (
                                <span className="nav-badge">{inboxChat.unreadCount}</span>
                            )}
                        </button>
                    )}
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

                    {regularChats.length === 0 && (
                        <div className="recents-empty">
                            {query ? 'No chats match your search' : 'No chats yet'}
                        </div>
                    )}

                    {regularChats.map(renderChatRow)}
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
