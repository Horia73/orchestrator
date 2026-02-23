import { renderMarkdown, attachMarkdownHandlers } from '../utils/markdown.js';

const WORKFLOW_STATUS_LABELS = {
  running: 'Running',
  done: 'Done',
  error: 'Error',
  waiting: 'Waiting',
};

export function createMessage(message) {
  const el = document.createElement('div');
  el.className = `message ${message.role}`;
  el.dataset.messageId = message.id;

  const hasContent = message.content && message.content.trim().length > 0;

  if (message.role === 'system') {
    el.innerHTML = renderSystemMessage(message);
  } else if (message.role === 'ai') {
    el.innerHTML = `
      <div class="message-content">
        ${hasContent ? `<div class="message-bubble">
          ${renderMarkdown(message.content)}
        </div>` : ''}
        ${message.attachments ? renderAttachments(message.attachments) : ''}
      </div>
    `;
    attachMarkdownHandlers(el);
  } else {
    // User messages — no avatar, just bubble (Claude style)
    el.innerHTML = `
      <div class="message-content">
        ${hasContent ? `<div class="message-bubble">
          ${escapeHtml(message.content)}
        </div>` : ''}
        ${message.attachments ? renderAttachments(message.attachments) : ''}
      </div>
    `;
  }

  return el;
}

function renderSystemMessage(message) {
  const kind = message.kind || 'info';
  const status = normalizeWorkflowStatus(message.status);

  if (kind === 'run') {
    const metrics = message.metrics || {};
    const toolDone = Number(metrics.toolDone || 0);
    const agentDone = Number(metrics.agentDone || 0);
    const todoDone = Number(metrics.todoDone || 0);

    const summaryText = `To-do ${todoDone} • Tools ${toolDone} • Agents ${agentDone} • ${formatRunDuration(message.startedAt, message.finishedAt)}`;
    const summaryHtml = `<span class="workflow-summary-inline">${escapeHtml(summaryText)}</span>`;

    return renderSystemCard({
      message,
      kindLabel: 'Run',
      title: message.title || 'Workflow run',
      status,
      summaryHtml,
      summaryInHeader: true,
      detailsHtml: '',
      collapsible: true,
      detailsClassName: 'workflow-body',
    });
  }

  if (kind === 'thinking') {
    const steps = Array.isArray(message.thinkingSteps) ? message.thinkingSteps : [];
    const detailsHtml = steps.length > 0
      ? `<ol class="workflow-thinking-list">
          ${steps.map((step) => `<li class="workflow-thinking-item">${escapeHtml(step || '')}</li>`).join('')}
        </ol>`
      : `<div class="workflow-empty">No thinking steps yet.</div>`;

    return renderSystemCard({
      message,
      kindLabel: 'Thinking',
      title: message.title || 'Reasoning trace',
      status,
      detailsHtml,
      collapsible: true,
      detailsClassName: 'workflow-body',
    });
  }

  if (kind === 'todo') {
    const items = Array.isArray(message.todoItems) ? message.todoItems : [];

    const detailsHtml = items.length > 0
      ? `<ul class="workflow-todo-list">
          ${items.map((item) => `
            <li class="workflow-todo-item ${item.done ? 'done' : ''}">
              <span class="workflow-todo-mark">${item.done ? '✓' : '○'}</span>
              <span class="workflow-todo-text">${escapeHtml(item.text || '')}</span>
            </li>
          `).join('')}
        </ul>`
      : `<div class="workflow-empty">No checklist items yet.</div>`;

    return renderSystemCard({
      message,
      kindLabel: 'To-do',
      title: message.title || 'Execution checklist',
      status,
      detailsHtml,
      collapsible: true,
      detailsClassName: 'workflow-body',
    });
  }

  if (kind === 'tool') {
    const toolType = resolveToolType(message);
    const toolAction = resolveToolAction(message);
    const isFsTool = toolType === 'fs';
    const shouldHighlightFs = isFsTool && isHighlightedFsAction(toolAction);
    const outputLines = Array.isArray(message.outputLines) ? message.outputLines : [];
    const outputText = outputLines.length > 0
      ? outputLines.join('\n')
      : status === 'running'
        ? (isFsTool ? 'Waiting for filesystem output...' : 'Waiting for terminal output...')
        : (isFsTool ? 'No filesystem output.' : 'No terminal output.');

    const commandClassName = isFsTool
      ? 'workflow-command workflow-command-fs'
      : 'workflow-command';
    const outputClassName = isFsTool
      ? 'workflow-terminal-output workflow-file-output'
      : 'workflow-terminal-output';
    const commandPrefix = isFsTool ? '' : '$ ';

    const detailsHtml = `
      ${message.command ? `<div class="${commandClassName}">${escapeHtml(`${commandPrefix}${message.command}`)}</div>` : ''}
      <pre class="${outputClassName}">${escapeHtml(outputText)}</pre>
    `;

    return renderSystemCard({
      message,
      kindLabel: 'Tool Calling',
      title: message.title || 'Terminal',
      status,
      detailsHtml,
      collapsible: true,
      detailsClassName: 'workflow-body',
      extraCardClasses: [
        isFsTool ? 'tool-fs' : '',
        shouldHighlightFs ? 'tool-fs-highlight' : '',
      ],
    });
  }

  if (kind === 'agent_call') {
    const agents = Array.isArray(message.agents) ? message.agents : [];
    const primaryAgent = agents[0] || null;

    return renderSystemCard({
      message,
      kindLabel: 'Agent Call',
      title: message.title || 'Agent invocation',
      status,
      detailsHtml: '',
      collapsible: false,
      detailsClassName: 'workflow-body',
      cardAgentId: primaryAgent?.id || '',
    });
  }

  if (kind === 'continue_prompt') {
    const reason = message.content
      ? `<div class="workflow-note">${escapeHtml(message.content)}</div>`
      : '';
    const prompt = String(message.continuationPrompt || '').trim();
    const detailsHtml = `
      ${reason}
      <div class="workflow-continue-actions">
        <button
          class="workflow-continue-btn"
          type="button"
          data-continue-msg-id="${escapeAttr(message.id)}"
          data-continue-prompt="${escapeAttr(prompt)}"
        >
          Continue
        </button>
      </div>
    `;

    return renderSystemCard({
      message,
      kindLabel: 'Continue',
      title: message.title || 'Need continuation',
      status,
      detailsHtml,
      collapsible: false,
      detailsClassName: 'workflow-body',
    });
  }

  const detailsHtml = message.content
    ? `<div class="workflow-note">${escapeHtml(message.content)}</div>`
    : '<div class="workflow-empty">No details available.</div>';

  return renderSystemCard({
    message,
    kindLabel: 'Workflow',
    title: message.title || 'Step',
    status,
    detailsHtml,
    collapsible: true,
    detailsClassName: 'workflow-body',
  });
}

