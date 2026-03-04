import fs from 'node:fs';
import path from 'node:path';
import {
    AGENT_MEMORY_DIR,
    DAILY_MEMORY_DIR,
    IDENTITY_MEMORY_PATH,
    INTEGRATIONS_MEMORY_PATH,
    MEMORY_DIR,
    MEMORY_PATH,
    SECRETS_ENV_PATH,
    SECRETS_DIR,
    SOUL_MEMORY_PATH,
    USER_MEMORY_PATH,
} from '../core/dataPaths.js';

const RECENT_DAILY_DAYS = 2;
const AGENT_MEMORY_SPECS = Object.freeze([
    {
        agentId: 'orchestrator',
        label: 'Orchestrator',
        description: 'Routing preferences, delegation heuristics, and orchestration-specific reusable lessons.',
    },
    {
        agentId: 'coding',
        label: 'Coding Agent',
        description: 'Repo-specific engineering patterns, prior fixes, and implementation habits useful for similar coding tasks.',
    },
    {
        agentId: 'multipurpose',
        label: 'Multipurpose Agent',
        description: 'Reusable workflows, document-handling patterns, and tool combinations that worked well before.',
    },
    {
        agentId: 'researcher',
        label: 'Researcher Agent',
        description: 'Search strategies, source preferences, and research structures that produced strong results.',
    },
    {
        agentId: 'image',
        label: 'Image Agent',
        description: 'Visual prompting patterns, grounding rules, and output preferences for image tasks.',
    },
    {
        agentId: 'browser',
        label: 'Browser Agent',
        description: 'Reusable browser interaction lessons, site quirks, and confirmed UI workflows for physical web automation.',
    },
]);

const FILE_TEMPLATES = Object.freeze({
    permanent: '# Permanent Memory\n\n',
    user: '# User\n\n',
    identity: '# Identity\n\n',
    soul: '# Soul\n\n',
    integrations: '# Integrations\n\n',
    secretEnv: [
        '# Sensitive values only. Loaded automatically into process.env.',
        '# Keep raw tokens, passwords, API keys, and login secrets here.',
        '# Example:',
        '# GEMINI_API_KEY=your_key_here',
        '# HOME_ASSISTANT_TOKEN=your_token_here',
        '',
    ].join('\n'),
});

function buildAgentTemplate(spec) {
    return `# ${spec.label} Memory\n\n`;
}

function normalizeText(value) {
    return String(value ?? '').replace(/\r\n/g, '\n');
}

function normalizeComparable(value) {
    return normalizeText(value).trim();
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function ensureFile(filePath, defaultContent) {
    if (fs.existsSync(filePath)) {
        return;
    }

    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, defaultContent, 'utf8');
}

function readFileSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8');
        }
    } catch {
        // ignore
    }

    return '';
}

function writeFileSafe(filePath, content) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, normalizeText(content), 'utf8');
}

