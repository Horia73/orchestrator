#!/usr/bin/env node
import { runCli } from './appLifecycle.js';

runCli('status').catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
