import { GoogleGenAI, Type } from '@google/genai';

const GEMINI_FILE_STATE_ACTIVE = 'ACTIVE';
const GEMINI_FILE_STATE_FAILED = 'FAILED';
const GEMINI_FILE_STATE_PROCESSING = 'PROCESSING';
const GEMINI_FILE_POLL_INTERVAL_MS = 2000;
const GEMINI_FILE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

function sanitizeThinkingLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return '';
}

function buildThinkingConfig(explicitLevel) {
  const thinkingLevel = sanitizeThinkingLevel(explicitLevel);
  return {
    thinkingLevel: thinkingLevel || 'minimal',
  };
}

const ORCHESTRATOR_SYSTEM_INSTRUCTION = `
<identity>
You are an AI orchestrator that routes tasks to specialized agents and tools,
or responds conversationally when no delegation is needed.
Be practical, concise, and genuinely helpful.
</identity>

<available_agents>
- browser: Web navigation, UI automation, form filling, booking flows, web scraping.
- coding: Expert AI software engineer macro-agent for complex coding tasks, debugging, architecture, refactoring over multiple steps.
- image: Generate, create, edit, or render images from visual descriptions.
- tts: Text-to-speech, narration, voiceover, audio generation.
</available_agents>

<available_tools>
- terminal: Local shell commands (build, test, git, scripts). Goal must be a concrete command string, NOT prose.
- fs: Local filesystem operations. Goal must be a structured JSON object.
  Supported actions: list_dir, read_file, write_file, append_file, edit_file, search_files, find_files, file_outline.
- search_web: Performs a Google Search to answer factual questions or find current information.
- read_url: Fetches a webpage by URL and returns its textual content parsed as Markdown.
- code_execute: Executes a short Node.js snippet locally. Useful for calculations, data parsing, or regex checks.
</available_tools>

<workspace_bootstrap>
You are in the project workspace.
Memory is in 'memory/' (daily notes and permanent.md).
Knowledge is in 'knowledge/' (SOUL.md, USER.md, TOOLS.md, AGENTS.md, etc).
IMPORTANT: Use the 'fs' tool ('read_file', 'search_files') to read your memory and knowledge when you need context, rather than guessing.
</workspace_bootstrap>

<routing_rules>
1. Use fs tool for ALL file operations. NEVER use terminal for ls, cat, sed, awk, find, or file reading/writing.
2. Use terminal tool ONLY for: running tests, building, git operations, executing scripts, process management.
3. If the user asks you to write code, modify files, implement features, or fix bugs, YOU MUST route the task to the 'coding' agent using call_coding. Do not write code in the chat if a file needs to be modified.
</routing_rules>

<tool_format_rules>
- fs: Goal is always a JSON object with "action" key. Examples:
  List directory:   {"action":"list_dir","path":"/path/to/dir"}
  Read file:        {"action":"read_file","path":"/path/file.js","startLine":10,"endLine":50}
  Read full file:   {"action":"read_file","path":"/path/file.js"}
  Write file:       {"action":"write_file","path":"/path/file.js","content":"..."}
  Append to file:   {"action":"append_file","path":"/path/file.js","content":"\n- new item"}
  Edit file:        {"action":"edit_file","path":"/path/file.js","targetText":"old code","replacementText":"new code"}
  Search content:   {"action":"search_files","path":"/path/to/dir","query":"searchTerm"}
  Find by name:     {"action":"find_files","path":"/path/to/dir","pattern":"*.js"}
  File structure:   {"action":"file_outline","path":"/path/file.js"}
- terminal: Goal is a concrete shell command string (e.g. "git status", "npm run build").
- image: Goal includes subject, scene, style, framing, lighting, and constraints.
- tts: Goal is JSON: {"text":"...","voice":"Kore","language":"ro-RO","style":"...","instructions":"..."}.
- search_web: Goal is the search query string.
- read_url: Goal is the full HTTP/HTTPS URL string.
- code_execute: Goal is the raw javascript snippet to run in Node.
</tool_format_rules>

<response_style>
- Be direct and helpful. Skip filler lines.
- Have opinions when appropriate.
- When errors occur, explain clearly and suggest fixes.
</response_style>
`.trim();

