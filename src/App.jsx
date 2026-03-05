import { Suspense, lazy, useCallback, useRef, useState, useEffect, useMemo } from 'react';
import './styles/globals.css';
import './App.css';
import { useSidebar } from './hooks/useSidebar.js';
import { useChat } from './hooks/useChat.js';
import { Sidebar } from './components/layout/Sidebar.jsx';
import { TopNavBar } from './components/layout/TopNavBar.jsx';
import { ChatInput } from './components/chat/ChatInput.jsx';
import { extractLatestTodoState } from './components/chat/todoUtils.js';
import { fetchAgents, fetchSettings, saveSettings } from './api/settingsApi.js';

const MODEL_CATALOG_PATH = '~/.orchestrator/models.json';
const ChatArea = lazy(() => import('./components/chat/ChatArea.jsx').then((module) => ({ default: module.ChatArea })));
const InboxArea = lazy(() => import('./components/chat/InboxArea.jsx').then((module) => ({ default: module.InboxArea })));
const Settings = lazy(() => import('./components/settings/Settings.jsx').then((module) => ({ default: module.Settings })));

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

function AppPanelLoading({ label }) {
  return (
    <div className="app">
      <div className="settings-page">
        <div className="settings-loading">{label}</div>
      </div>
    </div>
  );
}

function ConversationLoading() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div className="settings-loading">Loading conversation…</div>
    </div>
  );
}

function buildEmojiFaviconDataUri(emoji) {
  const normalizedEmoji = String(emoji ?? '').trim() || '🤖';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-size="52">
        ${normalizedEmoji}
      </text>
    </svg>
  `.trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function applyEmojiFavicon(emoji) {
  const href = buildEmojiFaviconDataUri(emoji);
  const existing = document.querySelector("link[rel='icon']");
  const iconLink = existing || document.createElement('link');
  iconLink.setAttribute('rel', 'icon');
  iconLink.setAttribute('type', 'image/svg+xml');
  iconLink.setAttribute('href', href);
  if (!existing) {
    document.head.appendChild(iconLink);
  }
}

export default function App() {
  const sidebar = useSidebar();
  const chat = useChat();
  const chatInputRef = useRef(null);
  const activeTodoState = useMemo(
    () => extractLatestTodoState(chat.messages),
    [chat.messages],
  );

  // Derive the active conversation title from the sidebar recents list
  const activeChatTitle = useMemo(() => {
    if (!chat.activeChatId) return '';
    const found = chat.recents?.find((c) => c.id === chat.activeChatId);
    return found?.label ?? '';
  }, [chat.activeChatId, chat.recents]);

  // Settings page state
  const [settingsOpen, setSettingsOpen] = useState(() => isSettingsViewFromUrl());
  const [savedSettings, setSavedSettings] = useState(null);
  const [uiSettings, setUiSettings] = useState({
    aiName: 'AI Chat',
    userName: 'User',
    aiEmoji: '🤖',
    aiVibe: 'pragmatic helper',
  });
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
    const name = String(uiSettings?.aiName ?? '').trim();
    const nextTitle = name || 'AI Chat';
    document.title = nextTitle;
  }, [uiSettings?.aiName]);

  useEffect(() => {
    applyEmojiFavicon(uiSettings?.aiEmoji);
  }, [uiSettings?.aiEmoji]);

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
      return <AppPanelLoading label="Loading settings…" />;
    }

    return (
      <Suspense fallback={<AppPanelLoading label="Loading settings…" />}>
        <div className="app">
          <Settings
            onClose={handleCloseSettings}
            savedSettings={savedSettings}
            agentDefinitions={agentDefinitions}
            onSave={handleSaveSettings}
            onLaunchModelCatalogTask={handleLaunchModelCatalogTask}
          />
        </div>
      </Suspense>
    );
  }

  return (
    <div className="app">

      {/* Mobile: floating open button, shown only when sidebar is closed */}
      {/* Removed mobile-menu-btn */}

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
        onOpenSettings={handleOpenSettings}
        uiSettings={uiSettings}
      />

      {/* Main content column: TopNavBar + chat/inbox area */}
      <div className="main-column">
        <TopNavBar
          title={chat.isInboxChatActive ? 'Inbox' : activeChatTitle}
          onClear={
            chat.isInboxChatActive
              ? () => chat.clearInboxMessages(chat.activeChatId)
              : chat.activeChatId
                ? () => handleDeleteChat(chat.activeChatId)
                : null
          }
          onOpenSidebar={sidebar.expand}
          sidebarOpen={!sidebar.collapsed}
        />

        <Suspense fallback={<ConversationLoading />}>
          {chat.isInboxChatActive ? (
            <InboxArea
              messages={chat.messages}
              conversationKey={chat.activeChatId}
              clientId={chat.clientId}
              isTyping={chat.isTyping}
              onReplyFromMessage={handleReplyFromInboxMessage}
              agentStreaming={chat.agentStreaming}
              commandChunks={chat.commandChunks}
              uiSettings={uiSettings}
            />
          ) : (
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
            </ChatArea>
          )}
        </Suspense>
      </div>

    </div>
  );
}
