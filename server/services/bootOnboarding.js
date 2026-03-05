import fs from 'node:fs';
import path from 'node:path';
import {
    BOOT_PROMPT_PATH,
    CONFIG_PATH,
    IDENTITY_MEMORY_PATH,
    ORCHESTRATOR_HOME,
    MEMORY_PATH,
    SOUL_MEMORY_PATH,
    USER_MEMORY_PATH,
} from '../core/dataPaths.js';

const ONBOARDING_VERSION = 3;

export const DEFAULT_BOOT_PROMPT_CONTENT = `# BOOTSTRAP MODE

You just hatched!
This file is your guide through your new life.

Mission:
- Onboard the user conversationally (natural chat, not rigid scripts).
- Collect and confirm:
  - assistant display name
  - user display name
  - assistant emoji
  - assistant vibe / identity

Voice and style:
- Sound human, warm, and present.
- Keep replies short, natural, and adaptive to what the user just said.
- Use light personality and humor when it fits.
- Mirror the user's language automatically (Romanian with Romanian users, English with English users, etc.).

Rules:
- Ask naturally, one or more clarifications at a time when needed.
- Stay in onboarding mode until all required values are confirmed and saved.
- Keep tone short, clear, and conversational.

Runtime paths:
- Runtime home: ${ORCHESTRATOR_HOME}
- Config file: ${CONFIG_PATH}
- BOOT file: ${BOOT_PROMPT_PATH}
- Permanent memory: ${MEMORY_PATH}

Tooling (use tools directly):
- Read and edit: ${CONFIG_PATH}
- Persist values under:
  - ui.aiName
  - ui.userName
  - ui.aiEmoji
  - ui.aiVibe
- Also update memory identity files:
  - ${MEMORY_PATH}
  - ${USER_MEMORY_PATH}
  - ${IDENTITY_MEMORY_PATH}
  - ${SOUL_MEMORY_PATH}
- Keep those memory files short and useful (clear bullets, no fluff).
- Ensure permanent memory keeps a stable birth date line for the assistant.
- After save, delete: ${BOOT_PROMPT_PATH}

Exit criteria:
1) Values are saved in config.json.
2) USER.md, IDENTITY.md, and SOUL.md are updated.
3) BOOT.md is removed.
4) You tell the user onboarding is complete and summarize chosen identity.
`;

export function createDefaultBootOnboardingState() {
    const now = Date.now();
    return {
        version: ONBOARDING_VERSION,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
    };
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
    return fs.existsSync(BOOT_PROMPT_PATH);
}

export function readBootPromptInstruction() {
    if (!isBootOnboardingActive()) {
        return '';
    }

    try {
        const raw = fs.readFileSync(BOOT_PROMPT_PATH, 'utf8');
        const normalized = String(raw ?? '').trim();
        return normalized || DEFAULT_BOOT_PROMPT_CONTENT;
    } catch {
        return DEFAULT_BOOT_PROMPT_CONTENT;
    }
}
