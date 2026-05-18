import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'

import { AGENT_WORKSPACE_DIR } from '@/lib/config'
import {
    INTEGRATION_INDEX_DEFAULT_CONTENT,
    INTEGRATION_INDEX_PATH,
    INTEGRATION_RUNBOOKS,
} from '@/lib/integrations/runbooks'
import {
    LiveRegistrySchema,
    ThinkingLevelSchema,
} from '@/lib/models/schema'
import { getEffectiveRegistry, invalidateRegistryCache } from '@/lib/models/registry'

type WorkspaceFileKind = 'json' | 'env' | 'markdown'
type WorkspaceFileSource = 'physical' | 'virtual'

/**
 * Semantic grouping used by the Settings file editor. Agents still see every
 * definition by path (see buildRuntimeContext); the category only drives how
 * the human-facing editor groups and labels files.
 */
export type WorkspaceFileCategory = 'knowledge' | 'behavior' | 'integrations' | 'onboarding' | 'system' | 'models'

/**
 * `editor` files are shown in the Settings file editor. `reference` files stay
 * in the data model (agents and the prompt builder still rely on them) but are
 * intentionally not editable in the UI because a dedicated surface owns them
 * (the Models tab owns config + the model registry).
 */
export type WorkspaceFileSurface = 'editor' | 'reference'

export interface WorkspaceFileDefinition {
    id: string
    label: string
    relativePath: string
    kind: WorkspaceFileKind
    category: WorkspaceFileCategory
    surface: WorkspaceFileSurface
    description: string
    readOnly?: boolean
    source?: WorkspaceFileSource
    /** When 'daily', this id is a directory; reads/writes resolve to today's UTC file (MEMORY_DAY/<YYYY-MM-DD>.md). */
    dynamic?: 'daily'
    defaultContent?: string
}

export interface WorkspaceFileSummary extends WorkspaceFileDefinition {
    exists: boolean
    size: number | null
    updatedAt: number | null
}

export interface WorkspaceFilePayload extends WorkspaceFileSummary {
    content: string
}

const MAX_FILE_BYTES = 512 * 1024

const AppConfigFileSchema = z.object({
    assistantName: z.string(),
    userName: z.string(),
    activeProvider: z.string().min(1),
    activeModel: z.string().min(1),
    thinkingLevel: ThinkingLevelSchema,
    agentOverrides: z.record(z.string(), z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
        thinkingLevel: ThinkingLevelSchema.optional(),
        modelOptions: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).optional(),
    })),
    browserAgent: z.object({
        light: z.object({
            provider: z.string().min(1),
            model: z.string().min(1),
            thinkingLevel: ThinkingLevelSchema,
            modelOptions: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).optional(),
        }),
        pro: z.object({
            provider: z.string().min(1),
            model: z.string().min(1),
            thinkingLevel: ThinkingLevelSchema,
            modelOptions: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).optional(),
        }),
    }).optional(),
    favorites: z.array(z.string()),
    updatedAt: z.number(),
}).passthrough()