function renderSystemCard({
  message,
  kindLabel,
  title,
  status,
  summaryHtml = '',
  summaryInHeader = false,
  detailsHtml,
  collapsible,
  detailsClassName = 'workflow-body',
  cardAgentId = '',
  extraCardClasses = [],
}) {
  const isCollapsed = collapsible ? Boolean(message.collapsed) : false;
  const collapseAttr = collapsible ? `data-collapse-msg-id="${escapeAttr(message.id)}"` : '';
  const collapseIcon = collapsible
    ? `<span class="workflow-collapse-icon">${isCollapsed ? '▶' : '▼'}</span>`
    : `<span class="workflow-collapse-icon" style="visibility: hidden">▶</span>`;
  const headerTag = collapsible ? 'button' : 'div';
  const headerExtra = collapsible ? 'type="button"' : '';
  const cardAgentAttr = cardAgentId ? `data-agent-card-id="${escapeAttr(cardAgentId)}"` : '';
  const cardClasses = [
    'workflow-card',
    escapeAttr(message.kind || 'info'),
    status,
    isCollapsed ? 'is-collapsed' : '',
    cardAgentId ? 'is-agent-clickable' : '',
    ...(Array.isArray(extraCardClasses) ? extraCardClasses : []),
  ].filter(Boolean).join(' ');
  const hasDetails = Boolean(detailsHtml && String(detailsHtml).trim().length > 0);

  return `
    <div class="message-content">
      <div class="${cardClasses}" ${cardAgentAttr}>
        <${headerTag} class="workflow-header ${collapsible ? 'workflow-header-btn' : ''}" ${headerExtra} ${collapseAttr}>
          <div class="workflow-header-left">
            <span class="workflow-kind">${escapeHtml(kindLabel)}</span>
            <span class="workflow-title">${escapeHtml(title)}</span>
          </div>
          <span class="workflow-header-right">
            ${summaryInHeader && summaryHtml ? summaryHtml : ''}
            <span class="workflow-status ${status}">${escapeHtml(WORKFLOW_STATUS_LABELS[status] || status)}</span>
            ${collapseIcon}
          </span>
        </${headerTag}>
        ${!summaryInHeader && summaryHtml ? `<div class="workflow-summary-block">${summaryHtml}</div>` : ''}
        ${hasDetails
      ? `<div class="${detailsClassName} ${isCollapsed ? 'is-hidden' : ''}">
              ${detailsHtml}
            </div>`
      : ''}
      </div>
    </div>
  `;
}

