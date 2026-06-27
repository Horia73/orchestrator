import type { PromptContext } from '@/lib/ai/agents/types'
import { MAX_AGENT_DEPTH } from '@/lib/ai/agents/types'
import { isOrchestratorClassAgent } from '@/lib/ai/agents/orchestrator-class'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getConfig, getEnvValue } from '@/lib/config'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import { WORKSPACE_FILE_DEFINITIONS, ensureWorkspaceTemplates, readScaffoldHashes, isUntouchedScaffold } from '@/lib/settings/workspace-files'
import { buildIntegrationRunbooksContext } from '@/lib/integrations/runbooks'
import {
    buildActiveCapabilityDoctrinesBlock,
    buildIntegrationsContextBlock,
    buildSubsystemsContextBlock,
} from '@/lib/integrations/exposure'
import { getAgentThread, listAgentThreadsForContext, type AgentThread } from '@/lib/db'
import { buildRuntimeAccessContext } from '@/lib/runtime-access'
import { BROWSER_AGENT_CAPABILITY_HINT } from '@/lib/ai/agents/browser-agent-capabilities'
import { dateStampInTimezone, formatDateTimeInTimezone, systemTimezone } from '@/lib/timezone'

/** First sentence of a tool description, normalized and length-capped — used
 *  for the compact gated-capability tool menus in <integrations>/<subsystems>. */
function firstSentence(text: string, max = 100): string {
    const clean = text.replace(/\s+/g, ' ').trim()
    const dot = clean.indexOf('. ')
    const base = dot > 0 ? clean.slice(0, dot) : clean
    return base.length > max ? `${base.slice(0, max - 1).trimEnd()}…` : base
}

// ---------------------------------------------------------------------------
// Artifact authoring guidance.
//
// Provider-neutral: instructs the model to emit artifact blocks for
// substantial standalone content. Kept as a shared helper so any text agent
// (orchestrator, researcher, future writer) can opt in identically.
// ---------------------------------------------------------------------------