export const WORKSPACE_FILE_DEFINITIONS: WorkspaceFileDefinition[] = [
    {
        id: 'agents',
        label: 'Agents',
        relativePath: 'AGENTS.md',
        kind: 'markdown',
        category: 'behavior',
        surface: 'editor',
        description: 'Project notes intended for agents.',
        defaultContent: [
            '# AGENTS',
            '',
            'Use this file for global instructions that should be visible to every agent.',
            '',
        ].join('\n'),
    },
    {
        id: 'user',
        label: 'User',
        relativePath: 'USER.md',
        kind: 'markdown',
        category: 'knowledge',
        surface: 'editor',
        description: 'Stable facts, preferences, constraints, accounts, places, and personal operating context for the user.',
        defaultContent: [
            '# USER',
            '',
            'Stable user knowledge goes here.',
            '',
            'Keep only information that should help future requests. Prefer durable preferences, recurring constraints, trusted defaults, important places, important people, account/service preferences, health or legal constraints the user explicitly wants remembered, and communication style.',
            '',
        ].join('\n'),
    },
    {
        id: 'identity',
        label: 'Identity',
        relativePath: 'IDENTITY.md',
        kind: 'markdown',
        category: 'knowledge',
        surface: 'editor',
        description: 'Assistant identity, self-knowledge, operating boundaries, and discoveries from onboarding.',
        defaultContent: [
            '# IDENTITY',
            '',
            'Assistant identity and self-knowledge go here.',
            '',
            'Store stable information about what this assistant is, how it should present itself, which capabilities are available, where its boundaries are, and what it learns about its own setup during onboarding or normal operation.',
            '',
            'Do not store user secrets here. User facts belong in USER.md. Durable operating memory belongs in MEMORY.md.',
            '',
        ].join('\n'),
    },
    {
        id: 'boot',
        label: 'Boot onboarding',
        relativePath: 'BOOT.md',
        kind: 'markdown',
        category: 'onboarding',
        surface: 'editor',
        description: 'Temporary onboarding script. When completed, the agent should consolidate what it learned and remove this file.',
        defaultContent: [
            '# BOOT',
            '',
            'Purpose: run initial user onboarding.',
            '',
            'When this file exists, the orchestrator should prioritize learning enough about the user to become useful as a personal operator. Run onboarding as a short staged conversation instead of one monolithic questionnaire: ask a small logical group of high-leverage questions, wait for the user reply, then continue with the next group. Keep the tone conversational, friendly, and helpful. Do not ask for secrets, passwords, recovery codes, payment details, government identifiers, or unnecessary sensitive data.',
            '',
            'Onboarding flow:',
            '1. Start with a brief welcome and explain that setup will be split into a few small parts so it stays easy to answer.',
            '2. Ask 2-4 focused questions per turn, grouped by topic. Let the user skip anything.',
            '3. Move through the stages naturally based on the answers; do not dump every question at once.',
            '4. Keep temporary onboarding progress in the conversation or daily memory if needed, but wait to update config.json, USER.md, MEMORY.md, and IDENTITY.md until the user has answered enough or chooses to stop.',
            '5. Ask follow-up questions only for genuine blockers or contradictions.',
            '',
            'Suggested stages:',
            '1. Identity and assistant style: preferred user name, language, assistant name, and how the assistant should sound or behave (for example professional, concise, warm, direct, proactive, low-interruption, or more explanatory).',
            '2. Work and daily context: location/timezone, frequent cities, work context, projects, tools, repositories, and preferred ways to collaborate.',
            '3. Communication and operating preferences: channels the user cares about, what counts as urgent, calendar/reminder preferences, quiet hours, shopping, food, transport, delivery, booking, and travel defaults.',
            '4. Boundaries and autonomy: privacy boundaries, actions that always require explicit confirmation, and whether browser automation is allowed for free signup/login/setup flows while still stopping before payments, subscriptions, paid trials, permission grants, legal-term acceptance, or submitting personal data unless the exact action is confirmed.',
            '5. Integrations and optional setup: present the available integrations from the live <integrations> block in plain language, mention their current connection state when known, and ask which ones the user wants to set up now versus later. Also ask whether the user wants help setting up optional free external API keys that improve the app, starting with Watchlist financial data via `TWELVE_DATA_API_KEY` for Twelve Data.',
            '',
            'Discover:',
            '- preferred user name and language;',
            '- what name the user wants to give the assistant;',
            '- preferred assistant style/personality, including tone, verbosity, proactivity, and how much explanation the user wants by default;',
            '- location, timezone, frequent cities, and travel defaults;',
            '- work context, projects, tools, repositories, and preferred ways to collaborate;',
            '- communication channels the user cares about and what counts as urgent;',
            '- shopping, food, transport, delivery, and booking preferences;',
            '- calendar/reminder preferences and quiet hours;',
            '- privacy boundaries and what the assistant must never do without explicit confirmation;',
            '- which available integrations the user cares about, what they should be used for, and whether the user wants to set any of them up now or later;',
            '- whether the user wants help setting up optional free external API keys that improve the app, starting with Watchlist financial data via `TWELVE_DATA_API_KEY` for Twelve Data;',
            '- whether the user wants the assistant to use browser automation for free signup/login/setup flows by default, while still stopping before payments, subscriptions, paid trials, permission grants, legal-term acceptance, or submitting personal data unless the exact action is confirmed;',
            '- any stable constraints the user explicitly wants remembered.',
            '',
            'After onboarding is complete:',
            '1. Update config.json with userName and assistantName when the user gave them; keep defaults as "User" and "Orchestrator" if not specified.',
            '2. Update USER.md with stable facts and preferences.',
            '3. Update MEMORY.md with durable operating conclusions.',
            '4. Update IDENTITY.md with stable assistant/setup facts learned during onboarding.',
            '5. Remove BOOT.md so onboarding does not run again.',
            '',
        ].join('\n'),
    },
    {
        id: 'memory',
        label: 'Long memory',
        relativePath: 'MEMORY.md',
        kind: 'markdown',
        category: 'knowledge',
        surface: 'editor',
        description: 'Permanent consolidated memory. Updated deliberately with durable, future-useful facts.',
        defaultContent: [
            '# MEMORY',
            '',
            'Permanent memory belongs here.',
            '',
            'Keep this file compact. Store durable facts, recurring preferences, standing instructions, long-running goals, and decisions that should affect future behavior. Do not store one-off chatter, temporary state, unverified assumptions, or sensitive data unless the user explicitly wants it remembered.',
            '',
        ].join('\n'),
    },
    {
        id: 'memory-day',
        label: 'Daily memory',
        // Directory, not a single file: one note per UTC day at
        // MEMORY_DAY/<YYYY-MM-DD>.md. resolveDefinitionPath / summarizeFile /
        // getWorkspaceFile resolve "today"; the editor shows today's note.
        relativePath: 'MEMORY_DAY',
        kind: 'markdown',
        category: 'knowledge',
        surface: 'editor',
        dynamic: 'daily',
        description: "Today's working memory. One file per day under MEMORY_DAY/; agents append actions and open loops to the current day.",
    },
    {
        id: 'integration-index',
        label: 'Integrations',
        relativePath: INTEGRATION_INDEX_PATH,
        kind: 'markdown',
        category: 'integrations',
        surface: 'editor',
        description: 'Index and operating rules for service integration runbooks.',
        defaultContent: INTEGRATION_INDEX_DEFAULT_CONTENT,
    },
    ...INTEGRATION_RUNBOOKS.map((runbook): WorkspaceFileDefinition => ({
        id: `integration-${runbook.id}`,
        label: runbook.label,
        relativePath: runbook.relativePath,
        kind: 'markdown',
        category: 'integrations',
        surface: 'editor',
        description: runbook.description,
        defaultContent: runbook.defaultContent,
    })),
    {
        id: 'app-config',
        label: 'Config',
        relativePath: 'config.json',
        kind: 'json',
        category: 'system',
        surface: 'reference',
        description: 'Global defaults, per-agent model overrides, favorites, and app-level preferences. Edited from the Models tab.',
    },
    {
        id: 'env-local',
        label: 'Env',
        relativePath: '.env.local',
        kind: 'env',
        category: 'system',
        surface: 'editor',
        description: 'Local variables and provider keys.',
        defaultContent: [
            '# AI provider API keys',
            'GEMINI_API_KEY=',
            'OPENAI_API_KEY=',
            'ANTHROPIC_API_KEY=',
            '',
            '# Public/LAN URL that users open in the browser.',
            '# Leave empty for auto-detection from Host/X-Forwarded-* headers.',
            '# Google OAuth redirects use this only when it is localhost or public HTTPS.',
            '# .lan/.local/private IP origins fall back to localhost for SSH tunnels.',
            'ORCHESTRATOR_PUBLIC_URL=',
            '# Optional hints used to show exact SSH tunnel commands.',
            'ORCHESTRATOR_SSH_USER=',
            'ORCHESTRATOR_SSH_HOST=',
            'ORCHESTRATOR_HOST_LAN_IP=',
            '',
            '# Google OAuth for Gmail and Google Workspace in Settings > Auth',
            'GOOGLE_OAUTH_CLIENT_ID=',
            'GOOGLE_OAUTH_CLIENT_SECRET=',
            '# Optional: set exact Google-compatible callbacks when not using localhost:3000.',
            'GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI=',
            'GMAIL_OAUTH_REDIRECT_URI=',
            '',
            '# Home Assistant read-only API integration in Settings > Auth',
            'HOME_ASSISTANT_URL=',
            'HOME_ASSISTANT_TOKEN=',
            '',
            '# Watchlist financial data provider',
            'TWELVE_DATA_API_KEY=',
            '',
            '# Optional private GitHub release lookup for Settings > Updates',
            'ORCHESTRATOR_UPDATE_GITHUB_TOKEN=',
            '',
        ].join('\n'),
    },
    {
        id: 'models-api',
        label: 'API models',
        relativePath: 'api-models.json',
        kind: 'json',
        category: 'models',
        surface: 'reference',
        description: 'Raw model catalog discovered from provider APIs and local CLIs. Managed from the Models tab.',
        defaultContent: JSON.stringify({ version: 1, providers: {} }, null, 2) + '\n',
    },
    {
        id: 'models-current',
        label: 'Current models',
        relativePath: 'current-models.json',
        kind: 'json',
        category: 'models',
        surface: 'reference',
        description: 'Generated view of every non-archived model currently available to the app.',
        readOnly: true,
        source: 'virtual',
    },
    {
        id: 'models-archived',
        label: 'Archived models',
        relativePath: 'archived-models.json',
        kind: 'json',
        category: 'models',
        surface: 'reference',
        description: 'Generated view of every archived model currently hidden from normal model pickers.',
        readOnly: true,
        source: 'virtual',
    },
]

