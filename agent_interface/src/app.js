import { createSidebar } from './components/Sidebar.js';
import { createChatArea } from './components/ChatArea.js';
import { createSettingsPanel } from './components/SettingsPanel.js';

export function createApp() {
    const appEl = document.getElementById('app');
    appEl.className = 'app-layout';

    // Create sidebar
    const { sidebar, overlay } = createSidebar();

    // Create main chat area
    const chatArea = createChatArea();
    const settingsPanel = createSettingsPanel();

    // Mount
    appEl.appendChild(overlay);
    appEl.appendChild(sidebar);
    appEl.appendChild(chatArea);
    appEl.appendChild(settingsPanel);
}
