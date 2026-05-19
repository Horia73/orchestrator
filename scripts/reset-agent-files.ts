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
            '5. Browser profile setup: ask whether the user wants to configure the browser agent now. If yes, use browser_agent to open the managed browser profile and yield control so the user can sign in to Chrome/Google or key web services themselves. Ask which accounts/sites may be reused later, whether free setup/login/API-key flows may use existing sessions automatically, and which situations should always ask first. Do not ask for or store passwords, recovery codes, or 2FA codes.',
            '6. Integrations and optional setup: present the available integrations from the live <integrations> block in plain language, mention their current connection state when known, and ask which ones the user wants to set up now versus later. Also ask whether the user wants help setting up optional free external API keys that improve the app, starting with Watchlist financial data via `TWELVE_DATA_API_KEY` for Twelve Data.',
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
            '- browser agent setup preference: whether to open the managed browser during onboarding for manual login, which accounts/sites may be reused, and whether future free setup/login/API-key flows can proceed automatically until the consent boundary;',
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
            '5. Store browser-agent autonomy/profile preferences as non-secret memory only; never store passwords, 2FA, recovery codes, cookies, or API key values in markdown.',
            '6. Remove BOOT.md so onboarding does not run again.',
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
