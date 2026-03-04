import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import './styles/globals.css';
import './App.css';
import { useSidebar } from './hooks/useSidebar.js';
import { useChat } from './hooks/useChat.js';
import { Sidebar } from './components/layout/Sidebar.jsx';
import { ChatArea } from './components/chat/ChatArea.jsx';
import { ChatInput } from './components/chat/ChatInput.jsx';
import { extractLatestTodoState } from './components/chat/todoUtils.js';
import { Settings } from './components/settings/Settings.jsx';
import { IconPanel } from './components/shared/icons.jsx';
import { fetchAgents, fetchSettings, saveSettings } from './api/settingsApi.js';

const MODEL_CATALOG_PATH = '~/.orchestrator/models.json';

function buildModelCatalogTaskPrompt({ focusModelId = '', missingModelIds = [] } = {}) {
  const normalizedFocusModelId = String(focusModelId ?? '').trim();
  const normalizedMissingModelIds = Array.isArray(missingModelIds)
    ? [...new Set(
        missingModelIds
          .map((modelId) => String(modelId ?? '').trim())
          .filter(Boolean),
      )]
    : [];

  const lines = [
    `Update the Gemini model catalog at ${MODEL_CATALOG_PATH}.`,
    '',
    'What you need to do:',
    `1. Read ${MODEL_CATALOG_PATH}.`,
    '2. Get the current live Gemini model list from the API.',
    '3. Compare the live API models with the local catalog.',
    '4. For every new or changed model, find verified pricing and verified thinking support, then update the catalog.',
    '5. If the docs are unclear for thinking, test the model directly in the API and determine thinkingMode = none | level | budget.',
    '6. If a model no longer exists in the API, mark it retired but keep it in the catalog for history.',
    '7. Do not guess. If something cannot be verified, leave it null/empty or preserve the verified existing value.',
    '8. Finish by editing the file directly.',
    '',
    'Notes:',
    '- Use official Google AI sources when you need documentation.',
    '- Use whatever tools you need.',
    '- When useful, do searches and API checks in parallel.',
    '- Do not stop at analysis. Make the file update yourself.',
  ];

  if (normalizedFocusModelId) {
    lines.push('', `Priority model: ${normalizedFocusModelId}`);
  }

  if (normalizedMissingModelIds.length > 0) {
    lines.push('', `Models currently missing catalog data: ${normalizedMissingModelIds.join(', ')}`);
  }

  return lines.join('\n');
}

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
  const activeTodoState = useMemo(
    () => extractLatestTodoState(chat.messages),
    [chat.messages],
  );

  // Settings page state
  const [settingsOpen, setSettingsOpen] = useState(() => isSettingsViewFromUrl());
  const [savedSettings, setSavedSettings] = useState(null);
  const [uiSettings, setUiSettings] = useState({ aiName: 'AI Chat', userName: 'User' });
  const [agentDefinitions, setAgentDefinitions] = useState([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load settings on mount
  useEffect(() => {
    fetchSettings()
      .then((data) => {
        setSavedSettings(data.settings);
        if (data.uiSettings) setUiSettings(data.uiSettings);
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

  useEffect(() => {
    if (uiSettings?.aiName) {
      document.title = uiSettings.aiName;
    }
  }, [uiSettings?.aiName]);

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

  const handleReplyFromInboxMessage = useCallback((message) => {
    chat.startReplyFromMessage(message);
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
      .then(([data, agents]) => {
        if (data) {
          setSavedSettings(data.settings);
          if (data.uiSettings) setUiSettings(data.uiSettings);
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

  const handleSaveSettings = useCallback(async (newSettings, newUiSettings) => {
    // If newUiSettings is not provided (removed from settings UI), 
    // we keep the current uiSettings or don't send it.
    const payload = await saveSettings({
      settings: newSettings,
      uiSettings: newUiSettings ?? uiSettings
    });
    setSavedSettings(payload?.settings ?? newSettings);
    if (payload?.uiSettings) setUiSettings(payload.uiSettings);
  }, [uiSettings]);

  const handleCloseSettings = useCallback(() => {
    setSettingsViewInUrl(false);
    setSettingsOpen(false);
  }, []);

  const handleLaunchModelCatalogTask = useCallback(({ focusModelId = '', missingModelIds = [] } = {}) => {
    const prompt = buildModelCatalogTaskPrompt({
      focusModelId,
      missingModelIds,
    });

    setSettingsViewInUrl(false);
    setSettingsOpen(false);

    requestAnimationFrame(() => {
      chat.startNewChatWithMessage({
        agentId: 'orchestrator',
        text: prompt,
      }).catch((error) => {
        console.error('Failed to launch model catalog task', error);
      });
    });
  }, [chat]);

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
          onLaunchModelCatalogTask={handleLaunchModelCatalogTask}
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
        uiSettings={uiSettings}
      />

      <ChatArea
        greeting={chat.greeting}
        messages={chat.messages}
        conversationKey={chat.activeChatId}
        clientId={chat.clientId}
        isTyping={chat.isTyping}
        isChatMode={chat.isChatMode}
        activeChatKind={chat.activeChatKind}
        onReplyFromMessage={handleReplyFromInboxMessage}
        agentStreaming={chat.agentStreaming}
        commandChunks={chat.commandChunks}
        uiSettings={uiSettings}
      >
        {!chat.isInboxChatActive && (
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
            replyPreview={chat.draftReplyContext}
            onClearReplyPreview={chat.clearDraftReplyContext}
            uiSettings={uiSettings}
            todoState={activeTodoState}
            todoBoardKey={chat.activeChatId ?? 'chat-input-todo'}
          />
        )}
      </ChatArea>

    </div>
  );
}