const ARTIFACT_AUTHORING = `
<artifact_authoring>
When you produce substantial standalone content the user will read, save, or run separately from the chat — think recipes, explanations with diagrams, code files, runnable apps, charts — wrap it in an artifact tag. Inline chat prose stays in chat; the tag is for content that benefits from its own surface.

<authorship>
The artifact is YOURS to author and emit — never a sub-agent's. When a deliverable should render as an artifact (recipe, workout, chart, diagram, SVG, code file, HTML/React surface, markdown card), you compose and emit the \`<artifact>\` block yourself in the main assistant stream. Delegate the *inputs* when it helps — research, the data behind a chart, a rough draft, a numbers pass — but assemble the artifact from what comes back; do not ask a sub-agent to "make the artifact" and then relay it. Sub-agents cannot emit \`<artifact>\` tags at all: they return raw content, real files, or an \`artifact_candidate\` payload, and you turn that into the rendered artifact. (Saved Office/disk files — \`.docx\` / \`.pptx\` / \`.xlsx\` and similar produced via a skill — are ordinary files, not \`<artifact>\` cards; those you may still hand to worker, then surface with a download link per <output_contract>.)
</authorship>

<tag_name>
Use \`<artifact ...>\` with closing \`</artifact>\`. Case-insensitive but lowercase is canonical.
</tag_name>

<format>
\`<artifact identifier="..." type="..." title="..." display="..." [language="..."]>\`
content goes here, raw — no markdown code fences around it
\`</artifact>\`

Required attributes:
- \`identifier\`: stable kebab-case handle. Reuse the same identifier across turns to update the artifact (creates a new version). Pick a fresh identifier only when starting genuinely different content.
- \`type\`: MIME of the content. Use one of:
  - \`text/markdown\` — formatted prose (guides, explanations, simple notes). Use this when the content is just text. For RECIPES, prefer \`application/vnd.ant.recipe\` instead (richer card with scalable ingredients and live timers).
  - \`application/vnd.ant.recipe\` — a structured recipe rendered as a card with header, ingredient list (with live servings stepper + scaling), numbered steps with optional live timer chips, and notes. Body MUST be JSON — call ActivateIntegrationTools("recipe") to load the exact schema before emitting.
  - \`application/vnd.ant.workout\` — a structured gym/fitness workout rendered as an interactive card with header, equipment chips, per-exercise cards (with last-session + PB context, set rows with planned weight × reps + checkable status, rest timer affordances). Body MUST be JSON — call ActivateIntegrationTools("workout") to load the exact schema before emitting. Use this for any strength, bodyweight, cardio, HIIT, mobility, or program-day workout the user asks for.
  - \`application/vnd.ant.cad\` — an interactive 3D model viewer (orbit/zoom/pan) for CAD parts and assemblies, backed by a GLB file generated in the workspace, with download chips for STEP/STL/3MF. Body MUST be JSON — call ActivateIntegrationTools("cad") to load the exact schema + generation workflow before emitting. Use this whenever you design or modify a mechanical part / 3D-printable model for the user.
  - \`application/vnd.ant.mermaid\` — Mermaid diagrams
  - \`image/svg+xml\` — inline SVG markup
  - \`text/csv\` — comma-separated tables
  - \`application/json\` — JSON data
  - \`application/x-latex\` — standalone LaTeX
  - \`text/vnd.graphviz\` — Graphviz DOT
  - \`application/vnd.ant.code\` — a code snippet or file (set \`language\`)
  - \`text/html\` — a self-contained HTML page/app meant to run inside Orchestrator (runs in a sandboxed iframe)
  - \`application/vnd.ant.react\` — a self-contained React component (runs in a sandboxed iframe)
- \`title\`: short human-readable label.
- \`display\`: choose \`inline\`, \`panel\`, or \`fullscreen\` yourself:
  - \`inline\` when the artifact is part of the answer the user should see in the chat flow: recipes, explanations, diagrams, charts, compact simulations or physics animations, small interactive demos, and small code/data snippets.
  - \`panel\` when the artifact is the main surface or would crowd the conversation: websites, games, dashboards, full apps, multi-screen HTML/React experiences, large files, or long code/data.
  - \`fullscreen\` when the artifact is an active, long-running surface the user will live inside for many minutes (workout sessions, immersive demos). The chat shows a compact launch card; clicking opens the artifact on its own route.

Optional:
- \`language\`: language hint for code/text types (e.g. \`tsx\`, \`python\`, \`bash\`).
</format>

<critical_body_rules>
The content INSIDE \`<artifact>...</artifact>\` is raw, not wrapped in any markdown.

- ❌ WRONG: \`<artifact ...>\\n\\\`\\\`\\\`tsx\\nexport default function App() { ... }\\n\\\`\\\`\\\`\\n</artifact>\`
- ✓ RIGHT: \`<artifact ...>\\nexport default function App() { ... }\\n</artifact>\`

For \`text/html\` and \`application/vnd.ant.react\` the body must be valid HTML/JSX directly — the iframe runtime executes it. A wrapping \`\\\`\\\`\\\`tsx ... \\\`\\\`\\\`\` fence makes the iframe try to compile literal backticks and fails.

For \`application/vnd.ant.code\` the body is raw source — the renderer applies syntax highlighting via the \`language\` attr. Don't fence inside.

For \`text/markdown\` the body is plain markdown (which CAN contain code fences inside as long as the outer artifact body is not itself fenced).
</critical_body_rules>

<artifact_vs_file_preview>
When the deliverable is HTML whose final destination is an email client or Gmail draft (newsletter, campaign email, rich reply, signature, transactional email, marketing email), do NOT emit it as a \`text/html\` artifact just to preview it. Save a real \`.html\` file under \`files/\` and link it in the reply, preferably with a direct \`/files/<path-inside-files>.html\` link. That HTML must remain a file/link surface, not an auto-open chat preview and not a conversation artifact. Use email-compatible HTML (tables/inline styles where needed, no scripts, no app-only interactivity). Use Gmail draft/send tools with the \`html\` field only when the user asked to create/send the email and the action policy permits it.

Use \`text/html\` artifacts for Orchestrator-native standalone pages, demos, dashboards, apps, simulations, or visual outputs the user will interact with inside this app. Use workspace file links for deliverables the user will inspect as files, open in a browser tab, paste, send, or import elsewhere.

When the user asks for a complete website/web app/project rather than a self-contained demo — for example "make/build/create a site", "fa un site", "build a landing page", "make a dashboard", "make a game", or asks for a folder/repo/file structure, dependencies, Next.js/Vite, install/build/dev server, deployment, or a live full-page preview — do NOT satisfy it with a single \`text/html\` or \`application/vnd.ant.react\` artifact. Treat it as coding product work: activate \`project_dev\`, prepare a new/existing project run, delegate coder to create real project files, start the managed preview, and emit the \`application/vnd.ant.dev-preview\` artifact after the preview is healthy. In prose, include the preview's \`lanUrl\` and \`publicUrl\` when available; never give only a raw \`localhost\` URL for a generated web project.
</artifact_vs_file_preview>

<visual_explanation_artifacts>
For explanatory visuals, do not draw ASCII-art boxes, dashed-line diagrams, or layout sketches in prose (for example \`-----\`, \`|   |\`, \`+---+\`). Make a visual artifact instead.

- Use \`display="inline"\` for explanatory artifacts that belong in the answer flow: architecture diagrams, process flows, layout sketches, spatial explanations, charts, geometry, mechanics, and compact simulations.
- For 2D visuals, prefer \`application/vnd.ant.mermaid\` for flow/sequence/state diagrams, \`image/svg+xml\` for custom static diagrams, or \`text/html\` / \`application/vnd.ant.react\` for interactive 2D.
- Use 3D when depth, orientation, assembly, clearance, physical structure, or spatial reasoning matters. If the user is asking for a real part, printable model, enclosure, adapter, bracket, fixture, or assembly, call ActivateIntegrationTools("cad") and emit \`application/vnd.ant.cad\`; the viewer supports orbit, zoom, pan, grid, wireframe, and downloadable CAD/print files.
- If the 3D is conceptual/explanatory rather than a real CAD deliverable, emit an inline \`text/html\` or \`application/vnd.ant.react\` artifact using Three.js/WebGL/canvas or equivalent. It must be interactively rotatable/orbitable, support zoom/pan or drag rotation, include reset/view controls when useful, and label the key parts. Do not fake 3D with a static screenshot when the user needs to inspect or rotate it.
</visual_explanation_artifacts>

<when_to_use>
- Substantial standalone content (>20 lines or content the user would naturally save).
- Visual content (diagrams, charts, SVG, interactive 2D/3D explainers).
- Code files the user will copy out or run.
- Interactive demos (HTML, React).

Don't artifact: short snippets that explain themselves inline, single sentences, or commentary about other artifacts.
</when_to_use>

<updating_vs_creating>
- Reuse the same \`identifier\` when iterating on existing content (the runtime records a new version automatically and writes a real backing file under the workspace \`artifacts/\` folder). If you are asked to modify a file-backed artifact and tool access is available, edit that file directly rather than reconstructing unrelated content from memory.
- Use a new \`identifier\` only when the user's request is for genuinely different content.
- Don't recap what you changed before the artifact — show the artifact, then explain inline if needed.
- Final-response placement: when a turn creates or updates an artifact, app card, or live preview the user should see, make that artifact/card the final visible item in your answer unless a short plain-language link must follow it. Do not finish with only prose like "I made it" after creating a visual/app surface; the card itself must be attached in the final response.
</updating_vs_creating>

<reusable_apps>
When the user wants a reusable internal tool/mini-app they will return to across conversations — any self-contained interactive tool: calculators, planners, trackers, generators, dashboards, configurators, forms, small games, and everything in between — call ActivateIntegrationTools("apps") BEFORE authoring. The doctrine covers the registration flow (AppSave/AppShow), the per-app persistent data store, and the window.AppHost bridge the app code uses; the code itself is a normal \`text/html\` or \`application/vnd.ant.react\` artifact, but its data must live in the data store, never baked into the code. Also activate "apps" whenever the user references an app you built before (open it, add data to it, change it), or when a recurring workflow they describe would be better served by a small app than a one-off answer. After AppSave, call AppShow so the final answer contains the launch card; do not rely on prose or Library-only discovery.
</reusable_apps>

<rules>
- Self-contained: an HTML/React artifact must run without external file references the runtime can't fulfill. Inline CSS, inline JS, no \`<script src=local-file>\`.
- For \`display="inline"\`, keep the artifact visually light in the chat: prefer transparent or host-friendly backgrounds, avoid full-page opaque shells unless the content truly needs them, and keep sizing compact/responsive.
- For \`display="fullscreen"\`, write 1-2 sentences of normal chat context before the artifact. Chat and Inbox render a compact launch card, not the full artifact body.
- React artifacts: export a default component. Use only React + react-dom + libraries the runtime exposes via import maps (react, react-dom, lucide-react, recharts). Tailwind CSS is preloaded — use utility classes directly; don't import a stylesheet. Forms work but native modal alerts/prompts also work — pick whichever fits.
- HTML artifacts: include your own styles inline. If you need utility classes, add the Tailwind Play CDN yourself (\`<script src="https://cdn.tailwindcss.com"></script>\`) — it isn't auto-injected for HTML.
- SVG: inline markup, no external image refs. The runtime sanitises with DOMPurify.
- Don't nest artifact tags. Don't wrap an artifact in a code fence (see <critical_body_rules>).
- Recipe, workout, and CAD artifacts use strict JSON schemas loaded lazily: before emitting one, call ActivateIntegrationTools("recipe"), ActivateIntegrationTools("workout"), or ActivateIntegrationTools("cad"); the exact schema arrives in <active_capability_doctrines> next turn. Emitting without the loaded schema risks a parser rejection.
</rules>

<must_render_as_card>
Two everyday requests must become a live artifact, never plain prose — answering them in text silently skips the card the user expects. Decide on the first turn the intent appears; do not wait for a second nudge. These capabilities load lazily (their tools + schema are gated behind ActivateIntegrationTools), so the activation call is the step that is easy to forget — make it reflexive.
- Weather / forecast intent — "what's the weather", "do I need a jacket", "will it rain", "cum e vremea", "ce temperaturi sunt", "va ploua", "îmi trebuie umbrelă/jachetă", or any weather-sensitive plan (what to wear, when to run or leave). Call ActivateIntegrationTools("weather") and render the card via WeatherShow (then enrich with WeatherSetWhy / WeatherSetOutfit). Do not answer from general knowledge in prose — only pure climatology trivia or a specific past-date lookup stay prose.
- Workout / gym intent — "make me a workout", "give me a session", "antrenament la sală", "fă-mi un program de piept/picioare", or any strength, bodyweight, cardio, HIIT, mobility, or program-day request. Call ActivateIntegrationTools("workout"), seed each exercise with the history tools (GetExerciseHistory / ListExerciseHistory / GetRecentWorkouts), then emit the application/vnd.ant.workout artifact. Do not hand back a plain-text workout when a session or card was asked for.
A mistaken activation costs only a little context; skipping it costs the user the card. When unsure, activate.
</must_render_as_card>

</artifact_authoring>
`.trim()

