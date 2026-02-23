import { GoogleGenAI, Type } from '@google/genai';

const ALLOWED_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];



function normalizeModel(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

function normalizeAspectRatio(value, fallback = '1:1') {
  const raw = String(value || '').trim();
  if (ALLOWED_ASPECT_RATIOS.includes(raw)) return raw;
  return fallback;
}

function clampImageCount(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 4));
}

function parseAspectRatioFromGoal(goal) {
  const text = String(goal || '').toLowerCase();
  const explicit = text.match(/\b(1:1|3:4|4:3|9:16|16:9)\b/);
  if (explicit?.[1]) return explicit[1];
  if (/\b(portrait|vertical|story|reels?)\b/.test(text)) return '9:16';
  if (/\b(landscape|wide|cinematic|banner|panorama)\b/.test(text)) return '16:9';
  if (/\b(square|instagram post)\b/.test(text)) return '1:1';
  return '';
}

function parseImageCountFromGoal(goal) {
  const text = String(goal || '').toLowerCase();
  const direct = text.match(/\b([1-4])\s*(?:images?|pics?|poze?|poza)\b/);
  if (direct?.[1]) return clampImageCount(direct[1], 1);
  return 1;
}



function cleanGoal(rawGoal) {
  const text = String(rawGoal || '').trim();
  if (!text) return '';

  const fencedMatch = text.match(/```(?:text|md|markdown)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return String(fencedMatch[1]).trim();
  }

  return text.replace(/^(generate|create|draw|render)\s+(an?\s+)?image\s*[:\-]?\s*/i, '').trim() || text;
}



function firstUsefulLine(value) {
  const lines = String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] || '';
}

function extensionForMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  return '.png';
}

function buildImageMarkdown(images = []) {
  return images
    .map((image, index) => `![Generated image ${index + 1}](${image.url})`)
    .join('\n\n');
}

function createRunAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  signal?.addEventListener('abort', onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) controller.abort();
  }, Math.max(1, Number(timeoutMs) || 1));

  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  };

  return {
    signal: controller.signal,
    cleanup,
    didTimeout: () => timedOut,
  };
}

export class ImageAgentClient {
  constructor(config = {}, { onLog, mediaStore } = {}) {
    this.config = config;
    this.onLog = typeof onLog === 'function' ? onLog : null;
    this.mediaStore = mediaStore || null;
    this.ai = new GoogleGenAI({ apiKey: config.apiKey });
  }

  updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object') return;

    if (typeof patch.model === 'string' && patch.model.trim()) {
      this.config.model = patch.model.trim();
    }

    if (typeof patch.enabled === 'boolean') {
      this.config.enabled = patch.enabled;
    }
  }

  getConfig() {
    return {
      model: this.config.model,
      enabled: Boolean(this.config.enabled),
      timeoutMs: Number(this.config.timeoutMs) || 0,
    };
  }



  async runTask({ goal, timeoutMs, signal, conversationId }) {
    const trimmedGoal = cleanGoal(goal);
    if (!trimmedGoal) {
      return {
        ok: false,
        agent: 'image',
        goal: '',
        error: 'Missing goal for image agent call.',
        summary: 'Missing image prompt.',
      };
    }

    if (!this.config.enabled) {
      return {
        ok: false,
        agent: 'image',
        goal: trimmedGoal,
        error: 'Image agent is disabled (IMAGE_AGENT_ENABLED=false).',
        summary: 'Image agent disabled.',
      };
    }

    if (!this.mediaStore) {
      return {
        ok: false,
        agent: 'image',
        goal: trimmedGoal,
        error: 'Image agent missing media store dependency.',
        summary: 'Image storage is unavailable.',
      };
    }

    const startedAt = Date.now();
    const effectiveTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(this.config.timeoutMs) || 120000);
    const timeoutGuard = createRunAbortSignal(signal, effectiveTimeout);
    const timeline = [];

    this.onLog?.({
      level: 'info',
      component: 'image-agent',
      event: 'agent_task_started',
      message: `Image generation started: ${trimmedGoal}`,
      data: {
        goal: trimmedGoal,
        model: this.config.model,
        timeoutMs: effectiveTimeout,
      },
    });

    try {
      const requestedAspectRatio = normalizeAspectRatio(
        parseAspectRatioFromGoal(trimmedGoal),
        this.config.defaultAspectRatio || '1:1'
      );
      const requestedImageCount = clampImageCount(
        parseImageCountFromGoal(trimmedGoal),
        this.config.defaultNumberOfImages || 1
      );

      timeline.push(`Prompt ready (${requestedAspectRatio}, ${requestedImageCount} image).`);

      const generationResponse = await this.ai.models.generateImages({
        model: this.config.model,
        prompt: trimmedGoal,
        config: {
          numberOfImages: requestedImageCount,
          aspectRatio: requestedAspectRatio,
          outputMimeType: this.config.outputMimeType || 'image/png',
          includeRaiReason: true,
          abortSignal: timeoutGuard.signal,
        },
      });

      const generatedImages = Array.isArray(generationResponse?.generatedImages)
        ? generationResponse.generatedImages
        : [];

      const savedImages = [];
      const filteredReasons = [];

      for (let i = 0; i < generatedImages.length; i += 1) {
        const item = generatedImages[i] || {};
        const bytes = String(item?.image?.imageBytes || '').trim();
        const mimeType = String(item?.image?.mimeType || this.config.outputMimeType || 'image/png').trim() || 'image/png';
        const reason = String(item?.raiFilteredReason || '').trim();

        if (!bytes) {
          if (reason) filteredReasons.push(reason);
          continue;
        }

        const ext = extensionForMime(mimeType);
        const saved = await this.mediaStore.saveBase64({
          fileName: `generated_image_${i + 1}${ext}`,
          mimeType,
          dataBase64: bytes,
          conversationId: conversationId || 'general',
        });

        savedImages.push({
          name: saved.name,
          type: saved.mimeType,
          size: saved.size,
          url: saved.urlPath,
          storageKey: saved.storageKey,
        });
      }

      if (savedImages.length === 0) {
        const reason = firstUsefulLine(filteredReasons.join('\n')) || 'Image model returned no renderable images.';
        this.onLog?.({
          level: 'warn',
          component: 'image-agent',
          event: 'agent_task_failed',
          message: reason,
          data: {
            goal: trimmedGoal,
            model: this.config.model,
            durationMs: Date.now() - startedAt,
          },
        });

        return {
          ok: false,
          agent: 'image',
          goal: trimmedGoal,
          durationMs: Date.now() - startedAt,
          model: normalizeModel(this.config.model),
          prompt: trimmedGoal,
          aspectRatio: requestedAspectRatio,
          numberOfImages: requestedImageCount,
          error: reason,
          summary: reason,
          timeline,
        };
      }

      timeline.push(`Saved ${savedImages.length} image(s) to media store.`);

      const imageMarkdown = buildImageMarkdown(savedImages);
      const summary = `Generated ${savedImages.length} image(s) with ${normalizeModel(this.config.model)}.`;

      this.onLog?.({
        level: 'info',
        component: 'image-agent',
        event: 'agent_task_completed',
        message: summary,
        data: {
          goal: trimmedGoal,
          model: this.config.model,
          durationMs: Date.now() - startedAt,
          imageCount: savedImages.length,
          aspectRatio: requestedAspectRatio,
        },
      });

      return {
        ok: true,
        agent: 'image',
        goal: trimmedGoal,
        durationMs: Date.now() - startedAt,
        model: normalizeModel(this.config.model),
        prompt: trimmedGoal,
        aspectRatio: requestedAspectRatio,
        numberOfImages: requestedImageCount,
        images: savedImages,
        imageMarkdown,
        timeline,
        summary,
      };
    } catch (error) {
      const timedOut = timeoutGuard.didTimeout();
      const aborted = signal?.aborted || false;
      const message = timedOut
        ? `Image generation timed out after ${effectiveTimeout}ms.`
        : aborted
          ? 'Image generation was aborted.'
          : (error instanceof Error ? error.message : String(error));

      this.onLog?.({
        level: timedOut || aborted ? 'warn' : 'error',
        component: 'image-agent',
        event: timedOut ? 'agent_timeout' : 'agent_task_failed',
        message,
        data: {
          goal: trimmedGoal,
          model: this.config.model,
          durationMs: Date.now() - startedAt,
          timeoutMs: effectiveTimeout,
        },
      });

      return {
        ok: false,
        agent: 'image',
        goal: trimmedGoal,
        durationMs: Date.now() - startedAt,
        model: normalizeModel(this.config.model),
        error: message,
        summary: message,
        timeline,
      };
    } finally {
      timeoutGuard.cleanup();
    }
  }
}