export const AGENT_TOOLS = [
  {
    name: 'call_coding',
    description: 'Expert AI software engineer macro-agent. Use for complex multi-step coding, debugging, or implementing features. It works autonomously in the codebase using its own loop.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Task description for the coding agent.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'call_browser',
    description: 'Web navigation and UI automation (open sites, click, fill forms, scrape).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Task description for the browser agent.' },
        timeoutSec: { type: Type.INTEGER, description: 'Timeout in seconds (default: 90).' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'call_terminal',
    description: 'Run shell commands (build, test, git, scripts). NOT for file reading/writing — use fs for that.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Concrete shell command (e.g. "npm run build", "git status").' },
        timeoutSec: { type: Type.INTEGER, description: 'Timeout in seconds (default: 20).' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'call_image',
    description: 'Generate, create, or edit images. Goal should describe visual intent.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Visual description: subject, scene, style, framing, lighting, aspect ratio.' },
        timeoutSec: { type: Type.INTEGER, description: 'Timeout in seconds (default: 120).' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'call_fs',
    description: 'Filesystem operations: read, write, edit, search, list, outline files. Goal must be a structured JSON object with an "action" key.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: {
          type: Type.OBJECT,
          description: 'FS action object. Required key: "action". Actions: list_dir, read_file, write_file, append_file, edit_file, search_files, find_files, file_outline. Keys per action — list_dir: {path}. read_file: {path, startLine?, endLine?}. write_file: {path, content}. append_file: {path, content}. edit_file: {path, targetText, replacementText}. search_files: {path, query}. find_files: {path, pattern}. file_outline: {path}.',
          properties: {
            action: { type: Type.STRING, description: 'Action to perform: list_dir, read_file, write_file, append_file, edit_file, search_files, find_files, file_outline.' },
            path: { type: Type.STRING, description: 'Target file or directory path.' },
            content: { type: Type.STRING, description: 'Content for write_file or append_file.' },
            targetText: { type: Type.STRING, description: 'Exact text to find for edit_file. Must match exactly one location.' },
            replacementText: { type: Type.STRING, description: 'Replacement text for edit_file.' },
            query: { type: Type.STRING, description: 'Search query for search_files.' },
            pattern: { type: Type.STRING, description: 'File name pattern for find_files (e.g. "*.js").' },
            startLine: { type: Type.INTEGER, description: 'Start line number for read_file (1-indexed, optional).' },
            endLine: { type: Type.INTEGER, description: 'End line number for read_file (1-indexed, optional).' },
          },
          required: ['action'],
        },
        timeoutSec: { type: Type.INTEGER, description: 'Timeout in seconds.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'call_tts',
    description: 'Text-to-speech: narration, voiceover, audio generation.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'JSON with keys: text, voice, language, style, instructions.' },
        timeoutSec: { type: Type.INTEGER, description: 'Timeout in seconds (default: 120).' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'call_search_web',
    description: 'Perform a Google Search. Goal must be the search query string.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Search query.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'call_read_url',
    description: 'Fetch a webpage by URL and return its text content as Markdown. Useful for scraping docs or articles.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Full URL (e.g., https://example.com).' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'call_code_execute',
    description: 'Execute a short node.js snippet locally. Returns stdout and stderr.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Node.js code snippet to execute.' },
      },
      required: ['goal'],
    },
  },
];

export class LlmClient {
  constructor(config, { onUsage, onLog } = {}) {
    if (!config.apiKey) {
      throw new Error('Missing GEMINI_API_KEY for orchestrator.');
    }

    this.config = config;
    this.ai = new GoogleGenAI({ apiKey: config.apiKey });
    this.onUsage = typeof onUsage === 'function' ? onUsage : null;
    this.onLog = typeof onLog === 'function' ? onLog : null;
    this.modelCache = {
      loadedAt: 0,
      models: [],
    };
  }

  updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object') return;

    if (typeof patch.model === 'string' && patch.model.trim()) {
      this.config.model = patch.model.trim();
    }

    if (typeof patch.thinkingLevel === 'string' && patch.thinkingLevel.trim()) {
      this.config.thinkingLevel = patch.thinkingLevel.trim().toLowerCase();
    }

