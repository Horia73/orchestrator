/**
 * AI Browser Agent - Control API entrypoint
 */

import 'dotenv/config';
import { loadAgentConfig } from './config.js';
import { createControlServer } from './control-server.js';
import { createAgentRuntime } from './runtime.js';

async function main() {
    if (!process.env.GEMINI_API_KEY) {
        console.error('❌ Error: GEMINI_API_KEY environment variable is not set.');
        process.exit(1);
    }

    const { config, configPath, loadedFromFile } = loadAgentConfig();
    console.log(`⚙️ Config: ${loadedFromFile ? 'loaded' : 'default'} (${configPath})`);
    console.log(
        `🧭 Browser mode: ${config.browser.headless ? 'headless' : 'headed'}`
        + ` | Control API: http://${config.controlApi.host}:${config.controlApi.port}`
    );

    if (!config.controlApi.enabled) {
        console.error('❌ Control API is disabled. Set controlApi.enabled=true in agent.config.json');
        process.exit(1);
    }

    const runtime = createAgentRuntime(config, (message) => console.log(message));
    await runtime.start();

    const controlServer = createControlServer(runtime, config.controlApi, (message) => console.log(message));
    await controlServer.start();

    process.on('SIGINT', async () => {
        console.log('\n👋 Shutting down control mode...');
        await controlServer.stop();
        await runtime.shutdown();
        process.exit(0);
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
