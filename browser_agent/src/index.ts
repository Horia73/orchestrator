/**
 * AI Browser Agent - Manual CLI entrypoint
 */

import 'dotenv/config';
import * as readline from 'readline';
import { loadAgentConfig } from './config.js';
import { createAgentRuntime } from './runtime.js';

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           🤖 AI Browser Agent - Vision Control               ║');
    console.log('║                                                              ║');
    console.log('║  Commands:                                                   ║');
    console.log('║    • Type any task (e.g., "go to amazon and search books")  ║');
    console.log('║    • Type a new task anytime to interrupt the current one   ║');
    console.log('║    • Type "stop" to stop the current task                   ║');
    console.log('║    • Type "reset" to clear in-memory context               ║');
    console.log('║    • Type "restart" to relaunch browser session            ║');
    console.log('║    • Type "status" for runtime status                      ║');
    console.log('║    • Type "exit" or "quit" to close                         ║');
    console.log('║                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');

    if (!process.env.GEMINI_API_KEY) {
        console.error('❌ Error: GEMINI_API_KEY environment variable is not set.');
        console.error('   Get your key from: https://aistudio.google.com/apikey');
        console.error('   Then run: GEMINI_API_KEY=your_key npm start');
        process.exit(1);
    }

    const { config, configPath, loadedFromFile } = loadAgentConfig();
    console.log(`⚙️ Config: ${loadedFromFile ? 'loaded' : 'default'} (${configPath})`);

    const runtime = createAgentRuntime(config, (message) => console.log(message));
    await runtime.start();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const prompt = () => {
        rl.question('\n💬 You: ', async (input) => {
            const trimmed = input.trim();
            const command = trimmed.toLowerCase();

            if (!trimmed) {
                prompt();
                return;
            }

            try {
                if (command === 'exit' || command === 'quit') {
                    console.log('👋 Goodbye!');
                    await runtime.shutdown();
                    rl.close();
                    process.exit(0);
                }

                if (command === 'stop') {
                    runtime.stopTask();
                    prompt();
                    return;
                }

                if (command === 'reset') {
                    await runtime.resetContext({
                        stopRunningTask: true,
                        navigateToStartup: false,
                        clearMemory: false,
                    });
                    prompt();
                    return;
                }

                if (command === 'restart') {
                    await runtime.restart();
                    prompt();
                    return;
                }

                if (command === 'status') {
                    const status = await runtime.getStatus();
                    console.log('📊 Status:', JSON.stringify(status, null, 2));
                    prompt();
                    return;
                }

                await runtime.submitTask(trimmed, {
                    cleanContext: false,
                    preserveContext: true,
                });
                prompt();
            } catch (error) {
                console.error(`❌ Command failed: ${error instanceof Error ? error.message : String(error)}`);
                prompt();
            }
        });
    };

    prompt();

    process.on('SIGINT', async () => {
        console.log('\n👋 Shutting down...');
        await runtime.shutdown();
        process.exit(0);
    });
}

main().catch(console.error);