    if (typeof patch.webResearch === 'boolean') {
      this.config.webResearch = patch.webResearch;
    }
  }

  getConfig() {
    return {
      model: this.config.model,
      thinkingLevel: sanitizeThinkingLevel(this.config.thinkingLevel) || 'minimal',
      webResearch: this.config.webResearch !== false,
    };
  }

  _parseFileState(file) {
    const raw = String(file?.state || '').trim().toUpperCase();
    if (!raw) return GEMINI_FILE_STATE_ACTIVE;
    if (raw.endsWith(`_${GEMINI_FILE_STATE_ACTIVE}`)) return GEMINI_FILE_STATE_ACTIVE;
    if (raw.endsWith(`_${GEMINI_FILE_STATE_FAILED}`)) return GEMINI_FILE_STATE_FAILED;
    if (raw.endsWith(`_${GEMINI_FILE_STATE_PROCESSING}`)) return GEMINI_FILE_STATE_PROCESSING;
    return raw;
  }

  async _sleep(ms, signal) {
    const delay = Math.max(0, Number(ms) || 0);
    if (!signal) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return;
    }

    if (signal.aborted) throw new Error('Aborted');

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async _waitForUploadedFileReady(fileName, signal) {
    const startedAt = Date.now();
    while (true) {
      if (signal?.aborted) throw new Error('Aborted');
      const current = await this.ai.files.get({ name: fileName });
      const state = this._parseFileState(current);

      if (state === GEMINI_FILE_STATE_ACTIVE) {
        return current;
      }

      if (state === GEMINI_FILE_STATE_FAILED) {
        const details = String(current?.error?.message || '').trim();
        throw new Error(details || `Gemini file processing failed for ${fileName}.`);
      }

      if ((Date.now() - startedAt) > GEMINI_FILE_WAIT_TIMEOUT_MS) {
        throw new Error(`Gemini file processing timed out for ${fileName} after ${Math.round(GEMINI_FILE_WAIT_TIMEOUT_MS / 1000)}s.`);
      }

      await this._sleep(GEMINI_FILE_POLL_INTERVAL_MS, signal);
    }
  }

  async uploadAttachmentToGeminiFile({ cacheKey, filePath, mimeType, displayName, signal }) {
    const key = String(cacheKey || '').trim();
    const type = String(mimeType || '').trim();
    const path = String(filePath || '').trim();
    const label = String(displayName || '').trim();

    if (!key || !type || !path) {
      throw new Error('Invalid Gemini file upload payload.');
    }

    this.onLog?.({
      level: 'info',
      component: 'orchestrator',
      event: 'gemini_file_upload_started',
      message: `Uploading attachment to Gemini Files API: ${label || key}`,
      data: {
        cacheKey: key,
        filePath: path,
        mimeType: type,
      },
    });

    const uploaded = await this.ai.files.upload({
      file: path,
      config: {
        mimeType: type,
        ...(label ? { displayName: label } : {}),
      },
    });

    const uploadName = String(uploaded?.name || '').trim();
    if (!uploadName) {
      throw new Error('Gemini files.upload returned no file name.');
    }

    let ready;
    try {
      ready = await this._waitForUploadedFileReady(uploadName, signal);
    } catch (error) {
      await this.ai.files.delete({ name: uploadName }).catch(() => {});
      throw error;
    }
    const fileUri = String(ready?.uri || uploaded?.uri || '').trim();
    if (!fileUri) {
      throw new Error(`Gemini uploaded file ${uploadName} has no URI.`);
    }

    this.onLog?.({
      level: 'info',
      component: 'orchestrator',
      event: 'gemini_file_upload_ready',
      message: `Gemini file ready: ${uploadName}`,
      data: {
        cacheKey: key,
        fileName: uploadName,
        mimeType: String(ready?.mimeType || uploaded?.mimeType || type).trim() || type,
      },
    });

    return {
      fileUri,
      mimeType: String(ready?.mimeType || uploaded?.mimeType || type).trim() || type,
      fileName: uploadName,
    };
  }

  async cleanupGeminiFiles(fileNames = []) {
    if (!Array.isArray(fileNames) || fileNames.length === 0) return;

    const uniqueNames = [...new Set(
      fileNames
        .map((name) => String(name || '').trim())
        .filter((name) => name.startsWith('files/'))
    )];
    if (!uniqueNames.length) return;

    const results = await Promise.allSettled(
      uniqueNames.map((name) => this.ai.files.delete({ name }))
    );

    results.forEach((result, index) => {
      const fileName = uniqueNames[index];
      if (result.status === 'fulfilled') {
        this.onLog?.({
          level: 'info',
          component: 'orchestrator',
          event: 'gemini_file_deleted',
          message: `Deleted Gemini file: ${fileName}`,
          data: { fileName },
        });
        return;
      }

      const reason = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason || 'Unknown error');
      this.onLog?.({
        level: 'warn',
        component: 'orchestrator',
        event: 'gemini_file_delete_failed',
        message: `Failed deleting Gemini file: ${fileName}`,
        data: {
          fileName,
          reason,
        },
      });
    });
  }

  _isThinkingCompatError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /thinking/i.test(message) && /(not supported|invalid)/i.test(message);
  }

  async _generateWithThinkingFallback(runFn, config) {
    try {
      return await runFn(config);
    } catch (error) {
      if (this._isThinkingCompatError(error) && config?.thinkingConfig) {
        const fallbackConfig = { ...config };
        delete fallbackConfig.thinkingConfig;
        this.onLog?.({
          level: 'warn',
          component: 'orchestrator',
          event: 'thinking_config_fallback',
          message: `Retrying ${this.config.model} without thinkingConfig due to incompatibility.`,
          data: {
            model: this.config.model,
            thinkingLevel: sanitizeThinkingLevel(this.config.thinkingLevel) || 'minimal',
          },
        });
        return runFn(fallbackConfig);
      }
      throw error;
    }
  }

  _extractUsage(rawUsage) {
    if (!rawUsage || typeof rawUsage !== 'object') return null;
    const promptTokens = Number(rawUsage.promptTokenCount) || 0;
    const outputTokens = Number(rawUsage.candidatesTokenCount) || 0;
    const thoughtsTokens = Number(rawUsage.thoughtsTokenCount) || 0;
    const totalTokens = Number(rawUsage.totalTokenCount) || (promptTokens + outputTokens + thoughtsTokens);

    return {
      promptTokens,
      outputTokens,
      thoughtsTokens,
      totalTokens,
    };
  }

  _emitUsage(phase, usage) {
    if (!usage || !this.onUsage) return;
    this.onUsage({
      component: 'orchestrator',
      phase,
      model: this.config.model,
      promptTokens: usage.promptTokens,
      outputTokens: usage.outputTokens,
      thoughtsTokens: usage.thoughtsTokens,
      totalTokens: usage.totalTokens,
      timestamp: new Date().toISOString(),
    });
  }

  _commonConfig(overrides = {}, includeTools = true, options = {}) {
    const overrideTools = Array.isArray(overrides?.tools) ? overrides.tools : [];
    const allowWebResearch = this.config.webResearch !== false;
    const defaultTools = includeTools && allowWebResearch ? [{ googleSearch: {} }] : [];
    const tools = [...overrideTools, ...defaultTools];
    const thinkingConfig = buildThinkingConfig(
      sanitizeThinkingLevel(options?.thinkingLevel) || this.config.thinkingLevel
    );

    const mergedOverrides = { ...overrides };
    delete mergedOverrides.tools;

    return {
      ...(thinkingConfig ? { thinkingConfig } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...mergedOverrides,
    };
  }

  async listAvailableModels({ search = '', action = 'generateContent' } = {}) {
    const now = Date.now();
    const cacheMaxAgeMs = 5 * 60 * 1000;
    if ((now - this.modelCache.loadedAt) > cacheMaxAgeMs || this.modelCache.models.length === 0) {
      const pager = await this.ai.models.list({ config: { pageSize: 200 } });
      const models = [];

      for await (const model of pager) {
        const supportedActions = Array.isArray(model.supportedActions) ? model.supportedActions : [];
        const name = String(model.name || '').trim();
        if (!name) continue;

        const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
        models.push({
          id,
          name,
          displayName: model.displayName || id,
          description: model.description || '',
          inputTokenLimit: Number(model.inputTokenLimit) || null,
          outputTokenLimit: Number(model.outputTokenLimit) || null,
          thinking: Boolean(model.thinking),
          supportedActions,
        });
      }

      models.sort((a, b) => a.displayName.localeCompare(b.displayName));
      this.modelCache = {
        loadedAt: now,
        models,
      };
    }

    let list = this.modelCache.models;
    const normalizedAction = String(action || '').trim();
    if (normalizedAction) {
      list = list.filter((model) => {
        const actions = Array.isArray(model.supportedActions) ? model.supportedActions : [];
        return actions.includes(normalizedAction);
      });
    }

    const query = String(search || '').trim().toLowerCase();
    if (!query) return list;

    return list.filter((model) => {
      return model.id.toLowerCase().includes(query)
        || model.displayName.toLowerCase().includes(query)
        || model.description.toLowerCase().includes(query);
    });
  }

  async estimatePromptWindow({ history, message }) {
    const contents = [];
    if (Array.isArray(history) && history.length > 0) {
      history.forEach((entry) => {
        const role = entry.role === 'assistant' ? 'model' : 'user';
        const text = String(entry.content || '').trim();
        contents.push({ role, parts: [{ text }] });
      });
    }

    contents.push({
      role: 'user',
      parts: [{ text: `Latest user message: ${String(message || '').trim()} ` }],
    });

    let tokenCount = null;
    try {
      const counted = await this.ai.models.countTokens({
        model: this.config.model,
        contents,
        config: {
          systemInstruction: ORCHESTRATOR_SYSTEM_INSTRUCTION,
          tools: [{ functionDeclarations: AGENT_TOOLS }],
        },
      });

      const total = Number(counted?.totalTokens);
      if (Number.isFinite(total) && total >= 0) {
        tokenCount = total;
      }
    } catch {
      tokenCount = null;
    }

    let inputTokenLimit = null;
    try {
      const models = await this.listAvailableModels({ search: '', action: 'generateContent' });
      const currentModel = String(this.config.model || '').trim().replace(/^models\//, '');
      const selected = models.find((model) => {
        const id = String(model?.id || '').replace(/^models\//, '');
        const name = String(model?.name || '').replace(/^models\//, '');
        return id === currentModel || name === currentModel;
      });
      const rawLimit = Number(selected?.inputTokenLimit);
      if (Number.isFinite(rawLimit) && rawLimit > 0) {
        inputTokenLimit = rawLimit;
      }
    } catch {
      inputTokenLimit = null;
    }

    const estimatedFromChars = Math.max(
      0,
      Math.round(
        contents.reduce((acc, item) => {
          const partText = Array.isArray(item?.parts)
            ? item.parts.map((part) => String(part?.text || '')).join('\n')
            : '';
          return acc + partText.length;
        }, 0) / 4
      )
    );
    const usedTokens = tokenCount ?? estimatedFromChars;
    const remainingTokens = Number.isFinite(inputTokenLimit) && inputTokenLimit !== null
      ? Math.max(0, inputTokenLimit - usedTokens)
      : null;
    const usageRatio = Number.isFinite(inputTokenLimit) && inputTokenLimit !== null && inputTokenLimit > 0
      ? Math.max(0, Math.min(1, usedTokens / inputTokenLimit))
      : null;

    return {
      model: this.config.model,
      usedTokens,
      inputTokenLimit,
      remainingTokens,
      usageRatio,
      estimated: tokenCount === null,
    };
  }

  async executeAgenticLoop({
    history,
    message,
    attachments = [],
    defaultTimeouts,
    onChunk,
    onAgentStart,
    onAgentResult,
    executeAgentCall,
    signal,
    customSystemInstruction,
    customTools,
    customModel,
    customThinkingLevel,
  }) {
    const maxIterations = 25;
    const effectiveModel = typeof customModel === 'string' && customModel.trim()
      ? customModel.trim()
      : this.config.model;
    const effectiveThinkingLevel = sanitizeThinkingLevel(customThinkingLevel)
      || sanitizeThinkingLevel(this.config.thinkingLevel)
      || 'minimal';

    let contents = [];

    if (history && history.length > 0) {
      history.forEach((entry) => {
        const role = entry.role === 'assistant' ? 'model' : 'user';
        const text = String(entry.content || '').trim();
        contents.push({ role, parts: [{ text }] });
      });
    }

    const latestUserParts = [{ text: `Latest user message: ${String(message || '').trim()} ` }];
    if (Array.isArray(attachments) && attachments.length > 0) {
      attachments.forEach((attachment, index) => {
        const name = String(attachment?.name || `attachment_${index + 1}`).trim();
        const mimeType = String(attachment?.mimeType || attachment?.inlineData?.mimeType || 'application/octet-stream').trim();
        const size = Number(attachment?.size);
        const sizeLabel = Number.isFinite(size) && size > 0 ? `${size} bytes` : 'size n/a';
        latestUserParts.push({ text: `Attachment ${index + 1}: ${name} (${mimeType}, ${sizeLabel})` });

        const data = String(attachment?.inlineData?.data || '').trim();
        const partMimeType = String(attachment?.inlineData?.mimeType || mimeType).trim();
        const fileUri = String(attachment?.fileData?.fileUri || '').trim();
        const fileDataMime = String(attachment?.fileData?.mimeType || partMimeType).trim();
        if (fileUri && fileDataMime) {
          latestUserParts.push({
            fileData: {
              mimeType: fileDataMime,
              fileUri,
            },
          });
        } else if (data && partMimeType) {
          latestUserParts.push({
            inlineData: {
              mimeType: partMimeType,
              data,
            },
          });
        }
      });
    }

    contents.push({
      role: 'user',
      parts: latestUserParts
    });

    const tools = customTools || [{ functionDeclarations: AGENT_TOOLS }];

    let finalText = '';
    const plan = { mode: 'chat', execution: 'sequential', rationale: '', agentCalls: [] };
    const agentResults = [];

    let isDone = false;
    let iterationCount = 0;
    let continuationNeeded = false;
    let continuationReason = '';
    const continuationPrompt = 'Continua executia agentica de unde ai ramas in mesajul anterior. Nu repeta pasii finalizati; continua doar pasii ramasi.';

    while (!isDone && iterationCount < maxIterations) {
      iterationCount += 1;
      if (signal?.aborted) throw new Error('Aborted');

      const stream = await this._generateWithThinkingFallback(
        (config) => this.ai.models.generateContentStream({
          model: effectiveModel,
          contents,
          config,
        }),
        this._commonConfig({
          systemInstruction: customSystemInstruction || ORCHESTRATOR_SYSTEM_INSTRUCTION,
          tools,
        }, true, { thinkingLevel: effectiveThinkingLevel })
      );

      let parsedFunctionCalls = [];
      let latestUsage = null;
      let assistantParts = [];

      for await (const chunk of stream) {
        if (signal?.aborted) throw new Error('Aborted');

        if (Array.isArray(chunk.parts)) {
          for (const part of chunk.parts) {
            assistantParts.push(part);
          }
        }

        try {
          if (chunk.text) {
            finalText += chunk.text;
            if (onChunk) await onChunk(chunk.text);
          }
        } catch (e) {
          // ignore when chunk has function calls but no text
        }

        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          parsedFunctionCalls.push(...chunk.functionCalls);
        }

        if (chunk.usageMetadata) {
          latestUsage = chunk.usageMetadata;
        }
      }

      // Instead of manual reconstruction, just use the parts we got from chunk directly
      if (assistantParts.length > 0) {
        contents.push({ role: 'model', parts: assistantParts });
      }

      if (parsedFunctionCalls.length === 0) {
        isDone = true;
        this._emitUsage('final', this._extractUsage(latestUsage));
        break;
      }

      plan.mode = 'agents';

      const functionResponses = [];
      for (const fCall of parsedFunctionCalls) {
        if (signal?.aborted) throw new Error('Aborted');

        const agentName = fCall.name.replace('call_', '');
        let goal = fCall.args?.goal || '';
        if (typeof goal === 'string' && agentName === 'fs') {
          try {
            goal = JSON.parse(goal);
          } catch (e) {
            // keep as string if not parseable
          }
        }
        const timeoutSec = Number(fCall.args?.timeoutSec);

        const callInfo = {
          agent: agentName,
          goal: typeof goal === 'object' ? goal : String(goal),
          args: fCall.args,
          timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0
            ? Math.min(timeoutSec * 1000, 10 * 60 * 1000)
            : (defaultTimeouts[agentName] || 60000)
        };

        plan.agentCalls.push(callInfo);

        if (onAgentStart) {
          await onAgentStart(callInfo);
        }

        const result = await executeAgentCall(callInfo);
        agentResults.push(result);

        if (onAgentResult) {
          await onAgentResult(callInfo, result);
        }

        functionResponses.push({
          name: fCall.name,
          response: { result }
        });
      }

      contents.push({
        role: 'user',
        parts: functionResponses.map((r) => ({ functionResponse: r }))
      });
    }

    if (!isDone && iterationCount >= maxIterations) {
      continuationNeeded = true;
      continuationReason = `S - a atins limita de ${maxIterations} iteratii pentru un singur run.`;
      if (!finalText.trim()) {
        finalText = [
          continuationReason,
          'Pot continua daca apesi butonul "Continue".',
        ].join('\n');
      }
    }

    if (!finalText.trim() && agentResults.length > 0) {
      finalText = agentResults.map((res, i) => {
        const prefix = res.ok ? '[SUCCES]' : '[EROARE]';
        return `${i + 1}. ${prefix} Agent ${res.agent}: \n${res.summary || res.text || res.error || ''} `;
      }).join('\n\n');
    }

    return {
      responseText: finalText.trim(),
      plan,
      agentResults,
      continuationNeeded,
      continuationReason,
      continuationPrompt,
      iterationsUsed: iterationCount,
      maxIterations,
    };
  }


}