export function listWorkspaceFiles(): WorkspaceFileSummary[] {
    return WORKSPACE_FILE_DEFINITIONS
        .map(def => summarizeFile(def))
        .filter(summary => shouldListFile(summary))
}

const WORKSPACE_INIT_MARKER = '.workspace-initialized'

/**
 * Files the materializer keeps present: editor-surface markdown notes plus the
 * rolling daily memory file. Excludes .env.local (user-owned secrets), the
 * virtual/reference model + config files, and BOOT (first-run only — see below).
 */
function isMaterializable(def: WorkspaceFileDefinition): boolean {
    if (def.id === 'boot') return false
    if (def.source === 'virtual') return false
    if (def.surface === 'reference') return false
    if (def.kind === 'env') return false
    return Boolean(def.defaultContent) || def.dynamic === 'daily'
}

/**
 * Idempotently writes any missing template files so the workspace always works,
 * even after the user deletes one. Called from the settings file API and at the
 * start of every agent prompt build.
 *
 * BOOT.md is special: it is seeded only on the very first initialization (no
 * marker and no standard files yet) and never resurrected, so completed
 * onboarding does not loop when the agent deletes it.
 */
export function ensureWorkspaceTemplates(): void {
    const root = AGENT_WORKSPACE_DIR
    try {
        fs.mkdirSync(/* turbopackIgnore: true */ root, { recursive: true })
    } catch {
        return
    }

    const standard = WORKSPACE_FILE_DEFINITIONS.filter(isMaterializable)
    const markerPath = path.join(root, WORKSPACE_INIT_MARKER)
    const markerExists = fs.existsSync(markerPath)
    const anyStandardExists = standard.some(def => {
        try {
            return fs.existsSync(/* turbopackIgnore: true */ resolveDefinitionPath(def))
        } catch {
            return false
        }
    })
    // A pre-existing workspace with notes but no marker is not a fresh install:
    // do not reseed BOOT for users who already finished onboarding.
    const firstRun = !markerExists && !anyStandardExists

    for (const def of standard) {
        try {
            const target = resolveDefinitionPath(def)
            if (fs.existsSync(/* turbopackIgnore: true */ target)) continue
            const content = def.dynamic === 'daily'
                ? buildDailyMemoryTemplate()
                : (def.defaultContent ?? '')
            if (!content) continue
            writeTextAtomic(target, content)
        } catch {
            // Best effort: a failed template write must not block the request.
        }
    }

    if (firstRun) {
        const boot = getDefinition('boot')
        if (boot?.defaultContent) {
            try {
                const target = resolveDefinitionPath(boot)
                if (!fs.existsSync(/* turbopackIgnore: true */ target)) writeTextAtomic(target, boot.defaultContent)
            } catch {
                // ignore
            }
        }
    }

    if (!markerExists) {
        try {
            writeTextAtomic(markerPath, `initialized ${new Date().toISOString()}\n`)
        } catch {
            // ignore
        }
    }
}

