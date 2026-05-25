/**
 * Runtime configuration loader
 */

import fs from 'fs';
import path from 'path';

export interface BrowserConfig {
    backend: BrowserBackend;
    startupUrl: string;
    userDataDir: string;
    headless: boolean;
    liveView: boolean;
    launchArgs: string[];
    profileMode: BrowserProfileMode;
    baseProfileDir: string;
    chromeExecutablePath: string;
    maxConcurrent: number;
}

export interface RuntimeConfig {
    maxIterations: number;
    maxConversationHistory: number;
    stepDelayMs: number;
    actionSettleDelayMs: number;
    waitActionDelayMs: number;
    cleanContextBeforeTask: boolean;
}

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type AdvancedThinkingLevel = 'low' | 'medium' | 'high';
export type MediaResolutionLevel = 'low' | 'medium' | 'high';
export type BrowserBackend = 'patchright' | 'official-display';
export type BrowserBackendPreference = 'auto' | BrowserBackend;
export type BrowserProfileMode = 'isolated' | 'clone-base' | 'shared-serial';

export interface LlmConfig {
    model: string;
    thinkingLevel: ThinkingLevel;
    mediaResolution: MediaResolutionLevel;
    advancedModel: string;
    advancedThinkingLevel: AdvancedThinkingLevel;
    advancedMediaResolution: MediaResolutionLevel;
}

export interface AgentConfig {
    browser: BrowserConfig;
    runtime: RuntimeConfig;
    llm: LlmConfig;
}

export interface AgentConfigLoadResult {
    config: AgentConfig;
    configPath: string;
    loadedFromFile: boolean;
}

type PartialAgentConfig = {
    browser?: Partial<BrowserConfig>;
    runtime?: Partial<RuntimeConfig>;
    llm?: Partial<LlmConfig>;
};

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
    browser: {
        backend: 'patchright',
        startupUrl: 'https://www.google.com',
        userDataDir: 'user-data-patchright',
        headless: true,
        liveView: false,
        launchArgs: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
            '--hide-crash-restore-bubble',
            '--disable-session-crashed-bubble',
        ],
        profileMode: 'isolated',
        baseProfileDir: '',
        chromeExecutablePath: '',
        maxConcurrent: 3,
    },
    runtime: {
        maxIterations: 60,
        maxConversationHistory: 40,
        stepDelayMs: 500,
        actionSettleDelayMs: 1000,
        waitActionDelayMs: 3000,
        cleanContextBeforeTask: false,
    },
    llm: {
        model: 'gemini-3-flash-preview',
        thinkingLevel: 'low',
        mediaResolution: 'medium',
        advancedModel: 'gemini-3.1-pro-preview',
        advancedThinkingLevel: 'low',
        advancedMediaResolution: 'medium',
    },
};

function parseBoolean(value: string | undefined): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }

    return parsed;
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
    if (value === undefined) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }

    return undefined;
}

function parseAdvancedThinkingLevel(value: string | undefined): AdvancedThinkingLevel | undefined {
    const parsed = parseThinkingLevel(value);
    if (parsed === 'low' || parsed === 'medium' || parsed === 'high') {
        return parsed;
    }

    return undefined;
}

function parseMediaResolutionLevel(value: string | undefined): MediaResolutionLevel | undefined {
    if (value === undefined) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase().replace(/^media[_-]resolution[_-]/, '');
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }

    return undefined;
}

function parseBrowserBackend(value: string | undefined): BrowserBackend | undefined {
    if (value === undefined) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase().replace(/_/g, '-');
    if (normalized === 'patchright' || normalized === 'official-display') {
        return normalized;
    }

    return undefined;
}

function parseBrowserProfileMode(value: string | undefined): BrowserProfileMode | undefined {
    if (value === undefined) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase().replace(/_/g, '-');
    if (normalized === 'isolated' || normalized === 'clone-base' || normalized === 'shared-serial') {
        return normalized;
    }

    return undefined;
}

