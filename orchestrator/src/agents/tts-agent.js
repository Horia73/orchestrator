import { GoogleGenAI } from '@google/genai';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PROMPT_CHARS = 6_000;
const DEFAULT_OUTPUT_MIME = 'audio/wav';

const MIME_TO_EXTENSION = new Map([
  ['audio/wav', '.wav'],
  ['audio/mp3', '.mp3'],
  ['audio/mpeg', '.mp3'],
  ['audio/aiff', '.aiff'],
  ['audio/aac', '.aac'],
  ['audio/ogg', '.ogg'],
  ['audio/flac', '.flac'],
]);

function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeFileSegment(value, fallback = 'audio') {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function extensionFromMime(mimeType) {
  const normalized = compactText(mimeType).toLowerCase();
  return MIME_TO_EXTENSION.get(normalized) || '.wav';
}

function extractFencedJson(text) {
  const match = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1] ? String(match[1]).trim() : '';
}

function parseJsonSafely(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore parsing errors and fallback to plain text handling.
  }
  return null;
}

function parseStructuredGoal(goal) {
  const trimmedGoal = String(goal || '').trim();
  if (!trimmedGoal) return null;

  const fenced = extractFencedJson(trimmedGoal);
  if (fenced) {
    const parsed = parseJsonSafely(fenced);
    if (parsed) return parsed;
  }

  if (trimmedGoal.startsWith('{') && trimmedGoal.endsWith('}')) {
    const parsed = parseJsonSafely(trimmedGoal);
    if (parsed) return parsed;
  }

  return null;
}

function clipText(value, maxChars) {
  const text = String(value || '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function resolveGoalSpec(rawGoal, fallbackVoice, maxPromptChars) {
  const structured = parseStructuredGoal(rawGoal);
  const fallbackText = compactText(rawGoal);

  const text = clipText(compactText(
    structured?.text
    || structured?.script
    || structured?.content
    || structured?.prompt
    || fallbackText
  ), maxPromptChars);
  const voice = compactText(structured?.voice || structured?.voiceName || fallbackVoice) || fallbackVoice;
  const style = compactText(structured?.style || structured?.tone || '');
  const language = compactText(structured?.language || structured?.lang || '');
  const instructions = compactText(structured?.instructions || structured?.pronunciation || '');

  return {
    text,
    voice,
    style,
    language,
    instructions,
  };
}

function buildTtsPrompt({ text, style, language, instructions }) {
  const styleHint = style || 'Natural, clear, conversational pacing.';
  return [
    'Generate spoken audio only.',
    'Read the SCRIPT section exactly as written.',
    'Do not add introductions, disclaimers, or extra words.',
    `Style: ${styleHint}`,
    language ? `Language/locale: ${language}` : '',
    instructions ? `Pronunciation guidance: ${instructions}` : '',
    '',
    'SCRIPT:',
    text,
  ]
    .filter(Boolean)
    .join('\n');
}

function summarizeError(error) {
  if (!error) return 'Unknown TTS error.';
  return error instanceof Error ? error.message : String(error);
}

function extractInlineAudio(response, fallbackMime) {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const data = String(part?.inlineData?.data || '').trim();
      if (!data) continue;
      return {
        dataBase64: data,
        mimeType: compactText(part?.inlineData?.mimeType) || fallbackMime,
      };
    }
  }

  const fallbackData = String(response?.data || '').trim();
  if (!fallbackData) return null;
  return {
    dataBase64: fallbackData,
    mimeType: fallbackMime,
  };
}

function raceWithTimeoutAndAbort(taskPromise, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const effectiveTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`TTS request timed out after ${effectiveTimeout}ms.`));
    }, effectiveTimeout);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Aborted'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    Promise.resolve(taskPromise)
      .then((value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
  });
}

export class TtsAgentClient {
  constructor(config = {}, { onUsage, onLog, saveAudio } = {}) {
    this.config = config;
    this.onUsage = typeof onUsage === 'function' ? onUsage : null;
    this.onLog = typeof onLog === 'function' ? onLog : null;
    this.saveAudio = typeof saveAudio === 'function' ? saveAudio : null;
    this.ai = this.config.apiKey ? new GoogleGenAI({ apiKey: this.config.apiKey }) : null;
  }

  updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object') return;

    if (typeof patch.enabled === 'boolean') {
      this.config.enabled = patch.enabled;
    }

    if (typeof patch.model === 'string' && patch.model.trim()) {
      this.config.model = patch.model.trim();
    }

    if (typeof patch.voice === 'string' && patch.voice.trim()) {
      this.config.voice = patch.voice.trim();
    }

    if (typeof patch.outputMimeType === 'string' && patch.outputMimeType.trim()) {
      this.config.outputMimeType = patch.outputMimeType.trim();
    }

    if (Number.isFinite(Number(patch.timeoutMs)) && Number(patch.timeoutMs) > 0) {
      this.config.timeoutMs = Math.floor(Number(patch.timeoutMs));
    }