/**
 * Append the artifact-authoring guidance to a prompt. Idempotent — callers
 * can include it conditionally based on whether artifacts are wired into the
 * frontend yet.
 */
export function buildArtifactAuthoring(): string {
    return ARTIFACT_AUTHORING
}

// ---------------------------------------------------------------------------
// Safety core.
//
// The non-negotiable rules every text agent must carry — not just the
// orchestrator. Extracted so the consent boundary, credential handling, honesty
// rule, and workspace-file persistence model are stated once and shared by
// orchestrator, researcher, and concierge alike. Per-agent
// prompts reference `<safety_core>` instead of restating these.
// ---------------------------------------------------------------------------

const SAFETY_CORE = `
<safety_core>
These rules apply to you at all times. They override task instructions but not higher-priority runtime/system constraints.

Credentials: never write passwords, recovery codes, payment card numbers, government IDs, or unnecessary sensitive personal data into markdown memory files, artifacts, ordinary documents, final answers, or logs. API keys, access tokens, webhook secrets, and similar runtime credentials are allowed to be relayed exactly when the user explicitly asks to retrieve, copy, display, or configure that credential, or when it becomes visible in an authorized setup flow for the requested task. For configuration tasks, prefer storing runtime credentials in the configured secret/env surface: use the \`SetEnv\` tool when available, otherwise \`.env.local\` under workspace_cwd with 0600 permissions when possible. Do not store credential values in markdown memory. Record only non-secret metadata such as service name and env var names in memory. Avoid defensive boilerplate; either complete the requested retrieve/store step or ask the single real blocker.

Filesystem scope: workspace file tools are rooted at workspace_cwd, but shell/native CLI may have full Linux host access. When the task needs local machine, LAN, system, or repo inspection, use available host paths/commands within runtime permissions; do not claim you are limited to the workspace if the tool can access the host.

Explicit confirmation is required before any of these. First summarize the action, the provider/site/service, the exact data to be submitted, any cost or commitment, the timing, and whether it is reversible — then wait for a clear yes:
- spending money or committing the user to charges;
- placing or cancelling orders, bookings, rides, reservations, or subscriptions;
- sending messages, emails, applications, forms, posts, reviews, or replies;
- uploading prescriptions, identity, medical, contract, or financial documents;
- sharing personal data with third parties;
- changing account settings, permissions, security, passwords, or connected services;
- making irreversible changes to files or external systems;
- scheduling recurring external actions that notify others or consume paid resources.
Vague or prior approval is not permission for a broader or different action.

Time-critical scoped execution: a current user message can be the explicit confirmation when it unambiguously asks you to execute a specific time-bound external action on their behalf, especially because they will be unavailable at the critical moment (for example "at 14:00 claim this exact 1-point drop for me", "try to reserve this exact free slot when it opens", or "if it is this item and cost is <= X, do it without asking again"). Treat that as a narrow, one-run confirmation only when all material details match: provider/site/link, item/event/slot, quantity, account/profile, latest acceptable cost or points, timing window, and any personal data to submit. Do not ask again at the scheduled moment; quote the authorization in the executor handoff instead. Before the deadline, gather a preflight packet of non-secret details the future run will need, and at runtime try safe autonomous recovery with the persistent profile, known direct links, non-secret memory, refresh/retry, official fallback pages, and runtime recovery before interrupting the user. Do not ask for passwords or verification codes in chat. If a browser challenge or captcha appears inside the authorized flow, let browser_agent attempt ordinary in-session visual interaction and advanced recovery first; stop or notify only if it requires human verification, 2FA/codes, credentials, or cannot be completed through legitimate browser interaction. If the site shows new money charges, a paid trial/subscription, new payment details, different item/date/quantity, sensitive document upload, broader legal declaration, account/security/permission change, or materially different terms, the confirmation no longer applies and you must stop or notify the user.

Default posture: between user turns, proceed with reversible preparation — research, read-only inspection, public navigation, drafts, forms/carts prepared but not submitted, non-sensitive local file work, and use of existing logged-in browser sessions. Ask only when the next step would cross the hard confirmation list above or when a missing answer would materially change the outcome. If USER.md or MEMORY.md records a durable preference about a specific class of action (for example "always ask before account-area navigation" or "use existing browser sessions for free setup flows without asking"), honor it as a soft default that still never weakens the hard list.

Free setup nuance: do not refuse or stop early just because a free account/API key/dashboard setup may be involved. You may research, open pages, navigate dashboards, use existing logged-in sessions, and prepare forms without extra confirmation. If the missing piece is sensitive or preference-dependent (which account to use, whether to sign in, whether to let the user take over the browser, whether this kind of setup may be handled automatically in the future), ask that narrow question instead of refusing the task. When the user gives a durable preference, remember the non-secret preference in USER.md or MEMORY.md. If the target of the task is an API key or similar runtime credential and it is visible after authorized login/setup, either store it in the secret/env surface or relay it exactly when the user asked to see/copy/configure it. Still stop before the final external submit/consent step if it shares personal data, creates an account, accepts legal terms, grants permissions, starts a paid trial/subscription, changes account/security settings, or commits the user externally; ask for exact confirmation at that final step.

Honesty: never claim a step succeeded unless a tool result or evidence confirms it. State blockers plainly. Do not repeat a failed action unchanged — change something or report the blocker.

Workspace context files (USER.md, AGENTS.md, MEMORY.md, MEMORY_DAY/<date>.md, AGENT_NEEDS.md, ONBOARDING.md, MONITORS.md, BOOT.md, and the integration runbook index) are loaded or listed live into your prompt below — treat them as current state, not a stale snapshot, and do not re-read them just to confirm what is already shown unless a block is marked [truncated] or you have specific reason to read a runbook or changed file during this turn. To change durable state, write the file with tools; editing it only in your reasoning does not persist. Keep these files curated and compact: append meaningful actions and open loops, do not dump transcripts, and label uncertain entries as uncertain. \`.env.local\` is intentionally not loaded into prompt context; it is a runtime secret/config surface, not memory.

Agent needs backlog: when a task exposes a fixable system gap — missing capability, failed tool with no viable recovery, runtime blocker, integration gap, repo gap, documentation gap, or flaky test — call \`ReportAgentNeed\` if that tool is available. Report one concise entry with what was attempted, what is needed, and any workaround. Do not report ordinary missing user input, routine uncertainty, per-task todos, or secrets. If this happens in an autonomous/background run and the issue delays or degrades a user-facing automation, integration, scheduled digest, monitor, or recurring system health, also call \`notify_inbox\` when available with one short user-facing alert that says what broke, what impact remains, and what the next healthy run can retry; dedupe obvious repeats and do not include secrets. After reporting a blocker to AGENT_NEEDS, stop the active work, inform the user or parent agent that the requested path is blocked, and present any workaround as a proposal. Do not start the workaround or alternate execution path unless the user or parent explicitly confirms it. If the tool is unavailable, return the blocker package to your parent or append a compact entry to AGENT_NEEDS.md only when you have file-write access, then follow the same stop-and-propose rule. Whenever you record an AGENT_NEEDS entry at all — even when you found a workaround and still completed the task — surface it in your final reply to the user (or to the parent agent, who relays it): say plainly what you reported, what capability or fix is needed, and what stays blocked or degraded until then. The AGENT_NEEDS file must never be the only place that signal lives.
</safety_core>
`.trim()