function normalizeWorkflowStatus(status) {
  if (!status) return 'running';
  if (status === 'done' || status === 'error' || status === 'waiting' || status === 'running') {
    return status;
  }
  return 'running';
}

function resolveToolType(message) {
  const direct = String(message?.toolType || '').trim().toLowerCase();
  if (direct) return direct;
  const metaAgent = String(message?.meta?.agent || '').trim().toLowerCase();
  if (metaAgent === 'fs' || metaAgent === 'filesystem' || metaAgent === 'file') return 'fs';
  return 'terminal';
}

function resolveToolAction(message) {
  const direct = String(message?.toolAction || '').trim().toLowerCase();
  if (direct) return direct;
  return String(message?.meta?.fsAction || '').trim().toLowerCase();
}

function isHighlightedFsAction(action) {
  return action === 'read_file' || action === 'search_files';
}

function renderAttachments(attachments) {
  if (!attachments || attachments.length === 0) return '';

  return `
    <div class="message-attachments">
      ${attachments.map(att => {
    const hasUrl = typeof att.url === 'string' && att.url.length > 0;
    if (isPdfAttachment(att)) {
      const unavailableHint = att.unavailableAfterReload
        ? 'Unavailable after page reload'
        : 'No preview URL available';

      return `<div class="attachment-preview attachment-pdf ${hasUrl ? '' : 'disabled'}">
            <div class="attachment-pdf-main">
              <div class="attachment-icon">📄</div>
              <div class="attachment-pdf-meta">
                <span class="attachment-name">${escapeHtml(att.name || 'document.pdf')}</span>
                <span class="attachment-pdf-type">PDF document</span>
              </div>
            </div>
            ${hasUrl
          ? `<button class="attachment-pdf-open-btn" type="button" data-open-pdf="1" data-pdf-url="${escapeAttr(att.url)}" data-pdf-name="${escapeAttr(att.name || 'document.pdf')}">Open PDF</button>`
          : `<button class="attachment-pdf-open-btn" type="button" disabled title="${escapeAttr(unavailableHint)}">Open PDF</button>`
        }
          </div>`;
    }
    if (hasUrl && att.type && att.type.startsWith('image/')) {
      return `<div class="attachment-preview attachment-image">
            <img src="${escapeAttr(att.url)}" alt="${escapeHtml(att.name)}" loading="lazy" />
            <a
              class="attachment-download-btn"
              href="${escapeAttr(att.url)}"
              download="${escapeAttr(att.name || 'image.png')}"
              target="_blank"
              rel="noopener noreferrer"
              title="Download image"
            >
              Download
            </a>
          </div>`;
    } else if (hasUrl && att.type && att.type.startsWith('video/')) {
      return `<div class="attachment-preview attachment-video">
            <video src="${escapeAttr(att.url)}" controls preload="metadata"></video>
          </div>`;
    } else if (hasUrl && att.type && att.type.startsWith('audio/')) {
      return `<div class="attachment-preview attachment-audio">
            <div class="audio-player">
              <audio src="${escapeAttr(att.url)}" preload="metadata"></audio>
              <button class="audio-play-btn" data-audio-url="${escapeAttr(att.url)}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              </button>
              <div class="audio-waveform-static">
                ${Array.from({ length: 24 }, () => `<div class="audio-bar-static" style="height:${3 + Math.random() * 14}px"></div>`).join('')}
              </div>
              <span class="audio-duration">0:00</span>
            </div>
          </div>`;
    } else {
      return `<div class="attachment-preview attachment-file">
            <div class="attachment-icon">📎</div>
            <span class="attachment-name">${escapeHtml(att.name)}</span>
          </div>`;
    }
  }).join('')}
    </div>
  `;
}