export function resetWorkspaceFilesToInitialState(opts?: { preserveEnvLocal?: boolean }): {
    preservedEnvLocal: boolean
} {
    const preserveEnvLocal = opts?.preserveEnvLocal ?? true
    const envDef = getDefinition('env-local')
    let envContent: string | null = null

    if (preserveEnvLocal && envDef) {
        try {
            const envPath = resolveDefinitionPath(envDef)
            if (fs.existsSync(/* turbopackIgnore: true */ envPath)) {
                envContent = fs.readFileSync(/* turbopackIgnore: true */ envPath, 'utf-8')
            }
        } catch {
            envContent = null
        }
    }

    fs.rmSync(/* turbopackIgnore: true */ AGENT_WORKSPACE_DIR, { recursive: true, force: true })
    fs.mkdirSync(/* turbopackIgnore: true */ AGENT_WORKSPACE_DIR, { recursive: true })

    for (const def of WORKSPACE_FILE_DEFINITIONS) {
        if (def.source === 'virtual' || def.surface !== 'editor') continue
        if (def.kind === 'env') {
            const content = mergeMissingEnvDefaults(envContent ?? def.defaultContent ?? '', def.defaultContent ?? '')
            writeTextAtomic(resolveDefinitionPath(def), content, 0o600)
            continue
        }

        const content = def.dynamic === 'daily'
            ? buildDailyMemoryTemplate()
            : (def.defaultContent ?? '')
        if (!content) continue
        writeTextAtomic(resolveDefinitionPath(def), content)
    }

    try {
        writeTextAtomic(
            path.join(AGENT_WORKSPACE_DIR, WORKSPACE_INIT_MARKER),
            `initialized ${new Date().toISOString()}\n`
        )
    } catch {
        // ignore
    }

    return { preservedEnvLocal: envContent !== null }
}