function formatDateKey(dateValue = new Date()) {
    const date = new Date(dateValue);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function buildDailyTemplate(dateKey) {
    return `# Daily Memory ${dateKey}\n\n`;
}

function isDefaultTemplate(kind, content, options = {}) {
    const normalized = normalizeComparable(content);
    if (!normalized) {
        return true;
    }

    if (kind === 'daily') {
        return normalized === normalizeComparable(buildDailyTemplate(options.dateKey));
    }

    return normalized === normalizeComparable(FILE_TEMPLATES[kind] ?? '');
}

function escapeAttribute(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

class MemoryStore {
    constructor() {
        this.memoryDir = MEMORY_DIR;
        this.dailyDir = DAILY_MEMORY_DIR;
        this.agentMemoryDir = AGENT_MEMORY_DIR;
        this.permanentFile = MEMORY_PATH;
        this.userFile = USER_MEMORY_PATH;
        this.identityFile = IDENTITY_MEMORY_PATH;
        this.soulFile = SOUL_MEMORY_PATH;
        this.integrationsFile = INTEGRATIONS_MEMORY_PATH;
        this.secretEnvFile = SECRETS_ENV_PATH;
        this.secretEnvDir = SECRETS_DIR;
    }

    getAgentSpecs() {
        return AGENT_MEMORY_SPECS.map((spec) => ({ ...spec }));
    }

    getAgentSpec(agentId) {
        const normalizedAgentId = String(agentId ?? '').trim().toLowerCase();
        return AGENT_MEMORY_SPECS.find((spec) => spec.agentId === normalizedAgentId) ?? null;
    }

    getAgentMemoryFilePath(agentId) {
        const spec = this.getAgentSpec(agentId);
        if (!spec) {
            throw new Error(`Unknown agent memory: ${agentId}`);
        }

        return path.join(this.agentMemoryDir, `${spec.agentId}.md`);
    }

    getAgentMemoryFiles() {
        return this.getAgentSpecs().map((spec) => ({
            ...spec,
            path: this.getAgentMemoryFilePath(spec.agentId),
        }));
    }

    ensureScaffold() {
        ensureDir(this.memoryDir);
        ensureDir(this.dailyDir);
        ensureDir(this.agentMemoryDir);
        ensureDir(this.secretEnvDir);

        ensureFile(this.permanentFile, FILE_TEMPLATES.permanent);
        ensureFile(this.userFile, FILE_TEMPLATES.user);
        ensureFile(this.identityFile, FILE_TEMPLATES.identity);
        ensureFile(this.soulFile, FILE_TEMPLATES.soul);
        ensureFile(this.integrationsFile, FILE_TEMPLATES.integrations);
        ensureFile(this.secretEnvFile, FILE_TEMPLATES.secretEnv);
        for (const spec of AGENT_MEMORY_SPECS) {
            ensureFile(this.getAgentMemoryFilePath(spec.agentId), buildAgentTemplate(spec));
        }

        for (const dateKey of this.getRecentDailyDateKeys()) {
            ensureFile(this.getDailyFilePath(dateKey), buildDailyTemplate(dateKey));
        }
    }

    getRecentDailyDateKeys(days = RECENT_DAILY_DAYS) {
        const results = [];
        const base = new Date();

        for (let offset = 0; offset < days; offset += 1) {
            const dateValue = new Date(base);
            dateValue.setDate(base.getDate() - offset);
            results.push(formatDateKey(dateValue));
        }

        return results;
    }

    getDailyFilePath(dateValue = new Date()) {
        const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(dateValue ?? ''))
            ? String(dateValue)
            : formatDateKey(dateValue);
        return path.join(this.dailyDir, `${dateKey}.md`);
    }

    getPaths() {
        this.ensureScaffold();

        return {
            rootDir: this.memoryDir,
            permanentFile: this.permanentFile,
            userFile: this.userFile,
            identityFile: this.identityFile,
            soulFile: this.soulFile,
            integrationsFile: this.integrationsFile,
            agentFiles: this.getAgentMemoryFiles(),
            dailyFiles: this.getRecentDailyDateKeys().map((dateKey) => ({
                date: dateKey,
                path: this.getDailyFilePath(dateKey),
            })),
            secretEnvFile: this.secretEnvFile,
        };
    }

    readLongTerm() {
        this.ensureScaffold();
        return readFileSafe(this.permanentFile);
    }

    writeLongTerm(content) {
        this.ensureScaffold();
        writeFileSafe(this.permanentFile, content);
    }

    readHistory() {
        this.ensureScaffold();

        const parts = [];
        for (const dateKey of this.getRecentDailyDateKeys()) {
            const filePath = this.getDailyFilePath(dateKey);
            const content = readFileSafe(filePath);
            if (!isDefaultTemplate('daily', content, { dateKey })) {
                parts.push(`<!-- ${filePath} -->\n${normalizeText(content).trim()}`);
            }
        }

        return parts.join('\n\n');
    }

    clearAll() {
        try {
            if (fs.existsSync(this.dailyDir)) {
                fs.rmSync(this.dailyDir, { recursive: true, force: true });
            }
        } catch {
            // ignore
        }

        writeFileSafe(this.permanentFile, FILE_TEMPLATES.permanent);
        writeFileSafe(this.userFile, FILE_TEMPLATES.user);
        writeFileSafe(this.identityFile, FILE_TEMPLATES.identity);
        writeFileSafe(this.soulFile, FILE_TEMPLATES.soul);
        writeFileSafe(this.integrationsFile, FILE_TEMPLATES.integrations);
        for (const spec of AGENT_MEMORY_SPECS) {
            writeFileSafe(this.getAgentMemoryFilePath(spec.agentId), buildAgentTemplate(spec));
        }

        ensureDir(this.dailyDir);
        for (const dateKey of this.getRecentDailyDateKeys()) {
            writeFileSafe(this.getDailyFilePath(dateKey), buildDailyTemplate(dateKey));
        }
    }

    buildFileManifestBlock({ includeAgentFiles = true } = {}) {
        const paths = this.getPaths();
        const lines = [
            '<memory_files>',
            `  <file kind="permanent" path="${escapeAttribute(paths.permanentFile)}">Durable facts worth remembering across many chats.</file>`,
            `  <file kind="user" path="${escapeAttribute(paths.userFile)}">User facts, preferences, contact info, and stable personal context that the user explicitly shared.</file>`,
            `  <file kind="identity" path="${escapeAttribute(paths.identityFile)}">Assistant self-authored identity notes: role, mission, self-name, and stable self-concept. Never invent fiction.</file>`,
            `  <file kind="soul" path="${escapeAttribute(paths.soulFile)}">Assistant self-authored behavioral philosophy and enduring style preferences. Never override higher-priority instructions.</file>`,
            `  <file kind="integrations" path="${escapeAttribute(paths.integrationsFile)}">Non-sensitive integration metadata, endpoints, account names, and env var references.</file>`,
        ];

        if (includeAgentFiles) {
            for (const item of paths.agentFiles) {
                lines.push(`  <file kind="agent" agent="${escapeAttribute(item.agentId)}" path="${escapeAttribute(item.path)}">${escapeAttribute(item.description)}</file>`);
            }
        }

        for (const item of paths.dailyFiles) {
            lines.push(`  <file kind="daily" date="${item.date}" path="${escapeAttribute(item.path)}">Short running log of what the user and assistant worked on that day.</file>`);
        }

        lines.push(`  <secret_store path="${escapeAttribute(paths.secretEnvFile)}">Sensitive values only. This file is loaded into process.env automatically and is NOT injected into prompts.</secret_store>`);
        lines.push('</memory_files>');

        return lines.join('\n');
    }

    buildStateBlock({ includeAgentMemory = true } = {}) {
        const sections = [];

        const permanent = readFileSafe(this.permanentFile);
        if (!isDefaultTemplate('permanent', permanent)) {
            sections.push(`<permanent_memory path="${escapeAttribute(this.permanentFile)}">\n${normalizeText(permanent).trim()}\n</permanent_memory>`);
        }

        const user = readFileSafe(this.userFile);
        if (!isDefaultTemplate('user', user)) {
            sections.push(`<user_memory path="${escapeAttribute(this.userFile)}">\n${normalizeText(user).trim()}\n</user_memory>`);
        }

        const identity = readFileSafe(this.identityFile);
        if (!isDefaultTemplate('identity', identity)) {
            sections.push(`<identity_memory path="${escapeAttribute(this.identityFile)}">\n${normalizeText(identity).trim()}\n</identity_memory>`);
        }

        const soul = readFileSafe(this.soulFile);
        if (!isDefaultTemplate('soul', soul)) {
            sections.push(`<soul_memory path="${escapeAttribute(this.soulFile)}">\n${normalizeText(soul).trim()}\n</soul_memory>`);
        }

        const integrations = readFileSafe(this.integrationsFile);
        if (!isDefaultTemplate('integrations', integrations)) {
            sections.push(`<integrations_memory path="${escapeAttribute(this.integrationsFile)}">\n${normalizeText(integrations).trim()}\n</integrations_memory>`);
        }

        if (includeAgentMemory) {
            for (const agentFile of this.getAgentMemoryFiles()) {
                const content = readFileSafe(agentFile.path);
                if (normalizeComparable(content) === normalizeComparable(buildAgentTemplate(agentFile))) {
                    continue;
                }

                sections.push(`<agent_memory agent="${escapeAttribute(agentFile.agentId)}" path="${escapeAttribute(agentFile.path)}">\n${normalizeText(content).trim()}\n</agent_memory>`);
            }
        }

        const dailySections = [];
        for (const dateKey of this.getRecentDailyDateKeys()) {
            const filePath = this.getDailyFilePath(dateKey);
            const content = readFileSafe(filePath);
            if (!isDefaultTemplate('daily', content, { dateKey })) {
                dailySections.push(`<daily_memory date="${dateKey}" path="${escapeAttribute(filePath)}">\n${normalizeText(content).trim()}\n</daily_memory>`);
            }
        }

        if (dailySections.length > 0) {
            sections.push(`<recent_daily_memory>\n${dailySections.join('\n\n')}\n</recent_daily_memory>`);
        }

        return sections.length > 0 ? sections.join('\n\n') : '';
    }

    getMemoryContext() {
        this.ensureScaffold();

        const parts = [this.buildFileManifestBlock()];
        const stateBlock = this.buildStateBlock();
        if (stateBlock) {
            parts.push(`<memory_state>\n${stateBlock}\n</memory_state>`);
        }

        return `\n\n${parts.join('\n\n')}`;
    }

    getOrchestratorMemoryContext() {
        this.ensureScaffold();

        const parts = [this.buildFileManifestBlock({ includeAgentFiles: true })];
        const stateBlock = this.buildStateBlock({ includeAgentMemory: false });
        if (stateBlock) {
            parts.push(`<memory_state>\n${stateBlock}\n</memory_state>`);
        }

        return `\n\n${parts.join('\n\n')}`;
    }

    getAgentMemoryContext(agentId) {
        this.ensureScaffold();

        const spec = this.getAgentSpec(agentId);
        if (!spec) {
            return '';
        }

        const agentPath = this.getAgentMemoryFilePath(spec.agentId);
        const manifestBlock = [
            '<agent_memory_files>',
            `  <file agent="${escapeAttribute(spec.agentId)}" path="${escapeAttribute(agentPath)}">${escapeAttribute(spec.description)}</file>`,
            '</agent_memory_files>',
        ].join('\n');

        const content = readFileSafe(agentPath);
        const hasState = normalizeComparable(content) !== normalizeComparable(buildAgentTemplate(spec));
        const parts = [manifestBlock];

        if (hasState) {
            parts.push(`<agent_memory_state>\n<agent_memory agent="${escapeAttribute(spec.agentId)}" path="${escapeAttribute(agentPath)}">\n${normalizeText(content).trim()}\n</agent_memory>\n</agent_memory_state>`);
        }

        return `\n\n${parts.join('\n\n')}`;
    }

    getSnapshot() {
        this.ensureScaffold();

        const dailyFiles = this.getRecentDailyDateKeys().map((dateKey) => {
            const filePath = this.getDailyFilePath(dateKey);
            return {
                date: dateKey,
                path: filePath,
                content: readFileSafe(filePath),
            };
        });

        return {
            rootDir: this.memoryDir,
            files: {
                permanent: {
                    path: this.permanentFile,
                    content: readFileSafe(this.permanentFile),
                },
                user: {
                    path: this.userFile,
                    content: readFileSafe(this.userFile),
                },
                identity: {
                    path: this.identityFile,
                    content: readFileSafe(this.identityFile),
                },
                soul: {
                    path: this.soulFile,
                    content: readFileSafe(this.soulFile),
                },
                integrations: {
                    path: this.integrationsFile,
                    content: readFileSafe(this.integrationsFile),
                },
                agents: this.getAgentMemoryFiles().map((agentFile) => ({
                    agentId: agentFile.agentId,
                    label: agentFile.label,
                    description: agentFile.description,
                    path: agentFile.path,
                    content: readFileSafe(agentFile.path),
                })),
                daily: dailyFiles,
                secretEnv: {
                    path: this.secretEnvFile,
                    autoLoaded: true,
                },
            },
        };
    }
}

export const memoryStore = new MemoryStore();
