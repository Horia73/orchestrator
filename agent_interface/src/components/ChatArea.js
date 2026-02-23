import { store } from '../state/store.js';
import {
  createMessage,
  createTypingIndicator,
  createStreamingMessage,
  updateStreamingMessage,
  initAudioPlayers,
  attachWorkflowHandlers,
} from './Message.js';
import { createWelcomeScreen } from './WelcomeScreen.js';
import { createInputArea } from './InputArea.js';
import { createAgentDetailPanel, agentManager } from './AgentPanel.js';
import { createPdfViewerModal } from './PdfViewerModal.js';
import { loadContextStatus, persistAttachments, streamResponse } from '../services/api.js';

const ICONS = {
  menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>',
  scrollDown: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>',
};

export function createChatArea() {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-area-wrapper';

  const el = document.createElement('main');
  el.className = 'chat-main';

  const header = document.createElement('div');
  header.className = 'chat-header';

  const messagesWrapper = document.createElement('div');
  messagesWrapper.className = 'chat-messages-wrapper';

  const messagesContainer = document.createElement('div');
  messagesContainer.className = 'chat-messages';
  messagesContainer.id = 'chat-messages';
  messagesWrapper.appendChild(messagesContainer);

  const messagesInner = document.createElement('div');
  messagesInner.className = 'chat-messages-inner';
  messagesInner.id = 'chat-messages-inner';
  messagesContainer.appendChild(messagesInner);

  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'scroll-to-bottom-btn';
  scrollBtn.id = 'scroll-to-bottom';
  scrollBtn.innerHTML = ICONS.scrollDown;
  scrollBtn.title = 'Scroll to bottom';
  scrollBtn.addEventListener('click', () => scrollToBottom(true));
  messagesWrapper.appendChild(scrollBtn);

  let scrollBtnVisible = false;
  messagesContainer.addEventListener('scroll', () => {
    const distFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    const shouldShow = distFromBottom > 150;
    if (shouldShow !== scrollBtnVisible) {
      scrollBtnVisible = shouldShow;
      scrollBtn.classList.toggle('visible', shouldShow);
    }
  });

  const inputArea = createInputArea();
  const detailPanel = createAgentDetailPanel();
  const pdfViewer = createPdfViewerModal({
    onQuote: ({ text }) => {
      if (typeof inputArea.insertIntoDraft === 'function') {
        inputArea.insertIntoDraft(text);
      }
    },
  });

  el.appendChild(header);
  el.appendChild(messagesWrapper);
  el.appendChild(inputArea);

  wrapper.appendChild(el);
  wrapper.appendChild(detailPanel);
  wrapper.appendChild(pdfViewer.element);

  let isStreaming = false;
  let messageQueue = [];
  let saveThrottleTimer = null;
  let abortController = null;
  let contextDraft = { content: '', attachments: [] };
  let contextRefreshTimer = null;
  let contextRequestSeq = 0;
  let contextRefreshAbort = null;

  function normalizeDraftAttachments(input) {
    if (!Array.isArray(input)) return [];
    return input.map((attachment) => ({
      name: String(attachment?.name || '').trim(),
      type: String(attachment?.type || '').trim(),
      size: Number(attachment?.size) || 0,
      url: String(attachment?.url || '').trim(),
    }));
  }

  function scheduleContextRefresh({ immediate = false } = {}) {
    if (contextRefreshTimer) {
      clearTimeout(contextRefreshTimer);
      contextRefreshTimer = null;
    }

    if (immediate) {
      void refreshContextMeter();
      return;
    }

    contextRefreshTimer = setTimeout(() => {
      contextRefreshTimer = null;
      void refreshContextMeter();
    }, 420);
  }

  async function refreshContextMeter() {
    if (contextRefreshAbort) {
      contextRefreshAbort.abort();
      contextRefreshAbort = null;
    }

    const conv = store.getActiveConversation();
    const conversationId = conv?.id || '';
    const requestSeq = ++contextRequestSeq;
    const controller = new AbortController();
    contextRefreshAbort = controller;

    try {
      const context = await loadContextStatus(
        contextDraft.content,
        conversationId,
        contextDraft.attachments,
        controller.signal
      );

      if (requestSeq !== contextRequestSeq) return;
      inputArea.setContextMeter(context || {});
    } catch (error) {
      if (controller.signal.aborted) return;
      if (requestSeq !== contextRequestSeq) return;
      inputArea.setContextMeter({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (contextRefreshAbort === controller) {
        contextRefreshAbort = null;
      }
    }
  }

  function renderHeader() {
    const conv = store.getActiveConversation();
    const assistant = store.getAssistantProfile();
    const assistantName = assistant?.name || 'AI Chat';
    const assistantEmoji = assistant?.emoji || '🤖';
    const fallbackTitle = `${assistantEmoji} ${assistantName}`;
    document.title = conv ? `${conv.title} · ${assistantName}` : assistantName;
    header.innerHTML = `
      <button class="menu-toggle" id="menu-toggle" aria-label="Toggle sidebar">
        ${ICONS.menu}
      </button>
      <div class="chat-header-title">
        ${conv ? escapeHtml(conv.title) : escapeHtml(fallbackTitle)}
      </div>
      <button class="chat-header-browser-btn" id="chat-open-browser-btn" type="button">
        Open Browser
      </button>
    `;

    header.querySelector('#menu-toggle')?.addEventListener('click', () => {
      store.toggleSidebar();
    });
    header.querySelector('#chat-open-browser-btn')?.addEventListener('click', () => {
      const browserAgentId = agentManager.ensureBrowserConsoleAgent(store.getState().activeConversationId);
      if (!browserAgentId) return;
      agentManager.focusAgent(browserAgentId);
    });
  }

  function renderMessages() {
    const messages = store.getMessages();
    const conv = store.getActiveConversation();

    messagesInner.innerHTML = '';

    if (!conv || messages.length === 0) {
      const welcome = createWelcomeScreen(store.getAssistantProfile());
      messagesInner.appendChild(welcome);
      welcome.querySelectorAll('.suggestion-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const text = decodeURIComponent(chip.dataset.suggestion);
          void handleSendMessage(text);
        });
      });
      return;
    }

    const runGroupBodies = new Map();
    messages.forEach((msg) => {
      if (msg.role === 'system' && msg.kind === 'run' && msg.runId) {
        const wrapper = document.createElement('div');
        wrapper.className = 'workflow-run-group';
        wrapper.dataset.runId = msg.runId;
        if (msg.collapsed) {
          wrapper.classList.add('is-collapsed');
        }

        const body = document.createElement('div');
        body.className = 'workflow-run-body';

        wrapper.appendChild(createMessage(msg));
        wrapper.appendChild(body);
        messagesInner.appendChild(wrapper);
        runGroupBodies.set(msg.runId, body);
        return;
      }

      if (msg.runId && runGroupBodies.has(msg.runId)) {
        runGroupBodies.get(msg.runId)?.appendChild(createMessage(msg));
        return;
      }

      messagesInner.appendChild(createMessage(msg));
    });

    bindMessageInteractions(messagesInner);
    smartScroll();
  }

  function bindMessageInteractions(container) {
    attachWorkflowHandlers(container, {
      onAgentToggle: (agentId) => {
        if (!agentManager.getAgent(agentId)) {
          const sourceMessage = store.getMessages().find(
            (message) => message.kind === 'agent_call'
              && Array.isArray(message.agents)
              && message.agents.some((agent) => agent.id === agentId)
          );
          const snapshot = sourceMessage?.agents?.find((agent) => agent.id === agentId);
          if (snapshot) {
            agentManager.ensureAgent(snapshot, {
              convId: sourceMessage.conversationId,
              msgId: sourceMessage.id,
              task: sourceMessage.title || 'Agent execution',
            });
          }
        }

        if (!agentManager.getAgent(agentId)) return;
        agentManager.selectAgent(agentId);
      },
      onOpenPdf: ({ url, name }) => {
        pdfViewer.open({ url, name });
      },
      onToggleCollapse: async (messageId) => {
        const message = store.getMessages().find((item) => item.id === messageId);
        if (!message) return;
        const wasCollapsed = Boolean(message.collapsed);
        const updatedMessage = await store.updateMessage(messageId, {
          collapsed: !wasCollapsed,
        });
        replaceMessageElement(updatedMessage, { autoStick: false });
        if (wasCollapsed && !updatedMessage.collapsed) {
          ensureExpandedCardVisibility(updatedMessage.id);
        }
      },
      onContinueRequest: async ({ messageId, prompt }) => {
        const message = store.getMessages().find((item) => item.id === messageId);
        if (!message) return;
        await store.updateMessageById(messageId, { status: 'done' });
        const continuePrompt = String(prompt || '').trim()
          || 'Continua executia agentica de unde ai ramas in mesajul anterior. Nu repeta pasii finalizati; continua doar pasii ramasi.';
        void handleSendMessage(continuePrompt);
      },
    });
    initAudioPlayers(container);
  }

  function findMessageElementById(messageId) {
    return [...messagesInner.querySelectorAll('.message')].find((node) => node.dataset.messageId === messageId) || null;
  }

  function findRunGroupById(runId) {
    return [...messagesInner.querySelectorAll('.workflow-run-group')].find((node) => node.dataset.runId === runId) || null;
  }

  function findRunGroupBodyById(runId) {
    const group = findRunGroupById(runId);
    if (!group) return null;
    return group.querySelector('.workflow-run-body');
  }

  function setRunGroupCollapsed(runId, collapsed) {
    const group = findRunGroupById(runId);
    if (!group) return;
    group.classList.toggle('is-collapsed', Boolean(collapsed));
  }

  function ensureRunGroup(message) {
    if (!message?.runId) return null;
    let group = findRunGroupById(message.runId);
    if (group) {
      const header = group.querySelector(`.message[data-message-id="${message.id}"]`);
      if (!header) {
        const headerEl = createMessage(message);
        const body = group.querySelector('.workflow-run-body');
        if (body) {
          group.insertBefore(headerEl, body);
        } else {
          group.prepend(headerEl);
        }
      }
      setRunGroupCollapsed(message.runId, Boolean(message.collapsed));
      return group;
    }

    group = document.createElement('div');
    group.className = 'workflow-run-group';
    group.dataset.runId = message.runId;
    if (message.collapsed) {
      group.classList.add('is-collapsed');
    }

    const body = document.createElement('div');
    body.className = 'workflow-run-body';

    group.appendChild(createMessage(message));
    group.appendChild(body);
    messagesInner.appendChild(group);
    return group;
  }

  function ensureExpandedCardVisibility(messageId) {
    const messageEl = findMessageElementById(messageId);
    if (!messageEl) return;

    const containerRect = messagesContainer.getBoundingClientRect();
    const messageRect = messageEl.getBoundingClientRect();
    const padding = 12;

    if (messageRect.bottom > containerRect.bottom - padding) {
      const diff = messageRect.bottom - (containerRect.bottom - padding);
      messagesContainer.scrollTop += diff;
    } else if (messageRect.top < containerRect.top + padding) {
      const diff = containerRect.top + padding - messageRect.top;
      messagesContainer.scrollTop -= diff;
    }
  }

  function appendMessageElement(message, options = {}) {
    if (!message) return;
    const { autoStick = true } = options;
    const shouldStick = autoStick && isNearBottom();
    const el = createMessage(message);

    if (message.kind === 'run' && message.runId) {
      ensureRunGroup(message);
    } else if (message.runId) {
      const runBody = findRunGroupBodyById(message.runId);
      if (runBody) {
        runBody.appendChild(el);
      } else {
        messagesInner.appendChild(el);
      }
    } else {
      messagesInner.appendChild(el);
    }

    bindMessageInteractions(messagesInner);
    if (shouldStick) scrollToBottom();
  }

  function replaceMessageElement(message, options = {}) {
    if (!message) return;
    const existing = findMessageElementById(message.id);
    if (!existing) {
      appendMessageElement(message, options);
      return;
    }
    const { autoStick = true } = options;
    const shouldStick = autoStick && isNearBottom();
    const next = createMessage(message);

    // Patch in place so the message node is not remounted.
    // This avoids replaying the message enter animation on every incremental update.
    existing.className = next.className;
    existing.innerHTML = next.innerHTML;
    existing.dataset.messageId = next.dataset.messageId;

    if (message.kind === 'run' && message.runId) {
      setRunGroupCollapsed(message.runId, Boolean(message.collapsed));
    }

    bindMessageInteractions(messagesInner);
    if (shouldStick) scrollToBottom();
  }

  async function handleSendMessage(content, attachments) {
    const hasText = typeof content === 'string' && content.trim().length > 0;
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!hasText && !hasAttachments) return;

    if (isStreaming) {
      messageQueue.push({ content, attachments });
      return;
    }

    let next = { content, attachments };
    while (next) {
      try {
        await processMessage(next.content, next.attachments);
      } catch (error) {
        console.error('Failed to process queued message:', error);
        break;
      }
      next = messageQueue.length > 0 ? messageQueue.shift() : null;
    }
  }

  async function processMessage(content, attachments) {
    let conv = store.getActiveConversation();
    let createdNew = false;
    if (!conv) {
      conv = await store.createConversation();
      createdNew = true;
    }

    if (createdNew) {
      prevConvId = conv.id;
    }

    const conversationId = conv.id;
    const isCurrentConversation = () => store.getState().activeConversationId === conversationId;

    isStreaming = true;
    abortController = new AbortController();
    const localAbort = abortController;

    if (inputArea.setBusy) inputArea.setBusy(true);

    const persistedAttachments = await persistAttachments(attachments, conversationId, localAbort.signal);
    const userMsg = await store.addMessage('user', content, persistedAttachments);
    if (!userMsg) {
      isStreaming = false;
      if (inputArea.setBusy) inputArea.setBusy(false);
      return;
    }

    store.setStreamingState(conversationId, content);
    renderMessages();

    const typingIndicator = createTypingIndicator();
    let responseMessageCreated = false;
    let responseMessageId = null;
    let runContext = null;
    let responseEnvelope = {
      content: '',
      conversationId,
      meta: null,
    };

    try {
      runContext = await runWorkflowPrelude(content, conversationId, userMsg.id, localAbort.signal);

      if (localAbort.signal.aborted) throw new Error('Aborted');

      messagesInner.appendChild(typingIndicator);
      smartScroll();

      await waitFor(450, localAbort.signal);

      if (typingIndicator.parentNode) typingIndicator.remove();
      const responseMessage = await store.addMessage('ai', '');
      responseMessageCreated = Boolean(responseMessage);
      responseMessageId = responseMessage?.id || null;

      const streamingEl = createStreamingMessage();
      messagesInner.appendChild(streamingEl);
      smartScroll();

      await new Promise((resolve, reject) => {
        let liveAgentIndex = 0;
        let createdRunMessage = false;

        streamResponse(
          content,
          conversationId,
          (accumulated) => {
            if (!isCurrentConversation()) return;
            const shouldScroll = isNearBottom();
            updateStreamingMessage(streamingEl, accumulated);
            if (shouldScroll) scrollToBottom();

            if (!saveThrottleTimer) {
              saveThrottleTimer = setTimeout(() => {
                if (responseMessageId) {
                  void store.updateMessageById(responseMessageId, { content: accumulated });
                }
                saveThrottleTimer = null;
              }, 500);
            }
          },
          async (callInfo) => {
            if (!isCurrentConversation()) return;
            if (!createdRunMessage && runContext) {
              createdRunMessage = true;
              const runStartedAt = runContext.startedAt || new Date().toISOString();
              const runMessage = await store.addMessage('system', '', null, {
                kind: 'run',
                runId: runContext.runId,
                title: 'Orchestrator run',
                status: 'running',
                startedAt: runStartedAt,
                collapsed: false,
                metrics: { toolDone: 0, agentDone: 0, todoDone: 1 },
                meta: { route: 'agents', execution: 'sequential' }
              });
              runContext.runMessageId = runMessage?.id || null;
            } else if (runContext?.runMessageId) {
              const runMsg = store.getMessages().find(m => m.id === runContext.runMessageId);
              const metrics = runMsg?.metrics || { toolDone: 0, agentDone: 0, todoDone: 0 };
              await store.updateMessageById(runContext.runMessageId, {
                metrics: { ...metrics, todoDone: metrics.todoDone + 1 }
              });
            }

            liveAgentIndex += 1;
            const agentNameStr = callInfo.agent;
            const agentName = labelForAgent(agentNameStr);
            const agentId = `${runContext.runId}_${agentNameStr}_${liveAgentIndex}`;
            callInfo._uiId = agentId;
            callInfo._uiName = agentName;

            if (isToolAgent(agentNameStr)) {
              const toolSeed = buildToolMessageSeed(callInfo);
              const newMsg = await store.addMessage('system', '', null, {
                kind: 'tool',
                runId: runContext.runId,
                title: toolSeed.title,
                status: 'running',
                command: toolSeed.command,
                outputLines: [],
                toolType: toolSeed.toolType,
                toolAction: toolSeed.toolAction,
                meta: {
                  agent: agentNameStr,
                  timeoutMs: callInfo?.timeoutMs || null,
                  ...(toolSeed.meta || {}),
                },
                _clientId: agentId
              });
              callInfo._msgId = newMsg?.id || null;
            } else {
              const newMsg = await store.addMessage('system', '', null, {
                kind: 'agent_call',
                runId: runContext.runId,
                title: agentName,
                status: 'running',
                agents: [
                  buildAgentSnapshot({
                    id: agentId,
                    name: agentName,
                    kind: normalizeAgentName(agentNameStr),
                    state: 'thinking',
                    logs: []
                  }, agentName)
                ],
                meta: { agent: agentNameStr },
                _clientId: agentId
              });
              callInfo._msgId = newMsg?.id || null;
            }
          },
          async (callInfo, resultPayload) => {
            if (!isCurrentConversation() || !callInfo._msgId) return;
            const ok = Boolean(resultPayload?.ok);
            const status = ok ? 'done' : 'error';
            const agentNameStr = callInfo.agent;

            if (isToolAgent(agentNameStr)) {
              const toolSeed = buildToolMessageSeed(callInfo, resultPayload);
              const outputLines = agentNameStr === 'terminal'
                ? buildTerminalOutputLines(callInfo, resultPayload)
                : buildFsOutputLines(callInfo, resultPayload);
              await store.updateMessageById(callInfo._msgId, {
                status,
                command: toolSeed.command,
                outputLines,
                toolType: toolSeed.toolType,
                toolAction: toolSeed.toolAction,
                meta: {
                  agent: agentNameStr,
                  timeoutMs: callInfo?.timeoutMs || null,
                  ...(toolSeed.meta || {}),
                },
              });
            } else {
              await store.updateMessageById(callInfo._msgId, {
                status,
                agents: [
                  buildAgentSnapshot({
                    id: callInfo._uiId,
                    name: callInfo._uiName,
                    kind: normalizeAgentName(agentNameStr),
                    state: status,
                    logs: buildAgentTimelineLogs(callInfo, resultPayload)
                  }, callInfo._uiName)
                ]
              });
            }

            if (runContext?.runMessageId) {
              const runMsg = store.getMessages().find(m => m.id === runContext.runMessageId);
              const metrics = runMsg?.metrics || { toolDone: 0, agentDone: 0, todoDone: 1 };
              if (isToolAgent(agentNameStr)) {
                metrics.toolDone += (ok ? 1 : 0);
              } else {
                metrics.agentDone += (ok ? 1 : 0);
              }
              await store.updateMessageById(runContext.runMessageId, { metrics });
            }
          },
          (finalPayload) => {
            const normalizedPayload = normalizeFinalPayload(finalPayload, conversationId);
            responseEnvelope = normalizedPayload;

            if (saveThrottleTimer) {
              clearTimeout(saveThrottleTimer);
              saveThrottleTimer = null;
            }

            const text = normalizedPayload.content || (localAbort.signal.aborted ? 'Stopped.' : '');
            const responseAttachments = Array.isArray(normalizedPayload.attachments)
              ? normalizedPayload.attachments
              : null;
            if (responseMessageId) {
              void store.updateMessageById(responseMessageId, {
                content: text,
                attachments: responseAttachments,
              });
            }

            isStreaming = false;
            if (inputArea.setBusy) inputArea.setBusy(false);
            clearStreamingStateForConversation(conversationId);
            scheduleContextRefresh({ immediate: true });

            if (!isCurrentConversation()) {
              if (streamingEl && streamingEl.parentNode) {
                streamingEl.remove();
              }
              resolve();
              return;
            }

            const finalMessage = responseMessageId
              ? store.getMessages().find((message) => message.id === responseMessageId)
              : store.getLastMessage();
            if (finalMessage && streamingEl && streamingEl.parentNode) {
              const finalEl = createMessage(finalMessage);
              streamingEl.replaceWith(finalEl);
            }

            bindMessageInteractions(messagesInner);
            smartScroll();
            resolve();
          },
          localAbort.signal,
          persistedAttachments
        ).catch((err) => {
          reject(err);
        });
      });

      await renderWorkflowFromMeta(runContext, responseEnvelope.meta);
      if (isCurrentConversation()) {
        renderMessages();
      }
    } catch (error) {
      console.error('Error getting response:', error);
      if (saveThrottleTimer) {
        clearTimeout(saveThrottleTimer);
        saveThrottleTimer = null;
      }
      if (typingIndicator.parentNode) typingIndicator.remove();

      isStreaming = false;
      if (inputArea.setBusy) inputArea.setBusy(false);
      clearStreamingStateForConversation(conversationId);

      const switchedConversation = !isCurrentConversation();

      const fallback = error.message === 'Aborted'
        ? 'Stopped.'
        : 'Sorry, there was an error. Please try again.';

      if (!switchedConversation && responseMessageCreated && responseMessageId) {
        void store.updateMessageById(responseMessageId, { content: fallback });
      } else if (!switchedConversation) {
        void store.addMessage('ai', fallback);
      }

      if (runContext?.runMessageId) {
        await updateRunStatus(runContext.runMessageId, 'error');
      }
      if (!switchedConversation) {
        renderMessages();
      }
      scheduleContextRefresh({ immediate: true });
    }
  }

  async function runWorkflowPrelude() {
    return {
      runId: createRunId(),
      runMessageId: null,
      startedAt: new Date().toISOString(),
    };
  }

  async function renderWorkflowFromMeta(runContext, meta) {
    if (!runContext?.runId) return;

    const calls = Array.isArray(meta?.agentCalls) ? meta.agentCalls : [];
    const results = Array.isArray(meta?.agentResults) ? meta.agentResults : [];
    if (meta?.route !== 'agents' || calls.length === 0) {
      return;
    }

    if (runContext.runMessageId) {
      const hasErrors = results.some(r => !r?.ok);
      await updateRunStatus(runContext.runMessageId, hasErrors ? 'error' : 'done');
      await upsertContinuationPrompt(runContext, meta);
      return;
    }

    const runStartedAt = runContext.startedAt || new Date().toISOString();
    const runMessage = await store.addMessage('system', '', null, {
      kind: 'run',
      runId: runContext.runId,
      title: 'Orchestrator run',
      status: 'running',
      startedAt: runStartedAt,
      collapsed: false,
      metrics: {
        toolDone: 0,
        agentDone: 0,
        todoDone: calls.length,
      },
      meta: {
        route: meta.route,
        execution: meta.execution,
        rationale: meta.rationale || '',
      },
    });

    runContext.runMessageId = runMessage?.id || null;
    if (!runContext.runMessageId) return;

    let toolDone = 0;
    let agentDone = 0;
    let hasErrors = false;

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index] || {};
      const result = results[index] || null;
      const agent = normalizeAgentName(call.agent || result?.agent || '');
      const ok = Boolean(result?.ok);
      const status = ok ? 'done' : 'error';
      if (!ok) hasErrors = true;

      if (isToolAgent(agent)) {
        const toolSeed = buildToolMessageSeed(call, result);
        if (ok) {
          toolDone += 1;
        }

        await store.addMessage('system', '', null, {
          kind: 'tool',
          runId: runContext.runId,
          title: toolSeed.title,
          status,
          command: toolSeed.command,
          outputLines: agent === 'terminal'
            ? buildTerminalOutputLines(call, result)
            : buildFsOutputLines(call, result),
          collapsed: false,
          toolType: toolSeed.toolType,
          toolAction: toolSeed.toolAction,
          meta: {
            agent,
            timeoutMs: call?.timeoutMs || null,
            ...(toolSeed.meta || {}),
          },
        });
        continue;
      }

      if (ok) {
        agentDone += 1;
      }

      const agentName = labelForAgent(agent);
      const agentId = `${runContext.runId}_${agent}_${index + 1}`;
      await store.addMessage('system', '', null, {
        kind: 'agent_call',
        runId: runContext.runId,
        title: agentName,
        status,
        agents: [
          buildAgentSnapshot({
            id: agentId,
            name: agentName,
            kind: agent,
            state: ok ? 'done' : 'error',
            logs: buildAgentTimelineLogs(call, result),
          }, agentName),
        ],
        collapsed: false,
        meta: {
          agent,
          timeoutMs: call?.timeoutMs || null,
        },
      });
    }

    await updateRunStatus(runContext.runMessageId, hasErrors ? 'error' : 'done', {
      metrics: {
        toolDone,
        agentDone,
        todoDone: calls.length,
      },
    });
    await upsertContinuationPrompt(runContext, meta);
  }

  async function updateRunStatus(runMessageId, status, extraPatch = {}) {
    const patch = {
      status,
      ...extraPatch,
    };

    if (status === 'done' || status === 'error') {
      patch.finishedAt = new Date().toISOString();
    }

    const updatedRun = await store.updateMessageById(runMessageId, patch);
    if (!updatedRun) return;
    if (store.getState().activeConversationId !== updatedRun.conversationId) return;
    replaceMessageElement(updatedRun);
  }

  async function upsertContinuationPrompt(runContext, meta) {
    if (!runContext?.runId) return;
    if (!meta?.continuationNeeded) return;

    const continuationPrompt = String(meta.continuationPrompt || '').trim()
      || 'Continua executia agentica de unde ai ramas in mesajul anterior. Nu repeta pasii finalizati; continua doar pasii ramasi.';
    const reason = String(meta.continuationReason || '').trim()
      || 'S-a atins limita de iteratii pentru acest run.';
    const title = (Number(meta?.iterationsUsed) > 0 && Number(meta?.maxIterations) > 0)
      ? `Need Continue (${Number(meta.iterationsUsed)}/${Number(meta.maxIterations)})`
      : 'Need Continue';

    const existing = store.getMessages().find((message) => {
      return message?.kind === 'continue_prompt' && message?.runId === runContext.runId;
    });

    if (existing) {
      await store.updateMessageById(existing.id, {
        status: 'waiting',
        title,
        content: reason,
        continuationPrompt,
      });
      return;
    }

    await store.addMessage('system', '', null, {
      kind: 'continue_prompt',
      runId: runContext.runId,
      status: 'waiting',
      title,
      content: reason,
      continuationPrompt,
    });
  }

  function clearStreamingStateForConversation(conversationId) {
    const streamingState = store.getStreamingState();
    if (streamingState?.conversationId === conversationId) {
      store.clearStreamingState();
    }
  }

  async function finalizeInFlightWorkflow(conversationId, reason = 'Conversation changed') {
    if (!conversationId) return;

    const snapshot = store.getMessages().filter((message) => message.conversationId === conversationId);
    if (snapshot.length === 0) return;

    const pendingSystemMessages = snapshot.filter(
      (message) => message.role === 'system' && (message.status === 'running' || message.status === 'waiting')
    );

    const finishedAt = new Date().toISOString();
    for (const message of pendingSystemMessages) {
      const patch = {
        status: 'error',
      };

      if (typeof message.collapsed === 'boolean') {
        patch.collapsed = false;
      }

      if (message.kind === 'run') {
        patch.finishedAt = finishedAt;
      }

      if (message.kind === 'tool') {
        const existingLines = Array.isArray(message.outputLines) ? [...message.outputLines] : [];
        const stopLine = `[stop] ${reason}`;
        if (existingLines[existingLines.length - 1] !== stopLine) {
          existingLines.push(stopLine);
        }
        patch.outputLines = existingLines;
      }

      await store.updateMessageById(message.id, patch);
    }

    const lastAi = [...snapshot].reverse().find((message) => message.role === 'ai');
    if (lastAi && (!lastAi.content || lastAi.content.trim().length === 0)) {
      await store.updateMessageById(lastAi.id, { content: 'Stopped.' });
    }
  }

  function isNearBottom() {
    const distFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    return distFromBottom < 100;
  }

  function smartScroll() {
    if (isNearBottom()) {
      requestAnimationFrame(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      });
    }
  }

  function scrollToBottom(smooth = false) {
    requestAnimationFrame(() => {
      if (smooth) {
        messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
      } else {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    });
  }

  function focusInput() {
    setTimeout(() => {
      el.querySelector('#chat-input')?.focus();
    }, 50);
  }

  el.addEventListener('draft-changed', (event) => {
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
    contextDraft = {
      content: String(detail.content || ''),
      attachments: normalizeDraftAttachments(detail.attachments),
    };
    scheduleContextRefresh();
  });

  el.addEventListener('send-message', (e) => {
    void handleSendMessage(e.detail.content, e.detail.attachments);
  });

  el.addEventListener('stop-generation', () => {
    if (abortController) {
      abortController.abort();
    }
  });

  let prevConvId = store.getState().activeConversationId;
  let prevLoading = store.getState().loading;
  let prevAssistantSignature = JSON.stringify(store.getState().assistantProfile || {});
  store.subscribe((state) => {
    renderHeader();
    const conversationChanged = state.activeConversationId !== prevConvId;
    const loadingChanged = state.loading !== prevLoading;
    const nextAssistantSignature = JSON.stringify(state.assistantProfile || {});
    const assistantChanged = nextAssistantSignature !== prevAssistantSignature;
    prevAssistantSignature = nextAssistantSignature;

    if (conversationChanged) {
      const previousConvId = prevConvId;
      prevConvId = state.activeConversationId;

      if (abortController) {
        void finalizeInFlightWorkflow(previousConvId, 'Conversation changed');
        abortController.abort();
      }
      isStreaming = false;
      clearStreamingStateForConversation(previousConvId);
      if (inputArea.setBusy) inputArea.setBusy(false);

      messageQueue = [];
      agentManager.setActiveConversation(state.activeConversationId);

      if (state.loading) {
        messagesInner.innerHTML = '';
      } else {
        renderMessages();
      }
      scheduleContextRefresh({ immediate: true });
      focusInput();
    } else if (loadingChanged) {
      renderMessages();
      scheduleContextRefresh({ immediate: true });
    } else if (assistantChanged) {
      renderMessages();
      scheduleContextRefresh({ immediate: true });
    }

    prevLoading = state.loading;
  });

  renderHeader();
  agentManager.setActiveConversation(store.getState().activeConversationId);
  renderMessages();
  scheduleContextRefresh({ immediate: true });
  focusInput();

  return wrapper;
}

