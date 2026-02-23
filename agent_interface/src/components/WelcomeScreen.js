function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

export function createWelcomeScreen(assistantProfile = {}) {
  const el = document.createElement('div');
  el.className = 'welcome-screen';
  el.id = 'welcome-screen';
  const assistantName = String(assistantProfile?.name || 'AI Chat').trim() || 'AI Chat';
  const assistantEmoji = String(assistantProfile?.emoji || '🤖').trim() || '🤖';

  const suggestions = [
    { icon: '💡', text: 'Explică-mi cum funcționează un orchestrator AI' },
    { icon: '🛠️', text: 'Ajută-mă să scriu un script Python' },
    { icon: '📊', text: 'Analizează datele mele și fă un rezumat' },
    { icon: '🚀', text: 'Ce pot face cu un CM3588?' },
  ];

  el.innerHTML = `
    <div class="welcome-logo">${escapeHtml(assistantEmoji)}</div>
    <h1 class="welcome-title">Cu ce te pot ajuta?</h1>
    <p class="welcome-subtitle">
      Sunt ${escapeHtml(assistantName)}, asistentul tău AI. Pune-mi orice întrebare sau alege una din sugestiile de mai jos.
    </p>
    <div class="welcome-suggestions">
      ${suggestions
      .map(
        (s) => `
          <button class="suggestion-chip" data-suggestion="${encodeURIComponent(s.text)}">
            <span class="suggestion-chip-icon">${s.icon}</span>
            <span class="suggestion-chip-text">${s.text}</span>
          </button>
        `
      )
      .join('')}
    </div>
  `;

  return el;
}
