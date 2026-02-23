/**
 * Runtime configuration loader
 */

import fs from 'fs';
import path from 'path';

export interface BrowserConfig {
    startupUrl: string;
    userDataDir: string;
    headless: boolean;
    launchArgs: string[];
}

export interface RuntimeConfig {
    maxIterations: number;
    maxConversationHistory: number;
    stepDelayMs: number;
    actionSettleDelayMs: number;
    waitActionDelayMs: number;
    cleanContextBeforeTask: boolean;
}

export interface ControlApiConfig {
    enabled: boolean;
    host: string;
    port: number;
    apiKey: string;
}

export interface LlmConfig {
    model: string;
    thinkingBudget: number;
    temperature: number;
}

export interface AgentConfig {
    browser: BrowserConfig;
    runtime: RuntimeConfig;
    controlApi: ControlApiConfig;
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
    controlApi?: Partial<ControlApiConfig>;
    llm?: Partial<LlmConfig>;
};

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
    browser: {
        startupUrl: 'https://www.google.com',
        userDataDir: 'user-data-patchright',
        headless: true,
        launchArgs: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
        ],
    },
    runtime: {
        maxIterations: 50,
        maxConversationHistory: 40,
        stepDelayMs: 500,
        actionSettleDelayMs: 300,
        waitActionDelayMs: 3000,
        cleanContextBeforeTask: false,
    },
    controlApi: {
        enabled: false,
        host: '127.0.0.1',
        port: 3020,
        apiKey: '',
    },
    llm: {
        model: 'gemini-2.0-flash',
        thinkingBudget: 0,
        temperature: 0,
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

function applyEnvOverrides(config: AgentConfig): AgentConfig {
    const overridden: AgentConfig = {
        browser: { ...config.browser },
        runtime: { ...config.runtime },
        controlApi: { ...config.controlApi },
        llm: { ...config.llm },
    };

    if (process.env.AGENT_STARTUP_URL) {
        overridden.browser.startupUrl = process.env.AGENT_STARTUP_URL;
    }

    if (process.env.AGENT_USER_DATA_DIR) {
        overridden.browser.userDataDir = process.env.AGENT_USER_DATA_DIR;
    }

    const headlessFromEnv = parseBoolean(process.env.AGENT_HEADLESS);
    if (headlessFromEnv !== undefined) {
        overridden.browser.headless = headlessFromEnv;
    }

    const cleanContextFromEnv = parseBoolean(process.env.AGENT_CLEAN_CONTEXT_BEFORE_TASK);
    if (cleanContextFromEnv !== undefined) {
        overridden.runtime.cleanContextBeforeTask = cleanContextFromEnv;
    }

    const maxIterationsFromEnv = parseNumber(process.env.AGENT_MAX_ITERATIONS);
    if (maxIterationsFromEnv !== undefined && maxIterationsFromEnv > 0) {
        overridden.runtime.maxIterations = Math.floor(maxIterationsFromEnv);
    }

    const controlEnabledFromEnv = parseBoolean(process.env.AGENT_CONTROL_ENABLED);
    if (controlEnabledFromEnv !== undefined) {
        overridden.controlApi.enabled = controlEnabledFromEnv;
    }

    if (process.env.AGENT_CONTROL_HOST) {
        overridden.controlApi.host = process.env.AGENT_CONTROL_HOST;
    }

    const portFromEnv = parseNumber(process.env.AGENT_CONTROL_PORT);
    if (portFromEnv !== undefined && portFromEnv > 0) {
        overridden.controlApi.port = Math.floor(portFromEnv);
    }

    if (process.env.AGENT_CONTROL_API_KEY) {
        overridden.controlApi.apiKey = process.env.AGENT_CONTROL_API_KEY;
    }

    if (process.env.AGENT_MODEL) {
        overridden.llm.model = process.env.AGENT_MODEL;
    }

    const thinkingBudgetFromEnv = parseNumber(process.env.AGENT_THINKING_BUDGET);
    if (thinkingBudgetFromEnv !== undefined && thinkingBudgetFromEnv >= 0) {
        overridden.llm.thinkingBudget = Math.floor(thinkingBudgetFromEnv);
    }

    const temperatureFromEnv = parseNumber(process.env.AGENT_TEMPERATURE);
    if (temperatureFromEnv !== undefined) {
        overridden.llm.temperature = Math.max(0, Math.min(2, temperatureFromEnv));
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
        controlApi: {
            ...base.controlApi,
            ...(partial.controlApi || {}),
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
            startupUrl: config.browser.startupUrl || DEFAULT_AGENT_CONFIG.browser.startupUrl,
            userDataDir: config.browser.userDataDir || DEFAULT_AGENT_CONFIG.browser.userDataDir,
            headless: Boolean(config.browser.headless),
            launchArgs: Array.isArray(config.browser.launchArgs) && config.browser.launchArgs.length > 0
                ? config.browser.launchArgs
                : DEFAULT_AGENT_CONFIG.browser.launchArgs,
        },
        runtime: {
            maxIterations: config.runtime.maxIterations > 0 ? Math.floor(config.runtime.maxIterations) : DEFAULT_AGENT_CONFIG.runtime.maxIterations,
            maxConversationHistory: config.runtime.maxConversationHistory > 0 ? Math.floor(config.runtime.maxConversationHistory) : DEFAULT_AGENT_CONFIG.runtime.maxConversationHistory,
            stepDelayMs: config.runtime.stepDelayMs >= 0 ? Math.floor(config.runtime.stepDelayMs) : DEFAULT_AGENT_CONFIG.runtime.stepDelayMs,
            actionSettleDelayMs: config.runtime.actionSettleDelayMs >= 0 ? Math.floor(config.runtime.actionSettleDelayMs) : DEFAULT_AGENT_CONFIG.runtime.actionSettleDelayMs,
            waitActionDelayMs: config.runtime.waitActionDelayMs >= 0 ? Math.floor(config.runtime.waitActionDelayMs) : DEFAULT_AGENT_CONFIG.runtime.waitActionDelayMs,
            cleanContextBeforeTask: Boolean(config.runtime.cleanContextBeforeTask),
        },
        controlApi: {
            enabled: Boolean(config.controlApi.enabled),
            host: config.controlApi.host || DEFAULT_AGENT_CONFIG.controlApi.host,
            port: config.controlApi.port > 0 ? Math.floor(config.controlApi.port) : DEFAULT_AGENT_CONFIG.controlApi.port,
            apiKey: config.controlApi.apiKey || '',
        },
        llm: {
            model: config.llm.model || DEFAULT_AGENT_CONFIG.llm.model,
            thinkingBudget: config.llm.thinkingBudget >= 0 ? Math.floor(config.llm.thinkingBudget) : DEFAULT_AGENT_CONFIG.llm.thinkingBudget,
            temperature: Number.isFinite(config.llm.temperature)
                ? Math.max(0, Math.min(2, config.llm.temperature))
                : DEFAULT_AGENT_CONFIG.llm.temperature,
        },
    };
}

export function getDefaultConfigPath(): string {
    return path.resolve(process.cwd(), 'agent.config.json');
}

export function loadAgentConfig(explicitPath?: string): AgentConfigLoadResult {
    const configPath = explicitPath
        ? path.resolve(process.cwd(), explicitPath)
        : process.env.AGENT_CONFIG_PATH
            ? path.resolve(process.cwd(), process.env.AGENT_CONFIG_PATH)
            : getDefaultConfigPath();

    let merged = DEFAULT_AGENT_CONFIG;
    let loadedFromFile = false;

    if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw) as PartialAgentConfig;
        merged = mergeConfig(DEFAULT_AGENT_CONFIG, parsed);
        loadedFromFile = true;
    }

    const withEnvOverrides = applyEnvOverrides(merged);
    const sanitized = sanitizeConfig(withEnvOverrides);

    return {
        config: sanitized,
        configPath,
        loadedFromFile,
    };
}