function buildAgentSnapshot(agent, fallbackName) {
  const snapshot = {
    id: agent?.id || '',
    name: agent?.name || fallbackName || 'Agent',
    state: agent?.state || 'thinking',
  };

  const kind = String(agent?.kind || '').trim().toLowerCase();
  if (kind) {
    snapshot.kind = kind;
  }

  const logs = Array.isArray(agent?.logs)
    ? agent.logs
      .map((line) => String(line || '').trim())
      .filter(Boolean)
    : [];
  if (logs.length > 0) {
    snapshot.logs = logs;
  }

  return snapshot;
}

function createRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeFinalPayload(payload, fallbackConversationId) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      content: typeof payload.content === 'string' ? payload.content : '',
      conversationId: payload.conversationId || fallbackConversationId,
      attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
      meta: payload.meta || null,
    };
  }

  return {
    content: String(payload || ''),
    conversationId: fallbackConversationId,
    attachments: [],
    meta: null,
  };
}

function normalizeAgentName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'terminal' || raw === 'shell' || raw === 'cmd') return 'terminal';
  if (raw === 'fs' || raw === 'filesystem' || raw === 'file') return 'fs';
  if (raw === 'browser') return 'browser';
  return raw || 'agent';
}

function labelForAgent(agent) {
  if (agent === 'terminal') return 'Terminal Agent';
  if (agent === 'fs') return 'Filesystem Tool';
  if (agent === 'browser') return 'Browser Agent';
  return 'Agent';
}

