#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, printBanner, readConfig, maskApiKey, CONFIG_PATH, DATA_ROOT_DIR } from './helpers.js';

function dirSizeSync(dirPath) {
    let total = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true, recursive: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                try {
                    const fullPath = path.join(entry.parentPath ?? entry.path, entry.name);
                    total += fs.statSync(fullPath).size;
                } catch { /* skip */ }
            }
        }
    } catch { /* dir doesn't exist */ }

    return total;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function checkPort(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
        socket.connect(port, '127.0.0.1');
    });
}

function discoverAgents() {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const agentsDir = join(__dirname, '..', 'agents');
    const agents = [];

    try {
        const entries = readdirSync(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && existsSync(join(agentsDir, entry.name, 'index.js'))) {
                agents.push(entry.name);
            }
        }
    } catch { /* agents dir doesn't exist */ }

    return agents.sort();
}

async function main() {
    printBanner();

    const config = readConfig();
    const configExists = config !== null;

    // Config
    console.log(c.bold('  Configuration'));
    console.log(`    Config file:  ${configExists ? c.green(CONFIG_PATH) : c.red(CONFIG_PATH + ' (not found)')}`);
    if (configExists) {
        console.log(`    API key:      ${config.geminiApiKey ? c.green(maskApiKey(config.geminiApiKey)) : c.red('(not set)')}`);
        console.log(`    Port:         ${config.port ?? 8787}`);
        console.log(`    Tools model:  ${config.toolsModel ?? c.dim('(default)')}`);
    } else {
        console.log(c.yellow('    Run "npm run setup" to create config.'));
    }
    console.log('');

    // Data
    console.log(c.bold('  Data'));
    console.log(`    Location:  ${DATA_ROOT_DIR}`);
    const subdirs = ['chats', 'settings', 'usage', 'logs'];
    for (const sub of subdirs) {
        const subPath = path.join(DATA_ROOT_DIR, sub);
        const exists = fs.existsSync(subPath);
        const size = exists ? formatBytes(dirSizeSync(subPath)) : '-';
        const status = exists ? c.dim(size) : c.dim('(empty)');
        console.log(`    ${sub.padEnd(12)} ${status}`);
    }
    console.log('');

    // Server status
    const port = config?.port ?? 8787;
    const running = await checkPort(port);
    console.log(c.bold('  Server'));
    console.log(`    Port ${port}:     ${running ? c.green('RUNNING') : c.dim('not running')}`);
    console.log('');

    // Agents (discovered from filesystem)
    const agents = discoverAgents();
    console.log(c.bold('  Agents'));
    for (const agent of agents) {
        console.log(`    ${agent}`);
    }
    console.log('');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
