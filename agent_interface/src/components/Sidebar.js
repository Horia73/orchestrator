import { store } from '../state/store.js';
import { groupConversationsByDate } from '../utils/dates.js';

// SVG Icons
const ICONS = {
  chat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
  newChat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
  settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
};

export function createSidebar() {
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar';
  sidebar.id = 'sidebar';

  // Overlay for mobile
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.id = 'sidebar-overlay';
  overlay.addEventListener('click', () => store.closeSidebar());

  function render() {
    const state = store.getState();
    const groups = groupConversationsByDate(state.conversations);
    const assistant = state.assistantProfile || { name: 'AI Chat', emoji: '🤖' };
    const assistantName = escapeHtml(assistant.name || 'AI Chat');
    const assistantEmoji = escapeHtml(assistant.emoji || '🤖');

    sidebar.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-brand">
          <div class="sidebar-logo">${assistantEmoji}</div>
          <span class="sidebar-title">${assistantName}</span>
        </div>
        <button class="new-chat-btn" id="new-chat-btn" title="New chat">
          ${ICONS.newChat}
        </button>
      </div>
      <div class="sidebar-conversations" id="sidebar-conversations">
        ${groups.length === 0
        ? `<div class="empty-sidebar">
                <span class="empty-sidebar-icon">💬</span>
                <span>No conversations yet</span>
              </div>`
        : groups
          .map(
            (group) => `
                  <div class="conversation-group">
                    <div class="conversation-group-label">${group.label}</div>
                    ${group.conversations
                .map(
                  (conv) => `
                        <div class="conversation-item ${conv.id === state.activeConversationId ? 'active' : ''}" 
                             data-id="${conv.id}">
                          <span class="conversation-item-icon">${ICONS.chat}</span>
                          <span class="conversation-item-title">${escapeHtml(conv.title)}</span>
                          <button class="conversation-item-delete" data-delete-id="${conv.id}" title="Delete">
                            ${ICONS.trash}
                          </button>
                        </div>
                      `
                )
                .join('')}
                  </div>
                `
          )
          .join('')
      }
      </div>
      <div class="sidebar-footer">
        <button class="sidebar-settings-btn" id="open-settings-btn" title="Settings">
          ${ICONS.settings}
          <span>Settings</span>
        </button>
        <div class="sidebar-footer-info">
          Hosted on CM3588 • ARM64
        </div>
      </div>
    `;

    // Toggle open state on mobile
    if (state.sidebarOpen) {
      sidebar.classList.add('open');
      overlay.classList.add('visible');
      overlay.style.pointerEvents = 'auto';
    } else {
      sidebar.classList.remove('open');
      overlay.classList.remove('visible');
      overlay.style.pointerEvents = 'none';
    }

    // Event listeners
    sidebar.querySelector('#new-chat-btn')?.addEventListener('click', () => {
      store.createConversation();
    });

    sidebar.querySelectorAll('.conversation-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.conversation-item-delete')) return;
        store.setActiveConversation(item.dataset.id);
      });
    });

    sidebar.querySelectorAll('.conversation-item-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.deleteConversation(btn.dataset.deleteId);
      });
    });

    sidebar.querySelector('#open-settings-btn')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('ui:open-settings'));
    });
  }

  store.subscribe(render);
  render();

  return { sidebar, overlay };
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