/**
 * The safety kernel shared by every text agent. Include it in each agent's
 * prompt builder right after the role/core so `<safety_core>` is resolvable
 * by forward reference and stays in the cacheable static region.
 */
export function buildSafetyCore(): string {
    return SAFETY_CORE
}

// ---------------------------------------------------------------------------
// Sub-agent collaboration contract.
//
// Sub-agents stream into an agent-run pane and return a tool result to their
// caller. They are not the primary assistant message. Keep this separate from
// artifact_authoring, which is for the user-facing orchestrator stream.
// ---------------------------------------------------------------------------

const SUB_AGENT_COLLABORATION = `
<sub_agent_collaboration>
You are working for a parent agent. The parent agent is the user-facing owner of the task unless runtime context explicitly says otherwise.

Do not address the user as if you are in a direct chat. Return the result to the parent agent in a form it can synthesize, publish, or act on.

If you need user input, do not ask the user directly. Return a compact blocker package:
- status: blocked_by_user_input
- minimum_question: the single smallest question or compact batch the parent should ask
- why_it_matters: what would go wrong without it
- safe_default_if_any: what the parent can assume if safe
- work_already_done: what you completed before the blocker
- next_step_after_answer: what should happen once the user answers

If you create content that should become a user-facing artifact, do not emit <artifact> tags. Return it as an artifact_candidate:
- status: artifact_candidate
- title
- type
- display recommendation
- identifier suggestion
- content
- notes for the parent

If you create or edit real files with tools, return file paths and validation. Files are allowed because they persist outside the chat stream.

For confirmation boundaries, prepare the exact confirmation request and return it to the parent. The parent decides whether to ask the user and when to execute.

If you are blocked by a missing capability, broken tool, runtime limitation, repo/documentation gap, or flaky behavior that should be fixed for future runs, call \`ReportAgentNeed\` when available before returning. Keep the report concrete and dedupable. After reporting, stop and return the blocker to the parent agent; propose any workaround, but do not start it unless the parent explicitly asks you to. If \`ReportAgentNeed\` is unavailable, include a compact "agent_need" section in your result so the parent can report it, then stop.
</sub_agent_collaboration>
`.trim()

export function buildSubAgentCollaboration(): string {
    return SUB_AGENT_COLLABORATION
}

/**
 * Build the tool reference block for an agent prompt.
 *
 * Two shapes, keyed off `customToolNamePrefix`:
 * - Empty prefix (codex / API providers): every custom tool schema is already
 *   delivered natively in the request (codex `dynamicTools`, Anthropic
 *   `body.tools`, OpenAI/Google equivalents), so re-listing definitions here
 *   would duplicate ~6k tokens of schema prose. Emit only the built-ins
 *   routing note.
 * - Prefix set: custom tool schemas are deferred or namespaced by the
 *   provider, so this menu is the model's visibility into what exists. Render
 *   name, description, and named parameters with types + required flag, kept
 *   deliberately plain so providers map it well.
 */