function buildTerminalOutputLines(call, result) {
  const command = String(result?.command || call?.goal || '').trim();
  const lines = [];

  if (Array.isArray(result?.timeline) && result.timeline.length > 0) {
    for (const line of result.timeline) {
      const text = String(line || '').trim();
      if (!text) continue;
      if (command && text === `$ ${command}`) continue;
      lines.push(text);
    }
  }

  if (lines.length === 0) {
    const stdoutLines = String(result?.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `[stdout] ${line}`);
    const stderrLines = String(result?.stderr || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `[stderr] ${line}`);
    lines.push(...stdoutLines, ...stderrLines);
  }

  if (result?.timedOut) {
    lines.push('[timeout] Command timed out.');
  }
  if (result?.aborted) {
    lines.push('[stop] Command aborted.');
  }
  if (Number.isInteger(result?.exitCode)) {
    lines.push(`[exit] ${result.exitCode}`);
  }
  if (result?.stdoutTruncated || result?.stderrTruncated) {
    lines.push('[info] Output truncated.');
  }
  if (!result?.ok && result?.error) {
    lines.push(`[error] ${String(result.error)}`);
  }

  if (lines.length === 0) {
    lines.push(result?.ok ? '[ok] Command completed.' : '[error] Command failed.');
  }

  return lines.slice(0, 80);
}

