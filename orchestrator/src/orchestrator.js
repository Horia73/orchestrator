import fsp from 'fs/promises';
import { BrowserAgentClient } from './agents/browser-agent.js';
import { CodingAgentClient } from './agents/coding-agent.js';
import { ImageAgentClient } from './agents/image-agent.js';
import { TtsAgentClient } from './agents/tts-agent.js';
import { TerminalToolClient } from './tools/terminal-tool.js';
import { PtyTerminalToolClient } from './tools/pty-terminal-tool.js';
import { FsToolClient } from './tools/fs-tool.js';
import { ConversationStore } from './conversation-store.js';
import { LlmClient } from './llm.js';
import { ReadUrlToolClient } from './tools/read-url-tool.js';
import { CodeExecuteToolClient } from './tools/code-execute-tool.js';
import { isGeminiSupportedMimeType, normalizeGeminiMimeType } from './gemini-file-support.js';

const MEDIA_URL_PREFIXES = ['/api/media/files/', '/media/files/'];
const GEMINI_INLINE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const GEMINI_FILE_API_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function randomConversationId() {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStorageKey(value) {
  const key = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) return '';
  return key;
}

function storageKeyFromAttachmentUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw, 'http://localhost');
    const pathname = parsed.pathname || '';
    for (const prefix of MEDIA_URL_PREFIXES) {
      if (pathname.startsWith(prefix)) {
        return normalizeStorageKey(decodeURIComponent(pathname.slice(prefix.length)));
      }
    }
  } catch {
    return '';
  }

  return '';
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map((item) => ({
      name: String(item?.name || '').trim(),
      type: String(item?.type || '').trim(),
      size: Number(item?.size) || 0,
      url: String(item?.url || '').trim(),
      storageKey: normalizeStorageKey(item?.storageKey),
    }))
    .filter((item) => item.name || item.url || item.storageKey);
}