export function getWorkspaceFile(id: string): WorkspaceFilePayload | null {
    const def = getDefinition(id)
    if (!def) return null

    const summary = summarizeFile(def)
    if (!shouldListFile(summary)) return null
    let content = def.dynamic === 'daily' ? buildDailyMemoryTemplate() : (def.defaultContent ?? '')

    if (def.source === 'virtual') {
        content = buildVirtualFileContent(def.id)
    } else if (summary.exists) {
        const absolutePath = resolveDefinitionPath(def)
        const stat = fs.statSync(/* turbopackIgnore: true */ absolutePath)
        if (stat.size > MAX_FILE_BYTES) {
            throw new Error(`File is too large to edit here (${stat.size} bytes).`)
        }
        content = fs.readFileSync(/* turbopackIgnore: true */ absolutePath, 'utf-8')
        if (def.id === 'env-local') {
            const nextContent = mergeMissingEnvDefaults(content, def.defaultContent ?? '')
            if (nextContent !== content) {
                writeTextAtomic(absolutePath, nextContent, 0o600)
                content = nextContent
            }
        }
    }

    return { ...summary, content }
}

export function writeWorkspaceFile(id: string, content: string): WorkspaceFilePayload | null {
    const def = getDefinition(id)
    if (!def) return null
    if (def.readOnly) throw new Error(`${def.label} is read-only.`)
    if (def.source === 'virtual') throw new Error(`${def.label} is generated and cannot be saved.`)

    validateContent(def, content)
    writeTextAtomic(resolveDefinitionPath(def), content, def.id === 'env-local' ? 0o600 : undefined)

    if (def.id === 'models-api') {
        invalidateRegistryCache()
    }

    return getWorkspaceFile(id)
}

