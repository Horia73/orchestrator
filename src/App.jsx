import { useCallback, useRef, useState, useEffect } from 'react';
import './styles/globals.css';
import './App.css';
import { useSidebar } from './hooks/useSidebar.js';
import { useChat } from './hooks/useChat.js';
import { Sidebar } from './components/layout/Sidebar.jsx';
import { ChatArea } from './components/chat/ChatArea.jsx';
import { ChatInput } from './components/chat/ChatInput.jsx';
import { Settings } from './components/settings/Settings.jsx';
import { IconPanel } from './components/shared/icons.jsx';
import { fetchAgents, fetchSettings, saveSettings } from './api/settingsApi.js';

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
  const [agentDefinitions, setAgentDefinitions] = useState([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load settings on mount
  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        setSavedSettings(settings);
        setSettingsLoaded(true);
      })
      .catch(() => {
        setSavedSettings(null);
        setSettingsLoaded(true);
      });
    fetchAgents()
      .then((agents) => {
        setAgentDefinitions(agents);
        setAgentsLoaded(true);
      })
      .catch(() => {
        setAgentDefinitions([]);
        setAgentsLoaded(true);
      });
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

  const handleDeleteChat = useCallback(async (chatId) => {
    await chat.deleteChat(chatId);
    focusInput();
  }, [chat, focusInput]);

  const handleOpenSettings = useCallback(() => {
    setSettingsViewInUrl(true);
    setSettingsLoaded(false);
    setAgentsLoaded(false);
    Promise.all([
      fetchSettings().catch(() => null),
      fetchAgents().catch(() => []),
    ])
      .then(([settings, agents]) => {
        if (settings) {
          setSavedSettings(settings);
        }
        setAgentDefinitions(Array.isArray(agents) ? agents : []);
        setAgentsLoaded(true);
        setSettingsLoaded(true);
      })
      .catch(() => {
        setSettingsLoaded(true);
        setAgentsLoaded(true);
      })
      .finally(() => setSettingsOpen(true));
  }, []);

  const handleSaveSettings = useCallback(async (newSettings) => {
    const payload = await saveSettings(newSettings);
    setSavedSettings(payload?.settings ?? newSettings);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setSettingsViewInUrl(false);
    setSettingsOpen(false);
  }, []);

  if (settingsOpen) {
    if (!agentsLoaded || !settingsLoaded) {
      return (
        <div className="app">
          <div className="settings-page">
            <div className="settings-loading">Loading settings…</div>
          </div>
        </div>
      );
    }

    return (
      <div className="app">
        <Settings
          onClose={handleCloseSettings}
          savedSettings={savedSettings}
          agentDefinitions={agentDefinitions}
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
        <IconPanel />
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
        onDeleteChat={handleDeleteChat}
        onOpenSettings={handleOpenSettings}
      />

        <ChatArea
            greeting={chat.greeting}
            messages={chat.messages}
            conversationKey={chat.activeChatId}
            isTyping={chat.isTyping}
            isChatMode={chat.isChatMode}
            agentStreaming={chat.agentStreaming}
      >
        <ChatInput
          ref={chatInputRef}
          onSend={chat.sendMessage}
          onStop={chat.stopGeneration}
          draftValue={chat.inputDraft}
          onDraftChange={chat.setInputDraft}
          attachments={chat.inputAttachments}
          onAttachmentsChange={chat.setInputAttachments}
          isChatMode={chat.isChatMode}
          isSending={chat.isTyping}
        />
      </ChatArea>

    </div>
  );
}
