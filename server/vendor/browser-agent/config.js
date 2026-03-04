/**
 * Runtime configuration loader
 */
import fs from 'fs';
import path from 'path';
export const DEFAULT_AGENT_CONFIG = {
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
    llm: {
        model: 'gemini-3-flash-preview',
        thinkingLevel: 'minimal',
    },
};
function parseBoolean(value) {
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
function parseNumber(value) {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    return parsed;
}
function parseThinkingLevel(value) {
    if (value === undefined) {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }
    return undefined;
}
function applyEnvOverrides(config) {
    const overridden = {
        browser: { ...config.browser },
        runtime: { ...config.runtime },
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
    if (process.env.AGENT_MODEL) {
        overridden.llm.model = process.env.AGENT_MODEL;
    }
    const thinkingLevelFromEnv = parseThinkingLevel(process.env.AGENT_THINKING_LEVEL
        || process.env.BROWSER_AGENT_THINKING_LEVEL
        || process.env.ORCHESTRATOR_THINKING_LEVEL);
    if (thinkingLevelFromEnv) {
        overridden.llm.thinkingLevel = thinkingLevelFromEnv;
    }
    return overridden;
}
function mergeConfig(base, partial) {
    const merged = {
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
function sanitizeConfig(config) {
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
        llm: {
            model: config.llm.model || DEFAULT_AGENT_CONFIG.llm.model,
            thinkingLevel: parseThinkingLevel(config.llm.thinkingLevel) || DEFAULT_AGENT_CONFIG.llm.thinkingLevel,
        },
    };
}
export function getDefaultConfigPath() {
    return path.resolve(process.cwd(), 'agent.config.json');
}
export function loadAgentConfig(explicitPath) {
    const configPath = explicitPath
        ? path.resolve(process.cwd(), explicitPath)
        : process.env.AGENT_CONFIG_PATH
            ? path.resolve(process.cwd(), process.env.AGENT_CONFIG_PATH)
            : getDefaultConfigPath();
    let merged = DEFAULT_AGENT_CONFIG;
    let loadedFromFile = false;
    if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
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