function applyEnvOverrides(config: AgentConfig): AgentConfig {
    const overridden: AgentConfig = {
        browser: { ...config.browser },
        runtime: { ...config.runtime },
        llm: { ...config.llm },
    };

    if (process.env.AGENT_STARTUP_URL) {
        overridden.browser.startupUrl = process.env.AGENT_STARTUP_URL;
    }

    const backendFromEnv = parseBrowserBackend(process.env.BROWSER_AGENT_BACKEND);
    if (backendFromEnv) {
        overridden.browser.backend = backendFromEnv;
    }

    if (process.env.AGENT_USER_DATA_DIR) {
        overridden.browser.userDataDir = process.env.AGENT_USER_DATA_DIR;
    }

    if (process.env.BROWSER_AGENT_BASE_PROFILE_DIR) {
        overridden.browser.baseProfileDir = process.env.BROWSER_AGENT_BASE_PROFILE_DIR;
    }

    if (process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH) {
        overridden.browser.chromeExecutablePath = process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH || '';
    }

    const profileModeFromEnv = parseBrowserProfileMode(process.env.BROWSER_AGENT_PROFILE_MODE);
    if (profileModeFromEnv) {
        overridden.browser.profileMode = profileModeFromEnv;
    }

    const maxConcurrentFromEnv = parseNumber(process.env.BROWSER_AGENT_MAX_CONCURRENT);
    if (maxConcurrentFromEnv !== undefined && maxConcurrentFromEnv > 0) {
        overridden.browser.maxConcurrent = Math.floor(maxConcurrentFromEnv);
    }

    const headlessFromEnv = parseBoolean(process.env.AGENT_HEADLESS);
    if (headlessFromEnv !== undefined) {
        overridden.browser.headless = headlessFromEnv;
    }

    const liveViewFromEnv = parseBoolean(process.env.BROWSER_AGENT_LIVE_VIEW);
    if (liveViewFromEnv !== undefined) {
        overridden.browser.liveView = liveViewFromEnv;
    }

    const cleanContextFromEnv = parseBoolean(process.env.AGENT_CLEAN_CONTEXT_BEFORE_TASK);
    if (cleanContextFromEnv !== undefined) {
        overridden.runtime.cleanContextBeforeTask = cleanContextFromEnv;
    }

    const maxIterationsFromEnv = parseNumber(process.env.AGENT_MAX_ITERATIONS);
    if (maxIterationsFromEnv !== undefined && maxIterationsFromEnv > 0) {
        overridden.runtime.maxIterations = Math.floor(maxIterationsFromEnv);
    }

    if (process.env.AGENT_MODEL) {
        overridden.llm.model = process.env.AGENT_MODEL;
    }

    if (process.env.AGENT_ADVANCED_MODEL) {
        overridden.llm.advancedModel = process.env.AGENT_ADVANCED_MODEL;
    }

    const thinkingLevelFromEnv = parseThinkingLevel(
        process.env.AGENT_THINKING_LEVEL
        || process.env.BROWSER_AGENT_THINKING_LEVEL
        || process.env.ORCHESTRATOR_THINKING_LEVEL
    );
    if (thinkingLevelFromEnv) {
        overridden.llm.thinkingLevel = thinkingLevelFromEnv;
    }

    const advancedThinkingLevelFromEnv = parseAdvancedThinkingLevel(process.env.AGENT_ADVANCED_THINKING_LEVEL);
    if (advancedThinkingLevelFromEnv) {
        overridden.llm.advancedThinkingLevel = advancedThinkingLevelFromEnv;
    }

    const mediaResolutionFromEnv = parseMediaResolutionLevel(
        process.env.AGENT_MEDIA_RESOLUTION
        || process.env.BROWSER_AGENT_MEDIA_RESOLUTION
    );
    if (mediaResolutionFromEnv) {
        overridden.llm.mediaResolution = mediaResolutionFromEnv;
    }

    const advancedMediaResolutionFromEnv = parseMediaResolutionLevel(process.env.AGENT_ADVANCED_MEDIA_RESOLUTION);
    if (advancedMediaResolutionFromEnv) {
        overridden.llm.advancedMediaResolution = advancedMediaResolutionFromEnv;
    }

    return overridden;
}

function mergeConfig(base: AgentConfig, partial: PartialAgentConfig): AgentConfig {
    const merged: AgentConfig = {
        browser: {
            ...base.browser,
            ...(partial.browser || {}),
        },
        runtime: {
            ...base.runtime,
            ...(partial.runtime || {}),
        },
        llm: {
            ...base.llm,
            ...(partial.llm || {}),
        },
    };

    if (partial.browser?.launchArgs) {
        merged.browser.launchArgs = partial.browser.launchArgs;
    }

    return merged;
}