    if (Number.isFinite(Number(patch.maxPromptChars)) && Number(patch.maxPromptChars) > 0) {
      this.config.maxPromptChars = Math.floor(Number(patch.maxPromptChars));
    }

    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      this.config.apiKey = patch.apiKey.trim();
      this.ai = new GoogleGenAI({ apiKey: this.config.apiKey });
    }
  }

  getConfig() {
    return {
      enabled: Boolean(this.config.enabled),
      model: String(this.config.model || ''),
      voice: String(this.config.voice || ''),
      outputMimeType: String(this.config.outputMimeType || DEFAULT_OUTPUT_MIME),
      timeoutMs: Number(this.config.timeoutMs) || DEFAULT_TIMEOUT_MS,
      maxPromptChars: Number(this.config.maxPromptChars) || DEFAULT_MAX_PROMPT_CHARS,
    };
  }

  _emitUsage(usageMetadata) {
    if (!this.onUsage || !usageMetadata || typeof usageMetadata !== 'object') return;
    this.onUsage({
      component: 'tts-agent',
      phase: 'task',
      model: this.config.model,
      promptTokens: Number(usageMetadata.promptTokenCount) || 0,
      outputTokens: Number(usageMetadata.candidatesTokenCount) || 0,
      thoughtsTokens: Number(usageMetadata.thoughtsTokenCount) || 0,
      totalTokens: Number(usageMetadata.totalTokenCount) || 0,
      timestamp: new Date().toISOString(),
    });
  }

  async runTask({ goal, timeoutMs, signal, conversationId }) {
    const startedAt = Date.now();
    const rawGoal = String(goal || '').trim();
    if (!rawGoal) {
      return {
        ok: false,
        agent: 'tts',
        goal: '',
        error: 'Missing goal for TTS agent call.',
        summary: 'Missing TTS goal.',
      };
    }

    if (!this.config.enabled) {
      return {
        ok: false,
        agent: 'tts',
        goal: rawGoal,
        error: 'TTS agent is disabled (TTS_AGENT_ENABLED=false).',
        summary: 'TTS agent disabled.',
      };
    }

    if (!this.ai) {
      return {
        ok: false,
        agent: 'tts',
        goal: rawGoal,
        error: 'Missing Gemini API key for TTS agent.',
        summary: 'Missing Gemini API key.',
      };
    }

    if (!this.saveAudio) {
      return {
        ok: false,
        agent: 'tts',
        goal: rawGoal,
        error: 'Media storage is not available for TTS outputs.',
        summary: 'Media storage unavailable.',
      };
    }

    const maxPromptChars = Number(this.config.maxPromptChars) > 0
      ? Number(this.config.maxPromptChars)
      : DEFAULT_MAX_PROMPT_CHARS;
    const spec = resolveGoalSpec(rawGoal, this.config.voice || 'Kore', maxPromptChars);
    if (!spec.text) {
      return {
        ok: false,
        agent: 'tts',
        goal: rawGoal,
        error: 'Missing text/script for speech generation.',
        summary: 'Missing speech script.',
      };
    }

    const model = String(this.config.model || '').trim();
    const voice = spec.voice || this.config.voice || 'Kore';
    const mimeType = String(this.config.outputMimeType || DEFAULT_OUTPUT_MIME).trim() || DEFAULT_OUTPUT_MIME;
    const effectiveTimeout = Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : Number(this.config.timeoutMs) > 0
        ? Number(this.config.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    const prompt = buildTtsPrompt(spec);
    this.onLog?.({
      level: 'info',
      component: 'tts-agent',
      event: 'agent_task_started',
      message: `TTS generation started with ${model}.`,
      data: {
        voice,
        model,
      },
    });

    try {
      const response = await raceWithTimeoutAndAbort(
        this.ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice,
                },
              },
            },
            abortSignal: signal,
          },
        }),
        {
          timeoutMs: effectiveTimeout,
          signal,
        }
      );

      this._emitUsage(response?.usageMetadata);

      const inlineAudio = extractInlineAudio(response, mimeType);
      if (!inlineAudio?.dataBase64) {
        throw new Error('Gemini TTS returned no audio payload.');
      }

      const ext = extensionFromMime(inlineAudio.mimeType);
      const baseName = safeFileSegment(spec.text.split(/\s+/).slice(0, 5).join('_') || 'tts');
      const fileName = `${baseName}${ext}`;
      const stored = await this.saveAudio({
        fileName,
        mimeType: inlineAudio.mimeType,
        dataBase64: inlineAudio.dataBase64,
        conversationId,
      });

      const durationMs = Date.now() - startedAt;
      this.onLog?.({
        level: 'info',
        component: 'tts-agent',
        event: 'agent_task_completed',
        message: `TTS generation completed with ${model}.`,
        data: {
          model,
          voice,
          durationMs,
          file: stored?.storageKey || '',
        },
      });

      return {
        ok: true,
        agent: 'tts',
        goal: rawGoal,
        model,
        voice,
        durationMs,
        prompt,
        summary: `Audio generated (${voice}).`,
        audio: {
          url: stored?.urlPath || '',
          name: stored?.name || fileName,
          type: stored?.mimeType || inlineAudio.mimeType,
          size: Number(stored?.size) || 0,
          storageKey: stored?.storageKey || '',
        },
        timeline: [
          `model=${model}`,
          `voice=${voice}`,
          stored?.urlPath ? `audio=${stored.urlPath}` : 'audio=generated',
        ],
      };
    } catch (error) {
      const message = summarizeError(error);
      this.onLog?.({
        level: 'error',
        component: 'tts-agent',
        event: 'agent_task_failed',
        message,
        data: {
          model,
          voice,
          durationMs: Date.now() - startedAt,
        },
      });

      return {
        ok: false,
        agent: 'tts',
        goal: rawGoal,
        model,
        voice,
        durationMs: Date.now() - startedAt,
        error: message,
        summary: message,
        timeline: [`[error] ${message}`],
      };
    }
  }
}