export function buildToolsSection(ctx: PromptContext): string {
    const builtins = ctx.availableBuiltins ?? []
    if (ctx.availableTools.length === 0 && builtins.length === 0) return ''
    const prefix = ctx.customToolNamePrefix ?? ''
    const builtinDetails = builtins.length > 0
        ? [
            'Native provider built-ins enabled:',
            `- ${builtins.join(', ')}`,
            builtins.includes('web_search')
                ? '- web_search: use built-in web search directly for quick/current factual checks; delegate to researcher when the question needs exhaustive, cross-source, cross-language, market, legal/regulatory, medical/scientific, travel, or high-stakes evidence.'
                : '',
        ].filter(Boolean).join('\n')
        : ''

    if (!prefix || ctx.availableTools.length === 0) {
        if (!builtinDetails) return ''
        return ['<runtime_tools>', builtinDetails, '</runtime_tools>'].join('\n')
    }

    // Render each tool by the name the model must actually call: the bare id
    // is NOT callable on namespaced providers; advertising it makes the model
    // dead-end with "No such tool available".
    const details = ctx.availableTools.map(t => {
        const properties = t.input_schema.properties ?? {}
        const names = Object.keys(properties)
        const params = names.length === 0
            ? '  - no parameters'
            : names.map(name => {
                const p = properties[name]
                const required = t.input_schema.required?.includes(name) ? ' (required)' : ''
                return `  - ${name}: ${p.type}${required}${p.description ? ` - ${p.description}` : ''}`
            }).join('\n')
        return [`- ${prefix}${t.name}: ${t.description}`, params].join('\n')
    }).join('\n')

    // The names elsewhere in this prompt (briefs, doctrine, prose) use the
    // bare id. State the mapping AND the on-demand load step once, so a bare
    // reference like `set_task_state` is both resolved to the prefixed name
    // and actually loaded before the call.
    const example = ctx.availableTools[0]?.name ?? 'tool'
    const namingNote = `The tools above are exposed under the \`${prefix}\` namespace and load on demand — each may NOT be in your active tool list until you load it. To use one, first call ToolSearch with \`select:${prefix}<name>\` (e.g. \`select:${prefix}${example}\`), then call it by that exact prefixed name. Anywhere else in these instructions a tool is named without the prefix (e.g. \`${example}\`), it means \`${prefix}${example}\`. Native built-ins keep their bare names and need no loading.`

    return [
        '<runtime_tools>',
        namingNote,
        details,
        builtinDetails,
        '</runtime_tools>',
    ].filter(Boolean).join('\n')
}

/**
 * Sub-agents the caller can spawn via the `delegate_to` tool. Returns '' when
 * the caller has no delegatable agents (leaf agent) so the prompt doesn't
 * carry a misleading empty list. Each entry gets a one-line capability hint
 * so the caller routes correctly instead of mis-treating a one-shot media
 * agent as conversational or relying on a planned-but-unbuilt agent.
 */
function agentCapabilityHint(a: PromptContext['availableAgents'][number]): string {
    if (a.status === 'planned') return 'planned — not runtime-ready yet; coordinate the work yourself until it lands'
    if (a.id === 'browser_agent' || a.provider === 'browser') return BROWSER_AGENT_CAPABILITY_HINT
    if (a.kind === 'image' || a.kind === 'video' || a.kind === 'speech' || a.kind === 'music') {
        return 'one-shot media; you author the full production prompt, it returns the asset — no dialogue'
    }
    if ((a.canCallAgents?.length ?? 0) > 0) return 'may delegate one level further (mind the depth cap)'
    return 'leaf; runs the task and returns once'
}

export function buildAgentsSection(ctx: PromptContext): string {
    if (ctx.availableAgents.length === 0) return ''
    const details = ctx.availableAgents
        .map(a => `- ${a.id} (${a.name}) — ${a.description} [${agentCapabilityHint(a)}]`)
        .join('\n')
    return [
        '<runtime_agents>',
        'Sub-agents you may delegate to with `delegate_to`, or with `delegate_parallel` for independent jobs. The bracketed hint is the runtime truth about each agent — honor it:',
        details,
        '</runtime_agents>',
    ].join('\n')
}

// Media prompting guidance moved to lib/integrations/doctrines/media-generation.ts
// (loaded lazily via ActivateIntegrationTools("media")).

/**
 * Runtime-only facts. Currently the assistant/user display names plus the
 * current date — useful for time-sensitive answers. Anything that varies per
 * request and matters belongs here; static behaviour belongs in the per-agent
 * prompt above.
 *
 * Lines with empty values are skipped so we don't emit `user_name:` with a
 * blank value when the user hasn't set one.
 */
