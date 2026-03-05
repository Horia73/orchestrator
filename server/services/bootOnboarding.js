import fs from 'node:fs';
import path from 'node:path';
import { BOOT_PROMPT_PATH } from '../core/dataPaths.js';
import { reloadConfigJson, updateConfigSection } from '../core/config.js';
import { readUiSettings, writeUiSettings } from '../storage/settings.js';

const ONBOARDING_VERSION = 1;
const STEP_AI_NAME = 'ai_name';
const STEP_USER_NAME = 'user_name';
const STEP_AI_EMOJI = 'ai_emoji';
const STEP_AI_VIBE = 'ai_vibe';
const STEP_COMPLETE = 'complete';
const ONBOARDING_STEPS = [STEP_AI_NAME, STEP_USER_NAME, STEP_AI_EMOJI, STEP_AI_VIBE];

export const DEFAULT_BOOT_PROMPT_CONTENT = `# BOOT MODE

First-run onboarding is active.
The assistant must stay in onboarding mode until these values are collected:
1. AI name
2. User name
3. AI emoji
4. AI vibe / identity

When complete:
- Save values in ~/.orchestrator/config.json (ui settings).
- Remove this BOOT.md file.
- Resume standard assistant behavior.
`;

function toTimestamp(value, fallback = Date.now()) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return Math.trunc(fallback);
    }

    return Math.trunc(parsed);
}

function sanitizeName(value, fallback = '') {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return fallback;
    }

    return normalized.slice(0, 64);
}

function sanitizeEmoji(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        return fallback;
    }

    const match = normalized.match(/\p{Extended_Pictographic}/u);
    return match?.[0] ?? fallback;
}

function sanitizeVibe(value, fallback = '') {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return fallback;
    }

    return normalized.slice(0, 140);
}

export function createDefaultBootOnboardingState() {
    const now = Date.now();
    return {
        version: ONBOARDING_VERSION,
        status: 'pending',
        started: false,
        step: STEP_AI_NAME,
        profile: {
            aiName: '',
            userName: '',
            aiEmoji: '',
            aiVibe: '',
        },
        createdAt: now,
        updatedAt: now,
    };
}

function normalizeBootOnboardingState(value) {
    const base = createDefaultBootOnboardingState();
    if (!value || typeof value !== 'object') {
        return base;
    }

    const status = String(value.status ?? '').trim().toLowerCase() === 'completed'
        ? 'completed'
        : 'pending';
    const rawStep = String(value.step ?? '').trim().toLowerCase();
    const step = status === 'completed'
        ? STEP_COMPLETE
        : (ONBOARDING_STEPS.includes(rawStep) ? rawStep : STEP_AI_NAME);
    const profileSource = value.profile && typeof value.profile === 'object'
        ? value.profile
        : {};

    return {
        version: ONBOARDING_VERSION,
        status,
        started: status === 'completed' ? true : value.started === true,
        step,
        profile: {
            aiName: sanitizeName(profileSource.aiName),
            userName: sanitizeName(profileSource.userName),
            aiEmoji: sanitizeEmoji(profileSource.aiEmoji),
            aiVibe: sanitizeVibe(profileSource.aiVibe),
        },
        createdAt: toTimestamp(value.createdAt, base.createdAt),
        updatedAt: toTimestamp(value.updatedAt, base.updatedAt),
        ...(status === 'completed'
            ? { completedAt: toTimestamp(value.completedAt, Date.now()) }
            : {}),
    };
}

export function readBootOnboardingState() {
    const config = reloadConfigJson();
    return normalizeBootOnboardingState(config?.onboarding);
}

export function writeBootOnboardingState(state) {
    const normalized = normalizeBootOnboardingState({
        ...state,
        updatedAt: Date.now(),
    });
    updateConfigSection('onboarding', normalized);
    return normalized;
}

export function ensureBootPromptFile({ overwrite = false } = {}) {
    const shouldWrite = overwrite || !fs.existsSync(BOOT_PROMPT_PATH);
    if (!shouldWrite) {
        return {
            path: BOOT_PROMPT_PATH,
            created: false,
        };
    }

    fs.mkdirSync(path.dirname(BOOT_PROMPT_PATH), { recursive: true });
    fs.writeFileSync(BOOT_PROMPT_PATH, DEFAULT_BOOT_PROMPT_CONTENT, 'utf8');
    return {
        path: BOOT_PROMPT_PATH,
        created: true,
    };
}

export function isBootOnboardingActive() {
    if (!fs.existsSync(BOOT_PROMPT_PATH)) {
        return false;
    }

    const state = readBootOnboardingState();
    if (state.status === 'completed') {
        try {
            fs.rmSync(BOOT_PROMPT_PATH, { force: true });
        } catch {
            // ignore cleanup failure
        }
        return false;
    }

    return true;
}

function buildStepPrompt(step, { reprompt = false } = {}) {
    if (step === STEP_AI_NAME) {
        if (reprompt) {
            return 'Am nevoie de un nume clar pentru AI. Cum vrei să mă cheme?';
        }
        return '1/4. Cum vrei să mă cheme AI-ul? (ex: Nova, Atlas, Mira)';
    }

    if (step === STEP_USER_NAME) {
        if (reprompt) {
            return 'Mai am nevoie de un nume pentru tine. Cum vrei să-ți spun?';
        }
        return '2/4. Cum vrei să-ți spun eu ție?';
    }

    if (step === STEP_AI_EMOJI) {
        if (reprompt) {
            return 'Am nevoie de un emoji real (ex: 🤖, 🧠, 🦊). Ce alegi?';
        }
        return '3/4. Alege un emoji pentru mine.';
    }

    if (step === STEP_AI_VIBE) {
        if (reprompt) {
            return 'Spune-mi un vibe/identitate în câteva cuvinte (ex: calm pragmatic, friendly mentor).';
        }
        return '4/4. Ce vibe/identitate vrei să am?';
    }

    return 'Onboarding finalizat.';
}

