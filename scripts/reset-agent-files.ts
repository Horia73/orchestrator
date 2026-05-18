import fs from 'fs'
import path from 'path'

import {
    INTEGRATION_INDEX_DEFAULT_CONTENT,
    INTEGRATION_INDEX_PATH,
    INTEGRATION_RUNBOOKS,
} from '../lib/integrations/runbooks'

const root = path.join(process.cwd(), '.orchestrator', 'workspace')
const dryRun = process.argv.includes('--dry-run')
const resetAgents = process.argv.includes('--all')

const today = new Date().toISOString().slice(0, 10)

const files: Array<{ path: string; content: string; resetByDefault: boolean }> = [
    {
        path: 'AGENTS.md',
        resetByDefault: false,
        content: [
            '# AGENTS',
            '',
            'Use this file for global instructions that should be visible to every agent.',
            '',
        ].join('\n'),
    },
    {
        path: 'USER.md',
        resetByDefault: true,
        content: [
            '# USER',
            '',
            'Stable user knowledge goes here.',
            '',
            'Keep only information that should help future requests. Prefer durable preferences, recurring constraints, trusted defaults, important places, important people, account/service preferences, health or legal constraints the user explicitly wants remembered, and communication style.',
            '',
        ].join('\n'),
    },
    {
        path: 'IDENTITY.md',
        resetByDefault: true,
        content: [
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
        path: 'MEMORY.md',
        resetByDefault: true,
        content: [
            '# MEMORY',
            '',
            'Permanent memory belongs here.',
            '',
            'Keep this file compact. Store durable facts, recurring preferences, standing instructions, long-running goals, and decisions that should affect future behavior. Do not store one-off chatter, temporary state, unverified assumptions, or sensitive data unless the user explicitly wants it remembered.',
            '',
        ].join('\n'),
    },
    {
        path: 'HEARTBEAT.md',
        resetByDefault: true,
        content: [
            '# HEARTBEAT',
            '',
            'Recurring assistant duties go here.',
            '',
            'Use this file for monitors, scheduled checks, urgency rules, daily briefs, price watches, inbox or message triage policies, and proactive follow-up criteria. Each entry should define what to check, cadence, sources/connectors, urgency threshold, what to report, and when to stay silent.',
            '',
        ].join('\n'),
    },
    {
        path: 'BOOT.md',
        resetByDefault: true,
        content: [
            '# BOOT',
            '',
            'Purpose: run initial user onboarding.',
            '',
            'When this file exists, the orchestrator should prioritize learning enough about the user to become useful as a personal operator. Ask one consolidated batch of concise, high-leverage onboarding questions instead of asking one by one. Do not ask for secrets, passwords, recovery codes, payment details, government identifiers, or unnecessary sensitive data.',
            '',
            'Onboarding flow:',
            '1. Ask the full onboarding batch once, grouped by topic.',
            '2. Wait for the user reply.',
            '3. Update config.json, USER.md, MEMORY.md, and IDENTITY.md once from the consolidated answer.',
            '4. Ask follow-up questions only for genuine blockers or contradictions.',
            '',
            'Discover:',
            '- preferred user name and language;',
            '- what name the user wants to give the assistant;',
            '- location, timezone, frequent cities, and travel defaults;',
            '- work context, projects, tools, repositories, and preferred ways to collaborate;',
            '- communication channels the user cares about and what counts as urgent;',
            '- shopping, food, transport, delivery, and booking preferences;',
            '- calendar/reminder preferences and quiet hours;',
            '- privacy boundaries and what the assistant must never do without explicit confirmation;',
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
        path: INTEGRATION_INDEX_PATH,
        resetByDefault: false,
        content: INTEGRATION_INDEX_DEFAULT_CONTENT,
    },
    ...INTEGRATION_RUNBOOKS.map(runbook => ({
        path: runbook.relativePath,
        resetByDefault: false,
        content: runbook.defaultContent,
    })),
]

function write(relPath: string, content: string) {
    const target = path.join(root, relPath)
    if (dryRun) {
        console.log(`would write ${relPath}`)
        return
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf-8')
}

function remove(relPath: string) {
    const target = path.join(root, relPath)
    if (dryRun) {
        console.log(`would remove ${relPath}`)
        return
    }
    fs.rmSync(target, { recursive: true, force: true })
}

fs.mkdirSync(root, { recursive: true })

for (const file of files) {
    if (!file.resetByDefault && !resetAgents) continue
    write(file.path, file.content)
}

remove('MEMORY_DAY')
write(path.join('MEMORY_DAY', `${today}.md`), [
    `# MEMORY_DAY ${today}`,
    '',
    `Daily working memory for ${today} (UTC).`,
    '',
    'Append compact entries for meaningful actions, decisions, open loops, promises, blockers, and follow-ups. This file is noisy by design and is consolidated into MEMORY.md periodically.',
    '',
].join('\n'))

console.log(`Reset agent files in ${root}`)
console.log('Preserved: .env.local, config.json, model files, artifacts, uploads')
if (!resetAgents) console.log('Preserved: AGENTS.md (use -- --all to reset it too)')
if (!resetAgents) console.log('Preserved: integration runbooks (use -- --all to reset them too)')