function shouldListFile(summary: WorkspaceFileSummary): boolean {
    // BOOT.md is an active onboarding script, not a reusable template. It
    // should be visible only while the real file exists. Fresh installs seed it
    // in ensureWorkspaceTemplates(); completed onboarding deletes it.
    if (summary.id === 'boot') return summary.exists
    return true
}

function getDefinition(id: string): WorkspaceFileDefinition | undefined {
    return WORKSPACE_FILE_DEFINITIONS.find(def => def.id === id)
}

function summarizeFile(def: WorkspaceFileDefinition): WorkspaceFileSummary {
    if (def.source === 'virtual') {
        const content = buildVirtualFileContent(def.id)
        return {
            ...def,
            exists: true,
            size: Buffer.byteLength(content, 'utf-8'),
            updatedAt: getModelRegistryUpdatedAt(),
        }
    }

    if (def.id === 'models-api') {
        migrateLegacyApiModelsFile()
    }

    const absolutePath = resolveDefinitionPath(def)
    let exists = false
    let size: number | null = null
    let updatedAt: number | null = null

    try {
        const stat = fs.statSync(/* turbopackIgnore: true */ absolutePath)
        exists = stat.isFile()
        if (exists) {
            size = stat.size
            updatedAt = stat.mtimeMs
        }
    } catch {
        // Missing files are valid for user-managed notes/env files.
    }

    return { ...def, relativePath: effectiveRelativePath(def), exists, size, updatedAt }
}

function utcDateStamp(date: Date = new Date()): string {
    // UTC so the path the agent computes from runtime_context `today`
    // (also toISOString-derived) always matches the file the server writes.
    return date.toISOString().slice(0, 10)
}

function dailyMemoryRelativePath(stamp: string = utcDateStamp()): string {
    return `MEMORY_DAY/${stamp}.md`
}

/** Path actually read/written for a definition; daily files resolve to today. */
function effectiveRelativePath(def: WorkspaceFileDefinition): string {
    return def.dynamic === 'daily' ? dailyMemoryRelativePath() : def.relativePath
}

function buildDailyMemoryTemplate(stamp: string = utcDateStamp()): string {
    return [
        `# MEMORY_DAY ${stamp}`,
        '',
        `Daily working memory for ${stamp} (UTC).`,
        '',
        'Append compact entries for meaningful actions, decisions, open loops, promises, blockers, and follow-ups. This file is noisy by design and is consolidated into MEMORY.md periodically.',
        '',
    ].join('\n')
}

function resolveDefinitionPath(def: WorkspaceFileDefinition): string {
    const root = AGENT_WORKSPACE_DIR
    const resolved = path.resolve(/* turbopackIgnore: true */ root, effectiveRelativePath(def))
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`Configured file escapes allowed root: ${def.id}`)
    }
    return resolved
}

function validateContent(def: WorkspaceFileDefinition, content: string): void {
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
        throw new Error(`File is too large to save here. Limit is ${MAX_FILE_BYTES} bytes.`)
    }
    if (content.includes('\0')) {
        throw new Error('File contains a NUL byte.')
    }

    if (def.kind !== 'json') return

    let parsed: unknown
    try {
        parsed = JSON.parse(content)
    } catch (err) {
        throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse failed'}`)
    }

    const result =
        def.id === 'app-config'
            ? AppConfigFileSchema.safeParse(parsed)
            : def.id === 'models-api'
                ? LiveRegistrySchema.safeParse(parsed)
                : z.unknown().safeParse(parsed)

    if (!result.success) {
        throw new Error(result.error.issues.map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; '))
    }
}