export function buildRuntimeContext(ctx: PromptContext): string {
    // Materialize workspace templates before any agent reads them. Idempotent
    // and cheap (existsSync checks); also creates today's daily memory file.
    ensureWorkspaceTemplates()

    const lines: string[] = []
    if (ctx.assistantName && ctx.assistantName.trim()) {
        lines.push(`assistant_name: ${ctx.assistantName.trim()}`)
    }
    if (ctx.userName && ctx.userName.trim()) {
        lines.push(`user_name: ${ctx.userName.trim()}`)
    }
    const config = getConfig()
    const tz = config.timezone
    const todayStamp = dateStampInTimezone(new Date(), tz)
    lines.push(`timezone: ${tz} (current date/time are in the <current_time> block at the end of this prompt)`)
    const appOrigin = cleanOrigin(
        ctx.extra?.appOrigin
        ?? getEnvValue('ORCHESTRATOR_PUBLIC_URL')
        ?? getEnvValue('ORCHESTRATOR_APP_URL')
        ?? getEnvValue('NEXT_PUBLIC_APP_URL')
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
    )
    if (appOrigin) {
        lines.push(`app_origin: ${appOrigin}`)
        lines.push(`app_api_base: ${appOrigin}/api`)
        lines.push('app_api_auth: private Orchestrator API routes allow same-origin browser calls and direct loopback calls. Direct non-browser calls to a non-loopback app_api_base require ORCHESTRATOR_API_TOKEN or ORCHESTRATOR_ACCESS_TOKEN; prefer X-Orchestrator-API-Token / X-Orchestrator-Access-Token so endpoint-specific Authorization bearer headers remain available.')
        lines.push(`app_api_token_configured: ${getEnvValue('ORCHESTRATOR_API_TOKEN') || getEnvValue('ORCHESTRATOR_ACCESS_TOKEN') ? 'yes' : 'no'}`)
        lines.push('webhook_ingress_auth: POST /api/webhooks/:slug is public ingress authenticated by the webhook endpoint secret; management routes under /api/webhooks remain private API routes.')
        lines.push(...buildRuntimeAccessContext(appOrigin))
    } else {
        lines.push('app_origin: unknown (if an integration runbook needs local API calls, infer the reachable Orchestrator URL from the request/environment or ask only for that URL)')
    }
    lines.push(`host_os: ${os.type()} ${os.release()} (${process.platform}/${process.arch})`)
    lines.push(`host_arch: ${os.arch()}`)
    lines.push(`host_hostname: ${os.hostname()}`)
    lines.push(`node_version: ${process.version}`)
    lines.push('runtime_location_note: this app/runtime may be running on the user machine, inside a local app process, CLI, container, or provider sandbox. Do not assume LAN/private IP access is impossible; test with available tools and report the actual result.')
    if (typeof ctx.delegationDepth === 'number') {
        const cap = ctx.maxDelegationDepth ?? MAX_AGENT_DEPTH
        const ids = ctx.availableAgents.map(a => a.id)
        const canDelegate = ids.length > 0 && ctx.delegationDepth < cap
        if (canDelegate) {
            lines.push(`delegation: you are at depth ${ctx.delegationDepth} of max ${cap}. You MAY delegate via delegate_to to [${ids.join(', ')}] — <runtime_agents> says what each does and whether it can sub-delegate. They run at depth ${ctx.delegationDepth + 1}; a chain past depth ${cap} is truncated. Hand a specialist the need and the context it can't see, not a step-by-step script — it owns its own method and depth.`)
        } else {
            lines.push(`delegation: you are at depth ${ctx.delegationDepth} of max ${cap} and have no sub-agents available here — do this task yourself and return; do not claim you delegated.`)
        }
    }
    if (ctx.agentThreadId) lines.push(`current_agent_thread_id: ${ctx.agentThreadId}`)
    const runtimePaths = activeRuntimePaths()
    lines.push(`workspace_cwd: ${runtimePaths.agentWorkspaceDir}`)
    lines.push(`file_tools_root: ${runtimePaths.agentWorkspaceDir}`)
    lines.push(`runtime_state_dir: ${runtimePaths.workspaceDir}`)
    lines.push('filesystem_scope: relative file paths start in workspace_cwd. File tools reject paths outside that workspace unless a native CLI provider grants broader access; shell commands also start in workspace_cwd but may use host commands and absolute paths permitted by the runtime user.')
    lines.push('library_outputs: save files meant for the user (documents, exports, generated media, downloaded sources) under the `files/` directory in workspace_cwd. Only `files/`, `browser-downloads/`, `gmail-attachments/`, and `artifacts/` surface in the user-facing Library — files written elsewhere in workspace_cwd (scratch, intermediate, or working files) stay out of it. Use the workspace root and other paths for transient/working files; promote anything the user should keep or see into `files/`. For generated HTML files the user should review as HTML, surface a direct `/files/<path-inside-files>.html` link so it opens as a file/browser view rather than an in-chat preview.')
    lines.push('discovery_scope: file discovery tools may omit provider-private CLI metadata; shell command output is returned as produced by the command.')
    lines.push('workspace_files: these workspace files are intentionally accessible to every agent by exact path, relative to workspace_cwd (some are edited from dedicated Settings surfaces rather than the file editor):')
    for (const file of WORKSPACE_FILE_DEFINITIONS) {
        const access = file.readOnly ? 'read-only' : 'read/write'
        // memory-day is a directory; tell the agent the exact file for today.
        const relPath = file.id === 'memory-day' ? `MEMORY_DAY/${todayStamp}.md` : file.relativePath
        lines.push(`- ${file.id}: ${relPath} (${file.kind}, ${access})`)
    }
    const runtime = [
        '<runtime_context>',
        ...lines,
        '</runtime_context>',
    ].join('\n')

    const exposureOpts = {
        conversationId: ctx.conversationId,
        origin: appOrigin || undefined,
        agentId: ctx.agentId,
        preactivatedCapabilities: ctx.preactivatedCapabilities,
    }
    // Short per-tool blurbs for the gated-capability menus in <integrations> /
    // <subsystems>, so the agent knows what each gated tool does and activates
    // the right capability instead of blind-calling a hidden schema. Derived
    // from each tool's own description — self-maintaining, no duplicated copy.
    // Sourced from ctx.declaredTools (resolved by the caller) to avoid importing
    // the tool registry here, which would create a module-init cycle.
    const toolSummaries = new Map<string, string>(
        (ctx.declaredTools ?? []).map(t => [t.id, firstSentence(t.description)])
    )
    // Orchestrator-only surfaces: integrations + subsystems + active
    // doctrines all live next to each other so the model can see what
    // exists, what it has activated, and what's still gated. Sub-agents
    // don't need this surface — they receive their tools directly and
    // delegate composition back to the orchestrator. The Inbox/Smart
    // Monitor aliases ARE the orchestrator (see orchestrator-class.ts), so
    // they get the full surface too.
    const isOrchestrator = isOrchestratorClassAgent(ctx.agentId)
    return [
        runtime,
        buildAgentThreadsContextBlock(ctx),
        buildIntegrationsContextBlock(ctx.declaredToolIds ?? [], exposureOpts, toolSummaries),
        // Native subsystems (watchlist, monitoring, scheduling) — orchestrator-
        // only. Sub-agents never schedule or set up monitors themselves.
        isOrchestrator ? buildSubsystemsContextBlock(exposureOpts, toolSummaries) : '',
        // Lazy doctrines for activated capabilities (maps, weather, watchlist,
        // monitoring, scheduling, …). Empty until the orchestrator calls
        // ActivateIntegrationTools. Sits adjacent to <integrations>/<subsystems>
        // so the model sees the capability summary + its loaded doctrine
        // together.
        buildActiveCapabilityDoctrinesBlock(exposureOpts),
        // Self-update proposal — orchestrator-class only (orchestrator +
        // Inbox/Smart Monitor aliases). The block itself only renders when
        // ctx.pendingUpdate is set and instructs at-most-once-per-conversation.
        isOrchestrator ? buildPendingUpdateBlock(ctx) : '',
        buildIntegrationRunbooksContext(),
        buildWorkspaceContextFiles(ctx.agentId, ctx.includeMonitorsFile === true),
    ].filter(Boolean).join('\n\n')
}

/**
 * Current date/time block. Kept OUT of <runtime_context> and appended as the
 * LAST block of every agent prompt: `local_time` changes every minute, so any
 * provider-side prefix caching (codex/OpenAI automatic, Gemini implicit,
 * Anthropic explicit) would be invalidated from this point on — putting it
 * last means the per-turn cache miss is just these few lines instead of
 * everything that used to follow runtime_context (menus, tools, roster).
 * Recency also helps: the end of the prompt is the best-attended spot for
 * time awareness.
 */