function buildUserEntryText(message, attachments, skippedAttachmentNotes = []) {
  const base = String(message || '').trim();
  const skipped = Array.isArray(skippedAttachmentNotes)
    ? skippedAttachmentNotes.map((note) => String(note || '').trim()).filter(Boolean)
    : [];
  if (!attachments.length) {
    if (!skipped.length) return base;
    return [base, 'Attachment notes:', ...skipped].filter(Boolean).join('\n\n');
  }

  const list = attachments
    .map((item, index) => {
      const name = item.name || `attachment_${index + 1}`;
      const type = item.type || 'unknown';
      const size = item.size > 0 ? `${item.size} bytes` : 'size n/a';
      const url = item.url ? ` | ${item.url}` : '';
      return `- ${name} (${type}, ${size})${url}`;
    })
    .join('\n');

  if (!base) {
    const sections = [`User shared attachments:\n${list}`];
    if (skipped.length) {
      sections.push(['Attachment notes:', ...skipped].join('\n'));
    }
    return sections.join('\n\n');
  }

  const sections = [`${base}\n\nAttachments:\n${list}`];
  if (skipped.length) {
    sections.push(['Attachment notes:', ...skipped].join('\n'));
  }
  return sections.join('\n\n');
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const rounded = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

export class Orchestrator {
  constructor(config, { onUsage, onLog, mediaStore } = {}) {
    this.config = config;
    this.onLog = typeof onLog === 'function' ? onLog : null;
    this.mediaStore = mediaStore || null;
    this.store = new ConversationStore(config.conversations.maxMessagesPerConversation);
    this.llm = new LlmClient(config.llm, { onUsage, onLog });
    this.browserAgent = new BrowserAgentClient(config.browserAgent, { onUsage, onLog });
    this.imageAgent = new ImageAgentClient(config.imageAgent, { onLog, mediaStore: this.mediaStore });
    this.ttsAgent = new TtsAgentClient(config.ttsAgent, {
      onUsage,
      onLog,
      saveAudio: this.mediaStore
        ? (payload) => this.mediaStore.saveBase64(payload)
        : null,
    });
    this.terminalTool = new TerminalToolClient(config.terminalTool, { onLog });
    this.fsTool = new FsToolClient(config.fsTool, { onLog });
    this.readUrlTool = new ReadUrlToolClient(config.readUrlTool, { onLog });
    this.codeExecuteTool = new CodeExecuteToolClient(config.codeExecuteTool, { onLog });
    this.ptyTerminalTool = new PtyTerminalToolClient(config.ptyTerminalTool, { onLog });
    this.codingAgent = new CodingAgentClient(config.codingAgent, {
      onLog,
      llm: this.llm,
      ptyTerminalTool: this.ptyTerminalTool,
      routeCall: (callInfo, sig, convId) => this.executeSingleAgentCall(callInfo, sig, convId)
    });
  }

  async init() {
  }

  getRuntimeSettings() {
    return {
      orchestrator: this.llm.getConfig(),
      agents: {
        browser: this.browserAgent.getConfig(),
        image: this.imageAgent.getConfig(),
        tts: this.ttsAgent.getConfig(),
      },
      tools: {
        terminal: this.terminalTool.getConfig(),
        fs: this.fsTool.getConfig(),
      },
    };
  }

  updateRuntimeSettings(nextSettings = {}) {
    const orchestratorSettings = nextSettings.orchestrator || {};
    const browserSettings = nextSettings.agents?.browser || {};
    const imageSettings = nextSettings.agents?.image || {};
    const ttsSettings = nextSettings.agents?.tts || {};
    const terminalSettings = nextSettings.tools?.terminal || nextSettings.agents?.terminal || {};
    const fsSettings = nextSettings.tools?.fs || nextSettings.agents?.fs || {};

    this.llm.updateConfig({
      model: orchestratorSettings.model,
      thinkingBudget: orchestratorSettings.thinkingBudget,
      temperature: orchestratorSettings.temperature,
      webResearch: orchestratorSettings.webResearch,
    });

    this.browserAgent.updateConfig({
      model: browserSettings.model,
      thinkingBudget: browserSettings.thinkingBudget,
    });

    this.imageAgent.updateConfig({
      model: imageSettings.model,
    });

    this.ttsAgent.updateConfig({
      model: ttsSettings.model,
      voice: ttsSettings.voice,
    });

    this.terminalTool.updateConfig({
      enabled: terminalSettings.enabled,
      cwd: terminalSettings.cwd,
      shell: terminalSettings.shell,
      timeoutMs: terminalSettings.timeoutMs,
      maxOutputChars: terminalSettings.maxOutputChars,
    });

    this.fsTool.updateConfig({
      enabled: fsSettings.enabled !== false
    });
  }

  async listAvailableModels({ search = '', action = 'generateContent' } = {}) {
    return this.llm.listAvailableModels({ search, action });
  }

  normalizeConversationId(value) {
    const raw = String(value || '').trim();
    return raw || randomConversationId();
  }

  resolveAttachmentStorageKey(attachment) {
    const direct = normalizeStorageKey(attachment?.storageKey);
    if (direct) return direct;
    return storageKeyFromAttachmentUrl(attachment?.url);
  }

  async buildGeminiAttachmentParts(attachments, signal) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return { parts: [], skippedNotes: [], cleanupFileNames: [] };
    }

    const maxInlineBytes = Math.max(
      1024,
      Math.min(Number(this.config?.media?.maxFileBytes) || GEMINI_INLINE_ATTACHMENT_MAX_BYTES, GEMINI_INLINE_ATTACHMENT_MAX_BYTES)
    );
    const parts = [];
    const skippedNotes = [];
    const cleanupFileNames = new Set();

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const name = String(attachment?.name || `attachment_${index + 1}`).trim();
      const mimeType = normalizeGeminiMimeType(attachment?.type, name);
      const supported = isGeminiSupportedMimeType(mimeType || attachment?.type, name);

      if (!supported || !mimeType) {
        skippedNotes.push(`- ${name}: unsupported type "${attachment?.type || 'unknown'}".`);
        continue;
      }

      if (!this.mediaStore) {
        skippedNotes.push(`- ${name}: media storage not available in orchestrator.`);
        continue;
      }

      const storageKey = this.resolveAttachmentStorageKey(attachment);
      if (!storageKey) {
        skippedNotes.push(`- ${name}: missing storage key (upload first).`);
        continue;
      }

      let fileInfo;
      try {
        fileInfo = this.mediaStore.resolveFile(storageKey);
      } catch {
        skippedNotes.push(`- ${name}: invalid media reference.`);
        continue;
      }

      let stats;
      try {
        stats = await fsp.stat(fileInfo.absolutePath);
      } catch {
        skippedNotes.push(`- ${name}: file is no longer available on disk.`);
        continue;
      }

      const fileSize = Number(stats?.size) || 0;
      if (fileSize <= 0) {
        skippedNotes.push(`- ${name}: file is empty.`);
        continue;
      }

      if (fileSize > GEMINI_FILE_API_MAX_BYTES) {
        skippedNotes.push(`- ${name}: too large (${formatBytes(fileSize)}). Gemini Files API max is ${formatBytes(GEMINI_FILE_API_MAX_BYTES)} per file.`);
        continue;
      }

      if (fileSize > maxInlineBytes) {
        try {
          const uploaded = await this.llm.uploadAttachmentToGeminiFile({
            cacheKey: storageKey,
            filePath: fileInfo.absolutePath,
            mimeType,
            displayName: name,
            signal,
          });

          parts.push({
            name,
            mimeType: uploaded.mimeType || mimeType,
            size: fileSize,
            fileData: {
              mimeType: uploaded.mimeType || mimeType,
              fileUri: uploaded.fileUri,
            },
          });
          if (uploaded.fileName) {
            cleanupFileNames.add(String(uploaded.fileName));
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          skippedNotes.push(`- ${name}: failed to upload to Gemini Files API (${reason}).`);
        }
        continue;
      }

      let buffer;
      try {
        buffer = await fsp.readFile(fileInfo.absolutePath);
      } catch {
        skippedNotes.push(`- ${name}: file could not be read.`);
        continue;
      }

      if (!buffer || buffer.length === 0) {
        skippedNotes.push(`- ${name}: file is empty.`);
        continue;
      }

      parts.push({
        name,
        mimeType,
        size: fileSize,
        inlineData: {
          mimeType,
          data: buffer.toString('base64'),
        },
      });
    }

    return { parts, skippedNotes, cleanupFileNames: [...cleanupFileNames] };
  }

  async handleMessage({ conversationId, message, attachments, signal, onChunk, onAgentStart, onAgentResult }) {
    const convId = this.normalizeConversationId(conversationId);
    const userMessage = String(message || '').trim();
    const normalizedAttachments = normalizeAttachments(attachments);
    if (!userMessage && normalizedAttachments.length === 0) {
      throw new Error('Message must be a non-empty string or include attachments.');
    }

    const preparedAttachments = await this.buildGeminiAttachmentParts(normalizedAttachments, signal);
    const userEntryText = buildUserEntryText(userMessage, normalizedAttachments, preparedAttachments.skippedNotes);
    this.store.append(convId, 'user', userEntryText);
    const history = this.store.getHistory(convId);

    let plan = { mode: 'chat', execution: 'sequential', rationale: '', agentCalls: [] };
    let agentResults = [];
    let responseText = '';
    let continuationNeeded = false;
    let continuationReason = '';
    let continuationPrompt = '';
    let iterationsUsed = 0;
    let maxIterations = 0;

    try {
      const result = await this.llm.executeAgenticLoop({
        history,
        message: userEntryText,
        attachments: preparedAttachments.parts,
        defaultTimeouts: {
          browser: this.config.browserAgent.timeoutMs,
          image: this.config.imageAgent.timeoutMs,
          tts: this.config.ttsAgent.timeoutMs,
          terminal: this.config.terminalTool.timeoutMs,
        },
        onChunk,
        onAgentStart,
        onAgentResult,
        executeAgentCall: (call) => this.executeSingleAgentCall(call, signal, convId),
        signal,
      });

      responseText = result.responseText;
      plan = result.plan;
      agentResults = result.agentResults;
      continuationNeeded = Boolean(result.continuationNeeded);
      continuationReason = String(result.continuationReason || '').trim();
      continuationPrompt = String(result.continuationPrompt || '').trim();
      iterationsUsed = Number(result.iterationsUsed) || 0;
      maxIterations = Number(result.maxIterations) || 0;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.onLog?.({
        level: 'error',
        component: 'orchestrator',
        event: 'handle_message_failed',
        message: `Failed to generate final response: ${message}`,
        data: {
          conversationId: convId,
          planMode: plan.mode,
          execution: plan.execution,
        },
      });
      responseText = this.buildFallbackResponse(plan, agentResults);
    } finally {
      if (Array.isArray(preparedAttachments.cleanupFileNames) && preparedAttachments.cleanupFileNames.length > 0) {
        try {
          await this.llm.cleanupGeminiFiles(preparedAttachments.cleanupFileNames);
        } catch {
          // Best-effort cleanup; should never fail the chat response path.
        }
      }
    }
    responseText = this.appendImageMarkdown(responseText, agentResults);
    responseText = this.appendTtsAudioLinks(responseText, agentResults);
    const responseAttachments = this.collectResponseAttachments(agentResults);

    this.store.append(convId, 'assistant', responseText);

    return {
      conversationId: convId,
      content: responseText,
      attachments: responseAttachments,
      meta: {
        route: plan.mode,
        execution: plan.execution,
        rationale: plan.rationale,
        agentCalls: plan.agentCalls,
        agentResults,
        continuationNeeded,
        continuationReason,
        continuationPrompt,
        iterationsUsed,
        maxIterations,
      },
    };
  }

  async getContextUsage({ conversationId, message = '', attachments = [] } = {}) {
    const convId = String(conversationId || '').trim();
    const normalizedAttachments = normalizeAttachments(attachments);
    const draft = buildUserEntryText(String(message || '').trim(), normalizedAttachments);
    const history = convId ? this.store.getHistory(convId) : [];

    const estimate = await this.llm.estimatePromptWindow({
      history,
      message: draft,
    });

    return {
      ...estimate,
      conversationId: convId || null,
      historyMessages: history.length,
      draftMessageLength: draft.length,
    };
  }

  async executeSingleAgentCall(call, signal, conversationId) {
    const agent = String(call.agent || '').toLowerCase();

    if (agent === 'coding') {
      if (!this.codingAgent || typeof this.codingAgent.runTask !== 'function') {
        return {
          ok: false,
          agent,
          goal: call.goal,
          error: 'Coding agent is not available.',
        };
      }
      return this.codingAgent.runTask({
        goal: call.goal,
        signal,
        conversationId,
      });
    }

    if (agent === 'browser') {
      const result = await this.browserAgent.runTask({
        goal: call.goal,
        timeoutMs: call.timeoutMs,
        signal,
      });

      if (Array.isArray(result?.timeline) && result.timeline.length > 0) {
        for (const line of result.timeline) {
          this.onLog?.({
            level: 'info',
            component: 'browser-agent',
            event: 'agent_timeline',
            message: String(line),
            data: {
              goal: call.goal,
            },
          });
        }
      }

      return result;
    }

    if (agent === 'image') {
      const result = await this.imageAgent.runTask({
        goal: call.goal,
        timeoutMs: call.timeoutMs,
        signal,
        conversationId,
      });

      if (Array.isArray(result?.timeline) && result.timeline.length > 0) {
        for (const line of result.timeline) {
          this.onLog?.({
            level: 'info',
            component: 'image-agent',
            event: 'agent_timeline',
            message: String(line),
            data: {
              goal: call.goal,
            },
          });
        }
      }

      return result;
    }

    if (agent === 'tts') {
      const result = await this.ttsAgent.runTask({
        goal: call.goal,
        timeoutMs: call.timeoutMs,
        signal,
        conversationId,
      });

      if (Array.isArray(result?.timeline) && result.timeline.length > 0) {
        for (const line of result.timeline) {
          this.onLog?.({
            level: 'info',
            component: 'tts-agent',
            event: 'agent_timeline',
            message: String(line),
            data: {
              goal: call.goal,
            },
          });
        }
      }

      return result;
    }

    if (agent === 'terminal') {
      const result = await this.terminalTool.runTask({
        goal: call.goal,
        timeoutMs: call.timeoutMs,
        signal,
      });

      if (Array.isArray(result?.timeline) && result.timeline.length > 0) {
        for (const line of result.timeline) {
          this.onLog?.({
            level: 'info',
            component: 'terminal-tool',
            event: 'agent_timeline',
            message: String(line),
            data: {
              goal: call.goal,
            },
          });
        }
      }

      return result;
    }

    if (agent === 'fs') {
      const result = await this.fsTool.runTask({
        goal: call.goal,
        signal,
      });

      return result;
    }

    if (agent === 'read_url' || agent === 'call_read_url') {
      return this.readUrlTool.runTask({
        goal: call.goal,
        signal,
      });
    }

    if (agent === 'code_execute' || agent === 'call_code_execute') {
      return this.codeExecuteTool.runTask({
        goal: call.goal,
      });
    }

    if (agent === 'search_web' || agent === 'call_search_web') {
      return {
        ok: false,
        agent,
        goal: call.goal,
        error: 'Search is built-in. Do not call this tool directly. Just ask your question naturally and the model will search.',
      };
    }

    return {
      ok: false,
      agent,
      goal: call.goal,
      error: `Agent "${agent}" is not registered yet.`,
    };
  }

  collectResponseAttachments(agentResults) {
    if (!Array.isArray(agentResults) || agentResults.length === 0) return [];
    const attachments = [];
    const seen = new Set();

    for (const result of agentResults) {
      if (!result || !result.ok) continue;

      if (result.agent === 'image' && Array.isArray(result.images)) {
        for (const image of result.images) {
          const url = String(image?.url || '').trim();
          if (!url || seen.has(url)) continue;
          seen.add(url);
          attachments.push({
            name: String(image?.name || 'generated-image.png'),
            type: String(image?.type || 'image/png'),
            size: Number(image?.size) || 0,
            url,
            stored: true,
          });
        }
      }

      if (result.agent === 'tts') {
        const audio = result?.audio || {};
        const url = String(audio.url || '').trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        attachments.push({
          name: String(audio.name || 'generated-audio.wav'),
          type: String(audio.type || 'audio/wav'),
          size: Number(audio.size) || 0,
          url,
          stored: true,
        });
      }
    }

    return attachments;
  }

  appendImageMarkdown(responseText, agentResults) {
    const base = String(responseText || '').trim();
    if (!Array.isArray(agentResults) || agentResults.length === 0) return base;

    const lines = [];
    for (const result of agentResults) {
      if (!result || result.agent !== 'image' || !result.ok) continue;
      const images = Array.isArray(result.images) ? result.images : [];
      for (let i = 0; i < images.length; i += 1) {
        const imageUrl = String(images[i]?.url || '').trim();
        if (!imageUrl) continue;
        if (base.includes(imageUrl)) continue;
        lines.push(`![Generated image ${i + 1}](${imageUrl})`);
      }
    }

    if (!lines.length) return base;
    return [base, lines.join('\n\n')].filter(Boolean).join('\n\n').trim();
  }

  appendTtsAudioLinks(responseText, agentResults) {
    const base = String(responseText || '').trim();
    if (!Array.isArray(agentResults) || agentResults.length === 0) return base;

    const lines = [];
    for (let i = 0; i < agentResults.length; i += 1) {
      const result = agentResults[i];
      if (!result || result.agent !== 'tts' || !result.ok) continue;
      const audioUrl = String(result?.audio?.url || '').trim();
      if (!audioUrl || base.includes(audioUrl)) continue;
      const voice = String(result?.voice || '').trim();
      lines.push(`- [Audio ${lines.length + 1}${voice ? ` (${voice})` : ''}](${audioUrl})`);
    }

    if (!lines.length) return base;
    return [
      base,
      '',
      'Audio output:',
      ...lines,
    ].join('\n').trim();
  }

  buildFallbackResponse(plan, agentResults) {
    if (plan.mode !== 'agents' || agentResults.length === 0) {
      return 'Am intampinat o problema la generarea raspunsului final, dar pot continua daca reformulezi mesajul.';
    }

    const summaries = agentResults.map((result, index) => {
      const status = result.ok ? 'ok' : 'error';
      const summary = result.summary || result.error || 'fara detalii';
      return `${index + 1}. [${status}] ${result.agent}: ${summary}`;
    });

    return [
      'Am executat orchestrarea, dar modelul nu a returnat raspuns final complet.',
      'Rezultate brute agenti:',
      ...summaries,
    ].join('\n');
  }


}