function sanitizeConfig(config: AgentConfig): AgentConfig {
    return {
        browser: {
            backend: parseBrowserBackend(config.browser.backend) || DEFAULT_AGENT_CONFIG.browser.backend,
            startupUrl: config.browser.startupUrl || DEFAULT_AGENT_CONFIG.browser.startupUrl,
            userDataDir: config.browser.userDataDir || DEFAULT_AGENT_CONFIG.browser.userDataDir,
            headless: Boolean(config.browser.headless),
            liveView: Boolean(config.browser.liveView),
            launchArgs: Array.isArray(config.browser.launchArgs) && config.browser.launchArgs.length > 0
                ? config.browser.launchArgs
                : DEFAULT_AGENT_CONFIG.browser.launchArgs,
            profileMode: parseBrowserProfileMode(config.browser.profileMode) || DEFAULT_AGENT_CONFIG.browser.profileMode,
            baseProfileDir: typeof config.browser.baseProfileDir === 'string' ? config.browser.baseProfileDir : DEFAULT_AGENT_CONFIG.browser.baseProfileDir,
            chromeExecutablePath: typeof config.browser.chromeExecutablePath === 'string' ? config.browser.chromeExecutablePath : DEFAULT_AGENT_CONFIG.browser.chromeExecutablePath,
            maxConcurrent: config.browser.maxConcurrent > 0 ? Math.floor(config.browser.maxConcurrent) : DEFAULT_AGENT_CONFIG.browser.maxConcurrent,
        },
        runtime: {
            maxIterations: config.runtime.maxIterations > 0 ? Math.floor(config.runtime.maxIterations) : DEFAULT_AGENT_CONFIG.runtime.maxIterations,
            maxConversationHistory: config.runtime.maxConversationHistory > 0 ? Math.floor(config.runtime.maxConversationHistory) : DEFAULT_AGENT_CONFIG.runtime.maxConversationHistory,
            stepDelayMs: config.runtime.stepDelayMs >= 0 ? Math.floor(config.runtime.stepDelayMs) : DEFAULT_AGENT_CONFIG.runtime.stepDelayMs,
            actionSettleDelayMs: config.runtime.actionSettleDelayMs >= 0 ? Math.floor(config.runtime.actionSettleDelayMs) : DEFAULT_AGENT_CONFIG.runtime.actionSettleDelayMs,
            waitActionDelayMs: config.runtime.waitActionDelayMs >= 0 ? Math.floor(config.runtime.waitActionDelayMs) : DEFAULT_AGENT_CONFIG.runtime.waitActionDelayMs,
            cleanContextBeforeTask: Boolean(config.runtime.cleanContextBeforeTask),
        },
        llm: {
            model: config.llm.model || DEFAULT_AGENT_CONFIG.llm.model,
            thinkingLevel: parseThinkingLevel(config.llm.thinkingLevel) || DEFAULT_AGENT_CONFIG.llm.thinkingLevel,
            mediaResolution: parseMediaResolutionLevel(config.llm.mediaResolution) || DEFAULT_AGENT_CONFIG.llm.mediaResolution,
            advancedModel: config.llm.advancedModel || DEFAULT_AGENT_CONFIG.llm.advancedModel,
            advancedThinkingLevel: parseAdvancedThinkingLevel(config.llm.advancedThinkingLevel) || DEFAULT_AGENT_CONFIG.llm.advancedThinkingLevel,
            advancedMediaResolution: parseMediaResolutionLevel(config.llm.advancedMediaResolution) || DEFAULT_AGENT_CONFIG.llm.advancedMediaResolution,
        },
    };
}

function applyCliOverrides(config: AgentConfig): AgentConfig {
    const overridden: AgentConfig = {
        browser: { ...config.browser },
        runtime: { ...config.runtime },
        llm: { ...config.llm },
    };

    const args = process.argv.slice(2);

    const isHeadfulClean = args.includes('--headful') || args.includes('--headfull') || args.includes('-h');
    const isHeadfulPersistent = args.includes('-p') || args.includes('--persistent');

    if (isHeadfulPersistent) {
        overridden.browser.headless = false;
        // Keep the default/configured userDataDir which is persistent
    } else if (isHeadfulClean) {
        overridden.browser.headless = false;
        overridden.browser.userDataDir = `user-data-temp-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    }

    return overridden;
}

export function getDefaultConfigPath(): string {
    return path.resolve(/* turbopackIgnore: true */ process.cwd(), 'agent.config.json');
}

export function loadAgentConfig(explicitPath?: string): AgentConfigLoadResult {
    const configPath = explicitPath
        ? path.resolve(/* turbopackIgnore: true */ process.cwd(), explicitPath)
        : process.env.AGENT_CONFIG_PATH
            ? path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.AGENT_CONFIG_PATH)
            : getDefaultConfigPath();

    let merged = DEFAULT_AGENT_CONFIG;
    let loadedFromFile = false;

    if (fs.existsSync(/* turbopackIgnore: true */ configPath)) {
        const raw = fs.readFileSync(/* turbopackIgnore: true */ configPath, 'utf8');
        const parsed = JSON.parse(raw) as PartialAgentConfig;
        merged = mergeConfig(DEFAULT_AGENT_CONFIG, parsed);
        loadedFromFile = true;
    }

    const withEnvOverrides = applyEnvOverrides(merged);
    const withCliOverrides = applyCliOverrides(withEnvOverrides);
    const sanitized = sanitizeConfig(withCliOverrides);

    return {
        config: sanitized,
        configPath,
        loadedFromFile,
    };
}