function completeBootOnboarding(state) {
    const currentUi = readUiSettings();
    const nextUi = writeUiSettings({
        ...currentUi,
        aiName: state.profile.aiName || currentUi.aiName,
        userName: state.profile.userName || currentUi.userName,
        aiEmoji: state.profile.aiEmoji || currentUi.aiEmoji,
        aiVibe: state.profile.aiVibe || currentUi.aiVibe,
    });

    const completedState = writeBootOnboardingState({
        ...state,
        status: 'completed',
        step: STEP_COMPLETE,
        started: true,
        completedAt: Date.now(),
        profile: {
            aiName: nextUi.aiName,
            userName: nextUi.userName,
            aiEmoji: nextUi.aiEmoji,
            aiVibe: nextUi.aiVibe,
        },
    });

    let bootRemoved = false;
    try {
        fs.rmSync(BOOT_PROMPT_PATH, { force: true });
        bootRemoved = true;
    } catch {
        bootRemoved = false;
    }

    return {
        state: completedState,
        uiSettings: nextUi,
        bootRemoved,
    };
}

function withUpdatedState(state, updates) {
    return writeBootOnboardingState({
        ...state,
        ...updates,
    });
}

function hasAnswer(text) {
    return String(text ?? '').trim().length > 0;
}

function buildIntroPrompt() {
    return [
        'Salut. E primul run, deci facem onboarding rapid înainte de instrucțiunile standard.',
        'Sunt 4 pași și gata.',
        '',
        buildStepPrompt(STEP_AI_NAME),
    ].join('\n');
}

export function advanceBootOnboarding(userText) {
    if (!isBootOnboardingActive()) {
        return {
            active: false,
            completed: false,
            assistantText: '',
        };
    }

    const answer = String(userText ?? '').trim();
    const currentState = readBootOnboardingState();

    if (!currentState.started) {
        withUpdatedState(currentState, {
            started: true,
            step: STEP_AI_NAME,
        });
        return {
            active: true,
            completed: false,
            assistantText: buildIntroPrompt(),
        };
    }

    if (currentState.step === STEP_AI_NAME) {
        const aiName = sanitizeName(answer);
        if (!hasAnswer(aiName)) {
            return {
                active: true,
                completed: false,
                assistantText: buildStepPrompt(STEP_AI_NAME, { reprompt: true }),
            };
        }

        const nextState = withUpdatedState(currentState, {
            step: STEP_USER_NAME,
            profile: {
                ...currentState.profile,
                aiName,
            },
        });

        return {
            active: true,
            completed: false,
            assistantText: [
                `Perfect, eu voi fi ${aiName}.`,
                buildStepPrompt(nextState.step),
            ].join('\n'),
        };
    }

    if (currentState.step === STEP_USER_NAME) {
        const userName = sanitizeName(answer);
        if (!hasAnswer(userName)) {
            return {
                active: true,
                completed: false,
                assistantText: buildStepPrompt(STEP_USER_NAME, { reprompt: true }),
            };
        }

        const nextState = withUpdatedState(currentState, {
            step: STEP_AI_EMOJI,
            profile: {
                ...currentState.profile,
                userName,
            },
        });

        return {
            active: true,
            completed: false,
            assistantText: [
                `Super, îți voi spune ${userName}.`,
                buildStepPrompt(nextState.step),
            ].join('\n'),
        };
    }

    if (currentState.step === STEP_AI_EMOJI) {
        const aiEmoji = sanitizeEmoji(answer);
        if (!hasAnswer(aiEmoji)) {
            return {
                active: true,
                completed: false,
                assistantText: buildStepPrompt(STEP_AI_EMOJI, { reprompt: true }),
            };
        }

        const nextState = withUpdatedState(currentState, {
            step: STEP_AI_VIBE,
            profile: {
                ...currentState.profile,
                aiEmoji,
            },
        });

        return {
            active: true,
            completed: false,
            assistantText: [
                `Nice, emoji setat: ${aiEmoji}`,
                buildStepPrompt(nextState.step),
            ].join('\n'),
        };
    }

    if (currentState.step === STEP_AI_VIBE) {
        const aiVibe = sanitizeVibe(answer);
        if (!hasAnswer(aiVibe)) {
            return {
                active: true,
                completed: false,
                assistantText: buildStepPrompt(STEP_AI_VIBE, { reprompt: true }),
            };
        }

        const completed = completeBootOnboarding({
            ...currentState,
            profile: {
                ...currentState.profile,
                aiVibe,
            },
        });

        const shutdownLine = completed.bootRemoved
            ? 'Am salvat în config și am închis BOOT mode.'
            : 'Am salvat în config, dar nu am reușit să șterg BOOT.md automat.';

        return {
            active: true,
            completed: true,
            assistantText: [
                'Perfect, onboarding finalizat.',
                `Identitate: ${completed.uiSettings.aiEmoji} ${completed.uiSettings.aiName} (${completed.uiSettings.aiVibe}).`,
                `Tu ești: ${completed.uiSettings.userName}.`,
                shutdownLine,
                'De acum primesc instrucțiunile standard.',
            ].join('\n'),
        };
    }

    return {
        active: true,
        completed: false,
        assistantText: buildStepPrompt(STEP_AI_NAME, { reprompt: false }),
    };
}
