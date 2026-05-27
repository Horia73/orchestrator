import fs from 'fs'
import path from 'path'

import {
    AGENT_NEEDS_DEFAULT_CONTENT,
    AGENT_NEEDS_RELATIVE_PATH,
} from '../lib/agent-needs'
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
            'Global agent instructions for this workspace.',
            '',
            '## Operating Notes',
            '',
            '## Project Rules',
            '',
            '## Things To Avoid',
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
        path: AGENT_NEEDS_RELATIVE_PATH,
        resetByDefault: true,
        content: AGENT_NEEDS_DEFAULT_CONTENT,
    },
    {
        path: 'MONITORS.md',
        resetByDefault: true,
        content: [
            '# MONITORS',
            '',
            'Document proactive monitoring preferences, candidate monitor specs, recurring check prompts, and active Smart Monitor watch ids here.',
            '',
            'A Smart Monitor entry is active only when it has a runtime watchId. Notes in this file are not automation by themselves. The only scheduledTaskId expected here is the single consolidated Smart Monitor heartbeat when useful for audit.',
            '',
            'Each entry should define status, watchId when active, what to check, cadence/check timing, sources/connectors or custom scope, check prompt, notify threshold, whether the user wants important-only Inbox messages or timed summaries, and when to stay silent.',
            '',
        ].join('\n'),
    },
    {
        path: 'ONBOARDING.md',
        resetByDefault: true,
        content: [
            '# ONBOARDING',
            '',
            'Status: active',
            'Last stage: not_started',
            'Next stage: identity_and_style',
            '',
            'Use this file to resume onboarding across conversations. Keep it compact: completed stages, pending stages, temporary answers not yet consolidated, and missing information to ask later.',
            '',
            '## Completed',
            '',
            '## Pending',
            '- identity_and_style',
            '- work_and_daily_context',
            '- communication_and_urgency',
            '- proactive_monitoring',
            '- boundaries_and_confirmations',
            '- browser_profile',
            '- integrations',
            '',
            '## Missing Later',
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
            'When this file exists, the orchestrator should prioritize learning enough about the user to become useful as a personal operator. Onboarding can be long and can span multiple conversations. Use ONBOARDING.md to remember progress, resume from the next unfinished stage, and keep moving stage by stage until onboarding is complete or the user explicitly skips/stops it. Run onboarding as a short staged conversation instead of one monolithic questionnaire: ask a small logical group of high-leverage questions, wait for the user reply, record progress, then continue with the next group. Keep the tone conversational, friendly, and helpful. Do not ask for secrets, passwords, recovery codes, payment details, government identifiers, or unnecessary sensitive data.',
            '',
            'Onboarding flow:',
            '1. Start with a brief welcome and explain that setup will be split into a few small parts so it stays easy to answer.',
            '2. Ask 2-4 focused questions per turn, grouped by topic. Let the user skip anything.',
            '3. Move through the stages naturally based on the answers; do not dump every question at once.',
            '4. After finishing one stage, update ONBOARDING.md and proceed to the next unfinished stage unless the user is clearly switching tasks.',
            '5. If the user starts a different conversation or task while onboarding is active, handle that task first, then resume onboarding from ONBOARDING.md when it is natural and low-friction.',
            '6. Keep temporary onboarding progress in ONBOARDING.md or daily memory if needed, but wait to update config.json, USER.md, and MEMORY.md until the user has answered enough or chooses to stop.',
            '7. If the user says skip/stop/not now for onboarding, force-finish onboarding: consolidate known durable facts, record missing non-blocking fields in ONBOARDING.md or MEMORY.md as "ask opportunistically later", set ONBOARDING.md Status to skipped, and remove BOOT.md.',
            '8. Ask follow-up questions only for genuine blockers or contradictions.',
            '',
            'Suggested stages:',
            '1. Identity and assistant style: preferred user name, language, assistant name, and how the assistant should sound or behave (for example professional, concise, warm, direct, proactive, low-interruption, or more explanatory).',
            '2. Work and daily context: location/timezone, frequent cities, work context, projects, tools, repositories, and preferred ways to collaborate.',
            '3. Communication and operating preferences: channels the user cares about, what counts as urgent, calendar/reminder preferences, quiet hours, shopping, food, transport, delivery, booking, and travel defaults.',
            '4. Proactive monitoring: explain silent-until-noteworthy monitors in plain language. Recommended default: check about every 15 minutes, adaptively slow down when quiet, speed back up when activity returns, and notify only when important. Ask whether the user prefers important-only Inbox items, summaries at specific times, or both. Ask what "important" means for Gmail/Google Calendar/WhatsApp/Home Assistant.',
            '5. Boundaries and confirmation preferences: ask which classes of reversible action (logged-in dashboard navigation, runtime credential storage, free signup flows, existing-session reuse) the user always wants asked about before you act, and any service-specific exceptions. The hard confirmation boundary (payments, subscriptions, sends, final orders/bookings, account/security changes, legal acceptance, destructive actions, sensitive personal-document uploads) is always asked regardless. Record durable preferences as plain notes in USER.md/MEMORY.md.',
            '6. Browser profile setup: ask whether the user wants to configure the browser agent now. If yes, use browser_agent to open the managed browser profile and yield control so the user can sign in to Chrome/Google or key web services themselves. Ask which accounts/sites may be reused later, whether free setup/login/API-key flows may use existing sessions automatically, and which situations should always ask first. Do not ask for or store passwords, recovery codes, or 2FA codes.',
            '7. Integrations and optional setup: present the available integrations from the live <integrations> block in plain language, mention their current connection state when known, and ask which ones the user wants to set up now versus later. Be especially proactive about Gmail, Google Calendar, WhatsApp, and read-only Home Assistant monitoring because they unlock high-value personal-operator workflows. Also ask whether the user wants help setting up optional free external API keys that improve the app, starting with Watchlist financial data via `TWELVE_DATA_API_KEY` for Twelve Data.',
            '',
            'Discover:',
            '- preferred user name and language;',
            '- what name the user wants to give the assistant;',
            '- preferred assistant style/personality, including tone, verbosity, proactivity, and how much explanation the user wants by default;',
            '- location, timezone, frequent cities, and travel defaults;',
            '- work context, projects, tools, repositories, and preferred ways to collaborate;',
            '- communication channels the user cares about and what counts as urgent;',
            '- proactive monitoring preference: default 15-minute adaptive checks versus fixed cadence, important-only Inbox notifications versus timed summaries, and quiet hours;',
            '- Gmail monitoring rules: urgent/VIP/action-needed criteria, digest timing, and whether the user wants a first-week spam/offers cleanup review for main-inbox emails with quick archive/keep choices before any archiving automation;',
            '- Google Calendar monitoring rules: events/invites that matter, onboarding/deadline/interview keywords, RSVP-needed invites, attendee/location criteria, starts-soon windows, digest timing, and quiet hours;',
            '- WhatsApp monitoring rules: contacts/chats that matter, urgency criteria, quiet hours, and whether to notify immediately or summarize;',
            '- Home Assistant monitoring rules: read-only sensors/devices/problems worth watching, alert thresholds, and actions that always need explicit confirmation;',
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
            '2. Update USER.md with stable facts and preferences, including assistant style/setup facts learned during onboarding (assistant name, style, operating boundaries).',
            '3. Update MEMORY.md with durable operating conclusions.',
            '4. Update ONBOARDING.md with Status complete or skipped and any missing fields that should be asked opportunistically later.',
            '5. Store confirmation preferences, browser-agent profile preferences, and service-specific exceptions as non-secret memory only; never store passwords, 2FA, recovery codes, cookies, or API key values in markdown.',
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

remove('HEARTBEAT.md')
remove('MEMORY_DAY')
write(path.join('MEMORY_DAY', `${today}.md`), [
    `# MEMORY_DAY ${today}`,
    '',
    `Daily working memory for ${today} (UTC).`,
    '',
    'Append compact entries for meaningful actions, decisions, open loops, promises, blockers, and follow-ups. This file is noisy by design and may be consolidated opportunistically by a model-owned Smart Monitor maintenance watch after local midnight when that preference is recorded.',
    '',
].join('\n'))

console.log(`Reset agent files in ${root}`)
console.log('Preserved: .env.local, config.json, model files, artifacts, uploads')
if (!resetAgents) console.log('Preserved: AGENTS.md (use -- --all to reset it too)')
if (!resetAgents) console.log('Preserved: integration runbooks (use -- --all to reset them too)')
