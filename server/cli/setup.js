#!/usr/bin/env node
import {
    c, printBanner, createPrompt,
    readConfig, writeConfig, ensureDataDirectories,
    validateApiKey, maskApiKey, CONFIG_PATH,
} from './helpers.js';

async function main() {
    printBanner();
    console.log(c.bold('  Setup Wizard'));
    console.log('');

    const existing = readConfig();
    const prompt = createPrompt();

    try {
        if (existing) {
            console.log(c.yellow('  Existing config found at:'));
            console.log(c.dim(`  ${CONFIG_PATH}`));
            if (existing.geminiApiKey) {
                console.log(c.dim(`  API key: ${maskApiKey(existing.geminiApiKey)}`));
            }
            console.log('');
            const overwrite = await prompt.ask('  Overwrite existing config? (y/N) ');
            if (overwrite.toLowerCase() !== 'y') {
                console.log('');
                console.log(c.dim('  Setup cancelled. Existing config unchanged.'));
                return;
            }
            console.log('');
        }

        // 1. Ask for API key
        const defaultKey = existing?.geminiApiKey ?? '';
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

        // 4. Create directories
        console.log('');
        process.stdout.write(c.dim('  Creating data directories... '));
        ensureDataDirectories();
        console.log(c.green('OK'));

        // 5. Write config (unified schema)
        const config = {
            geminiApiKey: apiKey,
            port,
            context: {
                messages: existing?.context?.messages ?? existing?.contextMessages ?? 120,
            },
            agents: existing?.agents ?? {},
            memory: existing?.memory ?? { enabled: true, consolidationModel: 'gemini-3-flash-preview', window: 100 },
            cron: existing?.cron ?? { enabled: true },
        };

        writeConfig(config);
        console.log(c.dim(`  Config written to ${CONFIG_PATH}`));

        // 6. Success
        console.log('');
        console.log(c.green(c.bold('  Setup complete!')));
        console.log('');
        console.log('  Next steps:');
        console.log(`    ${c.cyan('npm run dev')}     Start the dev server`);
        console.log(`    ${c.cyan('npm run status')}  Check configuration status`);
        console.log('');
    } finally {
        prompt.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
