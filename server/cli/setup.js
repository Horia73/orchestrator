#!/usr/bin/env node
import {
    c, printBanner, createPrompt,
    readConfig, writeConfig, ensureDataDirectories,
    validateApiKey, maskApiKey, CONFIG_PATH,
} from './helpers.js';
import { getAppUrl, getConfiguredPort } from './lifecycleCore.js';
import { restartManagedApp } from './appLifecycle.js';
import { getGeminiApiKey } from '../core/config.js';
import { upsertSecretEnvValues } from '../core/secretEnv.js';
import { ensureModelCatalogExists } from '../core/modelCatalogSeed.js';
import { ensureBrowserRuntimeDependencies } from './runtimeDependencies.js';

async function main() {
    printBanner();
    console.log(c.bold('  Setup Wizard'));
    console.log('');

    const existing = readConfig();
    const existingApiKey = getGeminiApiKey();
    const prompt = createPrompt();
    let promptClosed = false;

    const closePrompt = () => {
        if (promptClosed) {
            return;
        }
        prompt.close();
        promptClosed = true;
    };

    try {
        if (existing) {
            console.log(c.yellow('  Existing config found. Press Enter to keep current values.'));
            console.log(c.dim(`  ${CONFIG_PATH}`));
            if (existingApiKey) {
                console.log(c.dim(`  API key: ${maskApiKey(existingApiKey)}`));
            }
            console.log('');
        }

        // 1. Ask for API key
        const defaultKey = existingApiKey;
        const keyPromptText = defaultKey
            ? `  Gemini API key [${maskApiKey(defaultKey)}]: `
            : '  Gemini API key: ';
        let apiKey = await prompt.ask(keyPromptText);
        if (!apiKey && defaultKey) {
            apiKey = defaultKey;
        }

        if (!apiKey) {
            console.log(c.red('  API key is required.'));
            process.exitCode = 1;
            return;
        }

        // 2. Validate API key
        process.stdout.write(c.dim('  Validating API key... '));
        const valid = await validateApiKey(apiKey);
        if (valid) {
            console.log(c.green('OK'));
        } else {
            console.log(c.red('FAILED'));
            console.log(c.yellow('  Warning: API key validation failed. Saving anyway.'));
            console.log(c.dim('  (The key may still work — check your network/billing.)'));
        }

        // 3. Port
        const defaultPort = existing?.port ?? 8787;
        const portInput = await prompt.ask(`  API port [${defaultPort}]: `);
        const port = Number(portInput) || defaultPort;
        closePrompt();

        // 4. Create directories
        console.log('');
        process.stdout.write(c.dim('  Creating data directories... '));
        ensureDataDirectories();
        const modelCatalogResult = ensureModelCatalogExists();
        console.log(c.green('OK'));
        if (modelCatalogResult.created) {
            console.log(c.dim(`  Seeded model catalog to ${modelCatalogResult.path}`));
        }

        upsertSecretEnvValues({
            GEMINI_API_KEY: apiKey,
        });

        // 5. Write config (unified schema)
        const config = {
            port,
            context: {
                messages: existing?.context?.messages ?? existing?.contextMessages ?? 120,
            },
            agents: existing?.agents ?? {},
            cron: existing?.cron ?? { enabled: true },
            ui: existing?.ui ?? { aiName: 'AI Chat', userName: 'User' },
        };

        writeConfig(config);
        console.log(c.dim(`  Config written to ${CONFIG_PATH}`));

        // 6. Install browser runtime requirements
        console.log('');
        await ensureBrowserRuntimeDependencies();

        // 7. Build + start the background app
        console.log('');
        console.log(c.bold('  Finalizing'));
        console.log(c.dim('  Building production bundle and starting Orchestrator in the background...'));
        await restartManagedApp({
            buildIfMissing: true,
            forceBuild: true,
            silent: true,
        });

        const appUrl = getAppUrl(getConfiguredPort());

        // 8. Success
        console.log('');
        console.log(c.green(c.bold('  Setup complete!')));
        console.log('');
        console.log(`  Open:           ${c.cyan(appUrl)}`);
        console.log(`  Background app: ${c.green('running')}`);
        console.log('');
        console.log('  Useful commands:');
        console.log(`    ${c.cyan('npm start')}       Start in background`);
        console.log(`    ${c.cyan('npm stop')}        Stop the background app`);
        console.log(`    ${c.cyan('npm restart')}     Restart the background app`);
        console.log(`    ${c.cyan('npm run status')}  Check status and logs path`);
        console.log(`    ${c.cyan('npm run dev')}     Run frontend + API in development mode`);
        console.log('');
    } finally {
        closePrompt();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