function mergeMissingEnvDefaults(content: string, defaultContent: string): string {
    if (!defaultContent) return content
    const existing = new Set(extractEnvKeys(content))
    const missing = extractEnvLines(defaultContent).filter(line => !existing.has(line.key))
    if (missing.length === 0) return content

    const base = content.replace(/\s*$/, '\n')
    return [
        base,
        '# Added by Orchestrator defaults',
        ...missing.map(line => line.raw),
        '',
    ].join('\n')
}

function extractEnvKeys(content: string): string[] {
    return extractEnvLines(content).map(line => line.key)
}

function extractEnvLines(content: string): Array<{ key: string; raw: string }> {
    const lines = content.replace(/\r\n/g, '\n').split('\n')
    const out: Array<{ key: string; raw: string }> = []
    for (const raw of lines) {
        const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
        if (!match?.[1]) continue
        out.push({ key: match[1], raw: raw.trim() })
    }
    return out
}

function buildVirtualFileContent(id: string): string {
    if (id === 'models-current') {
        return buildModelViewContent(false)
    }
    if (id === 'models-archived') {
        return buildModelViewContent(true)
    }
    return JSON.stringify({ generatedAt: new Date().toISOString() }, null, 2) + '\n'
}

function buildModelViewContent(archived: boolean): string {
    const registry = getEffectiveRegistry()
    const providers: Record<string, unknown> = {}

    for (const [providerId, provider] of Object.entries(registry)) {
        const models = Object.fromEntries(
            Object.entries(provider.models)
                .filter(([, model]) => model.archived === archived)
                .sort(([a], [b]) => a.localeCompare(b))
        )

        if (Object.keys(models).length === 0) continue
        providers[providerId] = {
            name: provider.name,
            apiKeyEnv: provider.apiKeyEnv,
            models,
        }
    }

    return JSON.stringify({
        version: 1,
        view: archived ? 'archived' : 'current',
        generatedAt: new Date().toISOString(),
        providers,
    }, null, 2) + '\n'
}

function getModelRegistryUpdatedAt(): number | null {
    const candidates = [
        path.resolve(AGENT_WORKSPACE_DIR, 'api-models.json'),
        path.resolve(AGENT_WORKSPACE_DIR, 'model-overrides.json'),
        path.resolve(AGENT_WORKSPACE_DIR, 'models-live.json'),
        path.resolve(AGENT_WORKSPACE_DIR, 'models-curated.json'),
    ]

    let updatedAt: number | null = null
    for (const candidate of candidates) {
        try {
            const stat = fs.statSync(/* turbopackIgnore: true */ candidate)
            if (!stat.isFile()) continue
            updatedAt = Math.max(updatedAt ?? 0, stat.mtimeMs)
        } catch {
            // Missing registry files are fine; the generated view can still be empty.
        }
    }
    return updatedAt
}

function migrateLegacyApiModelsFile(): void {
    const targetPath = path.resolve(AGENT_WORKSPACE_DIR, 'api-models.json')
    const legacyPath = path.resolve(AGENT_WORKSPACE_DIR, 'models-live.json')
    if (
        fs.existsSync(/* turbopackIgnore: true */ targetPath) ||
        !fs.existsSync(/* turbopackIgnore: true */ legacyPath)
    ) return
    try {
        fs.copyFileSync(/* turbopackIgnore: true */ legacyPath, targetPath)
    } catch {
        // The model store performs the same migration when the registry is read.
    }
}

function writeTextAtomic(targetPath: string, content: string, mode?: number): void {
    fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(targetPath), { recursive: true })
    const tmpPath = path.join(/* turbopackIgnore: true */ path.dirname(targetPath), `.tmp-${path.basename(targetPath)}-${randomUUID()}`)
    fs.writeFileSync(/* turbopackIgnore: true */ tmpPath, content, { encoding: 'utf-8', mode })
    fs.renameSync(/* turbopackIgnore: true */ tmpPath, targetPath)
    if (mode !== undefined) {
        try {
            fs.chmodSync(/* turbopackIgnore: true */ targetPath, mode)
        } catch {
            // Best effort; the content is already saved.
        }
    }
}
