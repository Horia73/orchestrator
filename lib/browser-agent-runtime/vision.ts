/**
 * Vision service dispatcher.
 *
 * Public entry point for the browser agent's vision loop. Picks the concrete
 * backend (Gemini API or Codex CLI app-server) from `VisionConfig.provider`,
 * keeps the canonical config, and hot-swaps backends on `updateConfig` — which
 * is how escalation moves between the light and pro slots even across
 * providers (e.g. light on Gemini, pro on Codex).
 */

import { ActionTrace, BrowserDownloadFile, BrowserFrameSnapshot } from './browser';
import { ActionHistoryItem, TabInfo, IterationLimitReview } from './prompts';
import type { VisionProvider } from './config';
import {
    AgentAction,
    VisionConfig,
    VisionService,
    VisionUsage,
    parseAgentActionsFromModelText,
    parseIterationLimitReviewFromModelText,
    requestParsedJsonWithRetries,
    sanitizeMediaResolution,
    sanitizeThinkingLevel,
} from './vision-shared';
import { createGeminiVisionService, geminiVisionTestHooks } from './vision-gemini';
import { createCodexVisionService } from './vision-codex';

export type {
    AgentAction,
    VisionConfig,
    VisionService,
    VisionUsage,
    VisionCoordinateMode,
} from './vision-shared';
export { ModelOutputParseError } from './vision-shared';

function sanitizeProvider(value: unknown): VisionProvider | '' {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'google' || normalized === 'codex') {
        return normalized;
    }
    return '';
}

export function createVisionService(
    initialConfig: Partial<VisionConfig> = {},
    onUsage?: (usage: VisionUsage) => void
): VisionService {
    const canonical: VisionConfig = {
        provider: sanitizeProvider(initialConfig.provider) || 'google',
        model: typeof initialConfig.model === 'string' && initialConfig.model.trim()
            ? initialConfig.model.trim()
            : 'gemini-3-flash-preview',
        thinkingLevel: sanitizeThinkingLevel(initialConfig.thinkingLevel) || 'minimal',
        mediaResolution: sanitizeMediaResolution(initialConfig.mediaResolution) || 'medium',
    };

    const backends = new Map<VisionProvider, VisionService>();

    function activeBackend(): VisionService {
        let backend = backends.get(canonical.provider);
        if (!backend) {
            backend = canonical.provider === 'codex'
                ? createCodexVisionService({ ...canonical }, onUsage)
                : createGeminiVisionService({ ...canonical }, onUsage);
            backends.set(canonical.provider, backend);
        } else {
            // Keep a previously-instantiated backend in sync with the canonical
            // model/thinking settings (escalation swaps these between calls).
            backend.updateConfig({ ...canonical });
        }
        return backend;
    }

    const service: VisionService = {
        updateConfig(patch: Partial<VisionConfig>) {
            if (!patch || typeof patch !== 'object') return;

            const provider = sanitizeProvider(patch.provider);
            if (provider) {
                canonical.provider = provider;
            }
            if (typeof patch.model === 'string' && patch.model.trim()) {
                canonical.model = patch.model.trim();
            }
            if (typeof patch.thinkingLevel === 'string' && patch.thinkingLevel.trim()) {
                canonical.thinkingLevel = sanitizeThinkingLevel(patch.thinkingLevel) || canonical.thinkingLevel;
            }
            if (typeof patch.mediaResolution === 'string' && patch.mediaResolution.trim()) {
                canonical.mediaResolution = sanitizeMediaResolution(patch.mediaResolution) || canonical.mediaResolution;
            }

            // Sync the (possibly newly selected) backend if it already exists;
            // otherwise it is created with the canonical config on first use.
            backends.get(canonical.provider)?.updateConfig({ ...canonical });
        },

        getConfig(): VisionConfig {
            return { ...canonical };
        },

        getCoordinateMode() {
            return canonical.provider === 'codex' ? 'pixel' as const : 'normalized' as const;
        },

        analyzeScreenshot(
            frame: BrowserFrameSnapshot,
            goal: string,
            actionHistory: ActionHistoryItem[],
            conversationHistory: string[] = [],
            recentTrace: ActionTrace | null = null,
            supplementalFrames: BrowserFrameSnapshot[] = [],
            isInterrupt = false,
            openTabs: TabInfo[] = [],
            isAdvancedMode: boolean = false,
            downloads: BrowserDownloadFile[] = [],
            escalationEnabled: boolean = true
        ): Promise<AgentAction[]> {
            return activeBackend().analyzeScreenshot(
                frame,
                goal,
                actionHistory,
                conversationHistory,
                recentTrace,
                supplementalFrames,
                isInterrupt,
                openTabs,
                isAdvancedMode,
                downloads,
                escalationEnabled,
            );
        },

        reflectOnIterationLimit(
            frame: BrowserFrameSnapshot,
            goal: string,
            actionHistory: ActionHistoryItem[],
            conversationHistory: string[] = [],
            recentTrace: ActionTrace | null = null,
            supplementalFrames: BrowserFrameSnapshot[] = [],
            openTabs: TabInfo[] = [],
            downloads: BrowserDownloadFile[] = []
        ): Promise<IterationLimitReview | null> {
            return activeBackend().reflectOnIterationLimit(
                frame,
                goal,
                actionHistory,
                conversationHistory,
                recentTrace,
                supplementalFrames,
                openTabs,
                downloads,
            );
        },

        async dispose() {
            const instances = [...backends.values()];
            backends.clear();
            await Promise.allSettled(instances.map((backend) => backend.dispose?.()));
        },

        cancelActive() {
            for (const backend of backends.values()) {
                try {
                    backend.cancelActive?.();
                } catch {
                    // Best-effort cancellation; never let it mask the caller's path.
                }
            }
        },
    };

    return service;
}

export const browserVisionTestHooks = {
    buildRequestConfig: geminiVisionTestHooks.buildRequestConfig,
    parseAgentActionsFromModelText,
    parseIterationLimitReviewFromModelText,
    requestParsedJsonWithRetries,
};