function isToolAgent(agent) {
  const normalized = normalizeAgentName(agent);
  return normalized === 'terminal' || normalized === 'fs';
}

function normalizeFsGoal(rawGoal) {
  if (rawGoal && typeof rawGoal === 'object' && !Array.isArray(rawGoal)) {
    return rawGoal;
  }

  if (typeof rawGoal !== 'string') return null;
  const trimmed = rawGoal.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // Keep null when goal is not valid JSON.
  }

  return null;
}

function resolveFsToolAction(call, result) {
  const callAction = String(normalizeFsGoal(call?.goal)?.action || '').trim();
  if (callAction) return callAction;
  const resultAction = String(normalizeFsGoal(result?.goal)?.action || '').trim();
  return resultAction;
}

function fsToolTitleForAction(action) {
  if (action === 'read_file') return 'File Read';
  if (action === 'search_files') return 'File Search';
  if (action === 'list_dir') return 'Directory List';
  if (action === 'write_file') return 'File Write';
  if (action === 'edit_file') return 'File Edit';
  return 'Filesystem';
}

function buildFsCommandLabel(rawGoal) {
  const goal = normalizeFsGoal(rawGoal);
  if (!goal) {
    return typeof rawGoal === 'string' ? rawGoal.trim() : '';
  }

  const action = String(goal.action || '').trim();
  const targetPath = String(goal.path || '').trim();
  const query = String(goal.query || '').trim();

  if (action === 'read_file') {
    return ['read_file', targetPath].filter(Boolean).join(' ');
  }

  if (action === 'search_files') {
    const parts = ['search_files'];
    if (targetPath) parts.push(targetPath);
    if (query) parts.push(`query="${query}"`);
    return parts.join(' ');
  }

  const parts = [];
  if (action) parts.push(action);
  if (targetPath) parts.push(targetPath);
  if (query) parts.push(`query="${query}"`);
  return parts.join(' ').trim();
}