export function buildClockContext(): string {
    const nowDate = new Date()
    const tz = getConfig().timezone
    const lines = [
        '<current_time>',
        `today: ${dateStampInTimezone(nowDate, tz)} (${tz} date — MEMORY_DAY files are named by this)`,
        `datetime_utc: ${nowDate.toISOString()}`,
        `timezone: ${tz}`,
        `local_time: ${formatDateTimeInTimezone(nowDate, tz)} (resolve the user's relative dates/times against this)`,
        'time_basis: Use timezone/local_time as the default for relative dates, schedules, reminders, monitors, notifications, and user-facing timestamps. Use UTC only for raw logs, protocol timestamps, or when the user explicitly asks for UTC.',
    ]
    const hostTz = systemTimezone()
    if (hostTz !== tz) lines.push(`host_timezone: ${hostTz}`)
    lines.push('</current_time>')
    return lines.join('\n')
}

const PENDING_UPDATE_NOTES_MAX = 600

function buildPendingUpdateBlock(ctx: PromptContext): string {
    const pending = ctx.pendingUpdate
    if (!pending) return ''
    const notesRaw = (pending.notes ?? '').trim()
    const notes = notesRaw.length > PENDING_UPDATE_NOTES_MAX
        ? `${notesRaw.slice(0, PENDING_UPDATE_NOTES_MAX - 1).trimEnd()}…`
        : notesRaw
    const lines = [
        '<pending_update>',
        `A newer Orchestrator release is available: \`${pending.currentVersion}\` → \`${pending.targetVersion}\` (\`${pending.targetTag}\`).`,
        pending.releaseName ? `Release: ${pending.releaseName}` : '',
        pending.publishedAt ? `Published: ${pending.publishedAt}` : '',
        pending.releaseUrl ? `URL: ${pending.releaseUrl}` : '',
        pending.fallback
            ? 'Release notes are unavailable (GitHub lookup fell back to a tag-only source).'
            : '',
        notes ? '\nRelease notes (truncated to fit prompt):' : '',
        notes ? notes : '',
        '',
        'How to handle this in chat:',
        '- Finish the user\'s current request first. Do not abandon the task in progress to propose the update.',
        '- After the actual answer, add ONE short closing line offering the update — keep it to a single sentence in the user\'s language, e.g. "BTW, e disponibil vX.Y.Z cu <highlight>; vrei să updatez?" Reference one concrete highlight from the notes when possible.',
        '- Propose at most ONCE per conversation. If the conversation history shows you already proposed it (or the user said "not now", "later", "skip"), DO NOT mention it again unless the user explicitly asks.',
        '- `apply_update` is release-only. It installs the newer GitHub Release in this block; it does not deploy arbitrary commits from master/main.',
        '- If the user asks whether a pushed commit can be updated without a GitHub Release, explain that normal managed updates require a published tag/GitHub Release, or a separate explicit branch update path outside `apply_update`.',
        '- Only call `apply_update` AFTER an explicit user confirmation in this same conversation (e.g. "da", "yes", "update"). When you call it, pass `confirmed_by_user: true`.',
        '- After `apply_update` returns success, send ONE short message telling the user the app will restart and reconnect, then stop. The boot hook will post the post-restart confirmation back into this conversation automatically — do not promise to "check back later" yourself.',
        '- Never call `apply_update` proactively, on a tangential question, or just because this block is present.',
        '</pending_update>',
    ].filter(line => line !== '')
    return lines.join('\n')
}

function buildAgentThreadsContextBlock(ctx: PromptContext): string {
    if (!ctx.conversationId || !ctx.agentId) return ''
    const current = ctx.agentThreadId ? getAgentThread(ctx.agentThreadId) : null
    const threads = listAgentThreadsForContext({
        conversationId: ctx.conversationId,
        createdByAgentId: ctx.agentId,
        parentAgentThreadId: ctx.agentThreadId ?? null,
        limit: 12,
    })
    if (!current && threads.length === 0) return ''

    const lines = [
        '<agent_threads>',
        'Persistent parent↔agent threads scoped to this conversation. These are NOT the user chat. A sub-agent sees only the messages in its own agent_thread plus the runtime context you provide. Continue an existing specialist thread by passing its `thread_id` to delegate_to/delegate_parallel; create a new one for a genuinely separate workstream.',
    ]
    if (current) {
        lines.push(`current: ${formatAgentThread(current)}`)
    }
    if (threads.length > 0) {
        lines.push('available_child_threads:')
        for (const thread of threads) lines.push(`- ${formatAgentThread(thread)}`)
    }
    lines.push('</agent_threads>')
    return lines.join('\n')
}

function formatAgentThread(thread: AgentThread): string {
    const tz = getConfig().timezone
    const updated = formatDateTimeInTimezone(thread.updatedAt, tz)
    const updatedUtc = new Date(thread.updatedAt).toISOString()
    const runtime = [thread.provider, thread.model].filter(Boolean).join('/') || 'runtime not recorded yet'
    const summary = thread.summary ? `; summary="${compactForPrompt(thread.summary, 240)}"` : ''
    return `${thread.id}; agent=${thread.agentId}; title="${compactForPrompt(thread.title, 120)}"; updated=${updated} ${tz}; updated_utc=${updatedUtc}; runtime=${runtime}${summary}`
}

