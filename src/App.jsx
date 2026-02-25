import { useCallback, useRef, useState, useEffect } from 'react';
import './styles/globals.css';
import './App.css';
import { useSidebar } from './hooks/useSidebar.js';
import { useChat } from './hooks/useChat.js';
import { Sidebar } from './components/layout/Sidebar.jsx';
import { ChatArea } from './components/chat/ChatArea.jsx';
import { ChatInput } from './components/chat/ChatInput.jsx';
import { Settings } from './components/settings/Settings.jsx';
import { IconChevronRight } from './components/shared/icons.jsx';
import { fetchSettings, saveSettings } from './api/settingsApi.js';

function isSettingsViewFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('view') === 'settings';
}

function setSettingsViewInUrl(open) {
  const url = new URL(window.location.href);
  if (open) {
    url.searchParams.set('view', 'settings');
  } else {
    url.searchParams.delete('view');
  }
  window.history.replaceState({}, '', url);
}

export default function App() {
  const sidebar = useSidebar();
  const chat = useChat();
  const chatInputRef = useRef(null);

  // Settings page state
  const [settingsOpen, setSettingsOpen] = useState(() => isSettingsViewFromUrl());
  const [savedSettings, setSavedSettings] = useState(null);

  // Load settings on mount
  useEffect(() => {
    fetchSettings()
      .then(setSavedSettings)
      .catch(() => setSavedSettings(null));
  }, []);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      chatInputRef.current?.focus?.();
    });
  }, []);

  const handleNewChat = useCallback(() => {
    chat.createNewChat();
    focusInput();
  }, [chat, focusInput]);

  const handleSelectChat = useCallback((chatId) => {
    chat.selectChat(chatId);
    focusInput();
  }, [chat, focusInput]);

  const handleOpenSettings = useCallback(() => {
    setSettingsViewInUrl(true);
    // Reload settings fresh when opening
    fetchSettings()
      .then((s) => {
        setSavedSettings(s);
        setSettingsOpen(true);
      })
      .catch(() => setSettingsOpen(true));
  }, []);

  const handleSaveSettings = useCallback(async (newSettings) => {
    await saveSettings(newSettings);
    setSavedSettings(newSettings);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setSettingsViewInUrl(false);
    setSettingsOpen(false);
  }, []);

  if (settingsOpen) {
    return (
      <div className="app">
        <Settings
          onClose={handleCloseSettings}
          savedSettings={savedSettings}
          onSave={handleSaveSettings}
        />
      </div>
    );
  }

  return (
    <div className="app">

      {/* Mobile: floating open button, shown only when sidebar is closed */}
      <button
        className={`mobile-menu-btn${sidebar.collapsed ? ' visible' : ''}`}
        onClick={sidebar.expand}
        title="Open sidebar"
        aria-label="Open sidebar"
      >
        <IconChevronRight />
      </button>

      {/* Mobile: dim overlay behind open sidebar */}
      <div
        className={`sidebar-overlay${!sidebar.collapsed ? ' visible' : ''}`}
        onClick={sidebar.collapse}
        aria-hidden="true"
      />

      <Sidebar
        collapsed={sidebar.collapsed}
        onToggle={sidebar.toggle}
        onNewChat={handleNewChat}
        recentChats={chat.recents}
        onSelectChat={handleSelectChat}
        onDeleteChat={chat.deleteChat}
        onOpenSettings={handleOpenSettings}
      />

      <ChatArea
        greeting={chat.greeting}
        messages={chat.messages}
        isTyping={chat.isTyping}
        isChatMode={chat.isChatMode}
      >
        <ChatInput
          ref={chatInputRef}
          onSend={chat.sendMessage}
          isChatMode={chat.isChatMode}
          isSending={chat.isTyping}
        />
      </ChatArea>

    </div>
  );
}