function buildToolMessageSeed(call, result = null) {
  const agent = normalizeAgentName(call?.agent || result?.agent || '');

  if (agent === 'fs') {
    const action = resolveFsToolAction(call, result);
    return {
      title: fsToolTitleForAction(action),
      command: buildFsCommandLabel(call?.goal || result?.goal),
      toolType: 'fs',
      toolAction: action,
      meta: {
        fsAction: action || null,
      },
    };
  }

  return {
    title: 'Terminal',
    command: String(result?.command || call?.goal || '').trim(),
    toolType: 'terminal',
    toolAction: '',
    meta: {},
  };
}

function buildFsOutputLines(call, result) {
  const lines = [];
  const action = resolveFsToolAction(call, result);
  const rawText = typeof result?.text === 'string' ? result.text : '';

  if (rawText) {
    const allTextLines = rawText.split('\n');
    lines.push(...allTextLines.slice(0, 120));
    if (allTextLines.length > 120) {
      lines.push('[info] Output truncated.');
    }
  }

  if (lines.length === 0 && result?.summary) {
    lines.push(String(result.summary));
  }

  if (!result?.ok && result?.error) {
    lines.push(`[error] ${String(result.error)}`);
  }

  if (lines.length === 0) {
    if (!result) {
      lines.push('[info] Waiting for filesystem output...');
    } else if (result.ok) {
      if (action === 'search_files') {
        lines.push('[ok] File search completed.');
      } else if (action === 'read_file') {
        lines.push('[ok] File read completed.');
      } else {
        lines.push('[ok] Filesystem action completed.');
      }
    } else {
      lines.push('[error] Filesystem action failed.');
    }
  }

  return lines.slice(0, 120);
}

function buildAgentTimelineLogs(call, result) {
  const logs = [];

  const goal = String(call?.goal || '').trim();
  if (goal) {
    logs.push(`Goal: ${goal}`);
  }

  if (Array.isArray(result?.timeline) && result.timeline.length > 0) {
    for (const line of result.timeline) {
      const text = String(line || '').trim();
      if (!text) continue;
      logs.push(text);
    }
  }

  if (result?.summary) {
    logs.push(`Summary: ${String(result.summary)}`);
  }
  if (!result?.ok && result?.error) {
    logs.push(`Error: ${String(result.error)}`);
  }

  if (logs.length === 0) {
    logs.push(result?.ok ? 'Agent finished.' : 'Agent failed.');
  }

  return logs.slice(0, 80);
}

function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error('Aborted'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}