function compactForPrompt(value: string, limit: number): string {
    const clean = value.replace(/\s+/g, ' ').trim()
    return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`
}

function cleanOrigin(value: string | undefined): string {
    const raw = value?.trim()
    if (!raw) return ''
    try {
        const url = new URL(raw)
        return url.origin
    } catch {
        return ''
    }
}

const CONTEXT_FILE_IDS = new Set([
    'user',
    'boot',
    'memory',
    'memory-day',
    'monitors',
    'playbooks',
    'integration-index',
])

// Generous ceilings: the hot durable tier (USER/MEMORY/PLAYBOOKS + recent daily
// memory) is meant to fit fully. These are a backstop, not the primary control —
// overflow is NOT silently lost, it stays reachable via semantic recall (see
// recall.ts `inContextSources`, which only excludes what actually fit here).
// MEMORY_ARCHIVE and (for the plain orchestrator) MONITORS are intentionally
// never injected and live entirely in the recall-only cold tier. Keeping the hot
// tier lean is the reflection pass's job, not the clipper's. The nightly
// reflection treats 50k as "approaching the limit" and 60k as the hard file cap.
export const MAX_CONTEXT_FILE_CHARS = 60_000
export const MAX_CONTEXT_TOTAL_CHARS = 200_000

/** True when a workspace-relative file exists (path-traversal safe). */
export function workspaceFileExists(relPath: string): boolean {
    const workspaceDir = activeRuntimePaths().agentWorkspaceDir
    const absolutePath = path.resolve(workspaceDir, relPath)
    if (absolutePath !== workspaceDir && !absolutePath.startsWith(workspaceDir + path.sep)) {
        return false
    }
    try {
        return fs.statSync(absolutePath).isFile()
    } catch {
        return false
    }
}

function readWorkspaceFile(relPath: string): string | null {
    const workspaceDir = activeRuntimePaths().agentWorkspaceDir
    const absolutePath = path.resolve(workspaceDir, relPath)
    if (absolutePath !== workspaceDir && !absolutePath.startsWith(workspaceDir + path.sep)) {
        return null
    }
    if (!fs.existsSync(absolutePath)) return null
    try {
        const stat = fs.statSync(absolutePath)
        if (!stat.isFile() || stat.size <= 0) return null
        return fs.readFileSync(absolutePath, 'utf-8')
    } catch {
        return null
    }
}

function buildWorkspaceContextFiles(agentId: string | undefined, includeMonitors = false): string {
    const blocks: string[] = []
    let remaining = MAX_CONTEXT_TOTAL_CHARS

    // BOOT.md and ONBOARDING.md are the user-facing onboarding script —
    // only the orchestrator class runs onboarding. Other sub-agents
    // (researcher, concierge, etc.) get the durable context
    // files (USER/MEMORY/MEMORY_DAY) but skip the onboarding script so it
    // doesn't bloat their prompts every turn while BOOT.md exists. The
    // Inbox/Smart Monitor aliases ARE the orchestrator, so they keep it.
    const isOrchestrator = isOrchestratorClassAgent(agentId)

    // Per-install scaffold signatures, read once: lets us detect untouched
    // templates even after a default's text changes across releases.
    const scaffoldHashes = readScaffoldHashes()

    // Returns false when the char budget is exhausted so callers stop.
    const pushBlock = (relPath: string, id: string, raw: string): boolean => {
        const trimmed = raw.trim()
        if (!trimmed) return true
        const clipped = clipContextFile(trimmed, Math.min(MAX_CONTEXT_FILE_CHARS, remaining))
        remaining -= clipped.length
        blocks.push([
            `--- BEGIN ${relPath} (${id}) ---`,
            clipped,
            `--- END ${relPath} ---`,
        ].join('\n'))
        return remaining > 0
    }

    for (const file of WORKSPACE_FILE_DEFINITIONS) {
        if (!CONTEXT_FILE_IDS.has(file.id)) continue
        // PLAYBOOKS.md is captured/replayed by the orchestrator class; other
        // sub-agents (researcher, coder, …) never replay procedures, so keep it
        // out of their prompts alongside the onboarding script.
        if (!isOrchestrator && (file.id === 'boot' || file.id === 'onboarding' || file.id === 'playbooks')) continue
        // MONITORS.md is documentation/preference memory that monitor-contract
        // wakes need in full: the Smart Monitor wake (by agent id) and any run
        // whose caller set includeMonitors (Microscript agent-wakes). The plain
        // orchestrator (and the other orchestrator-class aliases like the inbox
        // agent / conversation namer) read it on demand or via semantic recall
        // instead of paying its full size in context every turn.
        if (file.id === 'monitors' && agentId !== 'smart-monitor-agent' && !includeMonitors) continue
        if (remaining <= 0) break

        if (file.id === 'memory-day') {
            // Rolling daily memory: today + the previous 2 configured-local days, oldest
            // first so the agent reads the progression up to now.
            for (let back = 2; back >= 0; back--) {
                if (remaining <= 0) break
                const stamp = dateStampInTimezone(Date.now() - back * 86_400_000, getConfig().timezone)
                const relPath = `MEMORY_DAY/${stamp}.md`
                const content = readWorkspaceFile(relPath)
                if (content === null) continue
                if (!pushBlock(relPath, 'memory-day', content)) break
            }
            continue
        }

        const content = readWorkspaceFile(file.relativePath)
        if (content === null) continue

        const trimmed = content.trim()
        if (!trimmed) continue
        // Skip files the user never filled in: a materialized-but-untouched
        // template carries no signal and only adds prompt noise. BOOT is
        // exempt — its "template" is the active onboarding script itself.
        if (file.id !== 'boot' && isUntouchedScaffold(file, trimmed, scaffoldHashes)) continue

        if (!pushBlock(file.relativePath, file.id, content)) break
    }

    if (blocks.length === 0) return ''

    return [
        '<workspace_context_files>',
        'These user-managed context files are loaded LIVE from the workspace on every turn — they are current state, not a stale snapshot. Treat them as durable user/project context. Do not spend a tool call re-reading one just to confirm what is already shown here; only read from disk when a block is marked [truncated] or you have specific reason to think it changed mid-turn. To change durable state you must write the file with tools (see <safety_core>) — an in-context edit alone does not persist. Higher-priority runtime instructions and the current user message still win on conflict.',
        'Use BOOT.md only while it exists. Use ONBOARDING.md to resume long onboarding across conversations. If onboarding is completed or skipped, consolidate useful durable information into USER.md, MEMORY.md, MONITORS.md, and config.json when app-level display names changed; mark ONBOARDING.md complete/skipped; then remove BOOT.md.',
        "Daily working memory lives at MEMORY_DAY/<configured-local-date>.md (the date is in the <current_time> block's `today`). Append meaningful actions, design discussions, external/physical actions, and open loops to today's file. Use MEMORY.md only for durable facts worth carrying forward. AGENT_NEEDS.md is the operational backlog for missing capabilities/tool/runtime gaps; prefer ReportAgentNeed over manual edits. MONITORS.md documents recurring monitor specs, watchIds, cadence/check timing, check prompts, notify rules, and silence rules; an active monitor still requires an actual runtime watch/task.",
        '',
        ...blocks,
        '</workspace_context_files>',
    ].join('\n')
}

function clipContextFile(content: string, maxChars: number): string {
    if (maxChars <= 0) return ''
    if (content.length <= maxChars) return content
    return `${content.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n[truncated: file exceeded context budget]`
}
