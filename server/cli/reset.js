#!/usr/bin/env node
import fs from 'node:fs';
import { getGeminiApiKey } from '../core/config.js';
import { upsertSecretEnvValues } from '../core/secretEnv.js';
import { ensureModelCatalogExists } from '../core/modelCatalogSeed.js';
import { createDefaultBootOnboardingState, ensureBootPromptFile } from '../services/bootOnboarding.js';
import { restartManagedApp, stopManagedApp } from './appLifecycle.js';
import {
    c,
    printBanner,
    readConfig,
    writeConfig,
    ensureDataDirectories,
    ORCHESTRATOR_HOME,
} from './helpers.js';

const DEFAULT_PORT = 8787;
const DEFAULT_CONTEXT_MESSAGES = 120;

async function main() {
    printBanner();
    console.log(c.bold('  Reset Workspace'));
    console.log(c.dim('  Recreating ~/.orchestrator for onboarding tests.'));
    console.log('');

    const existing = readConfig();
    const existingApiKey = getGeminiApiKey();

    await stopManagedApp({ silent: true });

    process.stdout.write(c.dim(`  Removing ${ORCHESTRATOR_HOME}... `));
    fs.rmSync(ORCHESTRATOR_HOME, { recursive: true, force: true });
    console.log(c.green('OK'));

    process.stdout.write(c.dim('  Recreating runtime data... '));
    ensureDataDirectories();
    const catalogResult = ensureModelCatalogExists();
    console.log(c.green('OK'));
    if (catalogResult.created) {
        console.log(c.dim(`  Seeded model catalog to ${catalogResult.path}`));
    }

    if (existingApiKey) {
        upsertSecretEnvValues({
            GEMINI_API_KEY: existingApiKey,
        });
    }

    const config = {
        port: Number(existing?.port) || DEFAULT_PORT,
        context: {
            messages: Number(existing?.context?.messages ?? existing?.contextMessages) || DEFAULT_CONTEXT_MESSAGES,
        },
        agents: {},
        cron: { enabled: true },
        ui: {
            aiName: 'AI Chat',
            userName: 'User',
            aiEmoji: '🤖',
            aiVibe: 'pragmatic helper',
        },
        onboarding: createDefaultBootOnboardingState(),
    };

    writeConfig(config);
    const bootPrompt = ensureBootPromptFile({ overwrite: true });

    await restartManagedApp({
        buildIfMissing: true,
        forceBuild: false,
        silent: true,
    });

    console.log('');
    console.log(c.green(c.bold('  Reset complete.')));
    console.log(c.dim('  Next first chat will run BOOT onboarding.'));
    if (!existingApiKey) {
        console.log(c.yellow('  Warning: API key was not found. Set it from setup or env before chatting.'));
    }
    console.log(c.dim(`  BOOT file: ${bootPrompt.path}`));
    console.log('');
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(c.red(`  ${message}`));
    process.exitCode = 1;
});