export function attachWorkflowHandlers(container, handlers = {}) {
  const { onAgentToggle, onToggleCollapse, onOpenPdf, onContinueRequest } = handlers;

  container.querySelectorAll('[data-agent-card-id]').forEach((card) => {
    if (card.dataset.agentCardBound === '1') return;
    card.dataset.agentCardBound = '1';
    card.addEventListener('click', () => {
      const agentId = card.dataset.agentCardId;
      if (!agentId || typeof onAgentToggle !== 'function') return;
      onAgentToggle(agentId);
    });
  });

  container.querySelectorAll('[data-collapse-msg-id]').forEach((btn) => {
    if (btn.dataset.collapseBound === '1') return;
    btn.dataset.collapseBound = '1';
    btn.addEventListener('click', () => {
      const messageId = btn.dataset.collapseMsgId;
      if (!messageId || typeof onToggleCollapse !== 'function') return;
      onToggleCollapse(messageId);
    });
  });

  container.querySelectorAll('[data-open-pdf]').forEach((btn) => {
    if (btn.dataset.pdfBound === '1') return;
    btn.dataset.pdfBound = '1';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const url = btn.dataset.pdfUrl;
      if (!url || typeof onOpenPdf !== 'function') return;
      onOpenPdf({
        url,
        name: btn.dataset.pdfName || 'document.pdf',
      });
    });
  });

  container.querySelectorAll('[data-continue-msg-id]').forEach((btn) => {
    if (btn.dataset.continueBound === '1') return;
    btn.dataset.continueBound = '1';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof onContinueRequest !== 'function') return;
      onContinueRequest({
        messageId: btn.dataset.continueMsgId || '',
        prompt: btn.dataset.continuePrompt || '',
      });
    });
  });
}

// Initialize audio players after message is added to DOM
export function initAudioPlayers(container) {
  container.querySelectorAll('.audio-play-btn').forEach(btn => {
    if (btn._initialized) return;
    btn._initialized = true;

    const player = btn.closest('.audio-player');
    const audio = player.querySelector('audio');
    const durationEl = player.querySelector('.audio-duration');
    const waveform = player.querySelector('.audio-waveform-static');
    const bars = waveform.querySelectorAll('.audio-bar-static');

    const playIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    const pauseIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';

    // Format time helper
    const fmt = (t) => {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    audio.addEventListener('loadedmetadata', () => {
      durationEl.textContent = fmt(audio.duration);
    });

    audio.addEventListener('ended', () => {
      btn.innerHTML = playIcon;
      player.classList.remove('playing');
      bars.forEach(b => b.classList.remove('active'));
    });

    audio.addEventListener('timeupdate', () => {
      const elapsed = audio.currentTime;
      const duration = audio.duration || 1;
      durationEl.textContent = fmt(elapsed);

      // Update waveform progress
      const percent = elapsed / duration;
      const activeCount = Math.floor(percent * bars.length);

      bars.forEach((bar, idx) => {
        if (idx < activeCount) bar.classList.add('active');
        else bar.classList.remove('active');
      });
    });

    // Seek functionality
    waveform.addEventListener('click', (e) => {
      const rect = waveform.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const width = rect.width;
      if (width > 0 && audio.duration) {
        const percent = Math.max(0, Math.min(1, x / width));
        audio.currentTime = percent * audio.duration;
      }
    });

    // Make waveform cursor pointer
    waveform.style.cursor = 'pointer';

    btn.addEventListener('click', () => {
      if (audio.paused) {
        // Pause all other audio
        document.querySelectorAll('.audio-player audio').forEach(a => {
          if (a !== audio) { a.pause(); a.currentTime = 0; }
        });
        document.querySelectorAll('.audio-player').forEach(p => {
          p.classList.remove('playing');
          p.querySelectorAll('.audio-bar-static').forEach(b => b.classList.remove('active'));
        });
        document.querySelectorAll('.audio-play-btn').forEach(b => { b.innerHTML = playIcon; });

        audio.play();
        btn.innerHTML = pauseIcon;
        player.classList.add('playing');
      } else {
        audio.pause();
        btn.innerHTML = playIcon;
        player.classList.remove('playing');
      }
    });
  });
}

export function createTypingIndicator() {
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = 'typing-indicator';

  el.innerHTML = `
    <div class="typing-dots">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
  `;

  return el;
}

export function createStreamingMessage() {
  const el = document.createElement('div');
  el.className = 'message ai';
  el.id = 'streaming-message';

  el.innerHTML = `
    <div class="message-content">
      <div class="message-bubble"></div>
    </div>
  `;

  return el;
}

export function updateStreamingMessage(el, content) {
  const bubble = el.querySelector('.message-bubble');
  if (bubble) {
    bubble.innerHTML = renderMarkdown(content);
    attachMarkdownHandlers(el);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function escapeAttr(text) {
  return escapeHtml(String(text));
}

function isPdfAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return false;
  if (attachment.type === 'application/pdf') return true;
  return typeof attachment.name === 'string' && attachment.name.toLowerCase().endsWith('.pdf');
}

function formatRunDuration(startedAt, finishedAt) {
  if (!startedAt) return '0s';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '0s';
  const totalSec = Math.max(0, Math.round((end - start) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
