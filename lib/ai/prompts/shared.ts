import type { PromptContext } from '@/lib/ai/agents/types'
import { MAX_AGENT_DEPTH } from '@/lib/ai/agents/types'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AGENT_WORKSPACE_DIR, getEnvValue, WORKSPACE_DIR } from '@/lib/config'
import { WORKSPACE_FILE_DEFINITIONS, ensureWorkspaceTemplates } from '@/lib/settings/workspace-files'
import { buildIntegrationRunbooksContext } from '@/lib/integrations/runbooks'
import {
    buildActiveCapabilityDoctrinesBlock,
    buildIntegrationsContextBlock,
    buildSubsystemsContextBlock,
} from '@/lib/integrations/exposure'
import { getAgentThread, listAgentThreadsForContext, type AgentThread } from '@/lib/db'
import { buildRuntimeAccessContext } from '@/lib/runtime-access'

// ---------------------------------------------------------------------------
// Artifact authoring guidance.
//
// Provider-neutral: instructs the model to emit artifact blocks for
// substantial standalone content. Kept as a shared helper so any text agent
// (orchestrator, multipurpose, future writer) can opt in identically.
// ---------------------------------------------------------------------------

const ARTIFACT_AUTHORING = `
<artifact_authoring>
When you produce substantial standalone content the user will read, save, or run separately from the chat — think recipes, explanations with diagrams, code files, runnable apps, charts — wrap it in an artifact tag. Inline chat prose stays in chat; the tag is for content that benefits from its own surface.

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
  - \`application/vnd.ant.recipe\` — a structured recipe rendered as a card with header, ingredient list (with live servings stepper + scaling), numbered steps with optional live timer chips, and notes. Body MUST be JSON (see <recipe_schema> below).
  - \`application/vnd.ant.mermaid\` — Mermaid diagrams
  - \`image/svg+xml\` — inline SVG markup
  - \`text/csv\` — comma-separated tables
  - \`application/json\` — JSON data
  - \`application/x-latex\` — standalone LaTeX
  - \`text/vnd.graphviz\` — Graphviz DOT
  - \`application/vnd.ant.code\` — a code snippet or file (set \`language\`)
  - \`text/html\` — a self-contained HTML page (runs in a sandboxed iframe)
  - \`application/vnd.ant.react\` — a self-contained React component (runs in a sandboxed iframe)
- \`title\`: short human-readable label.
- \`display\`: choose \`inline\` or \`panel\` yourself:
  - \`inline\` when the artifact is part of the answer the user should see in the chat flow: recipes, explanations, diagrams, charts, compact simulations or physics animations, small interactive demos, and small code/data snippets.
  - \`panel\` when the artifact is the main surface or would crowd the conversation: websites, games, dashboards, full apps, multi-screen HTML/React experiences, large files, or long code/data.

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

<when_to_use>
- Substantial standalone content (>20 lines or content the user would naturally save).
- Visual content (diagrams, charts, SVG).
- Code files the user will copy out or run.
- Interactive demos (HTML, React).

Don't artifact: short snippets that explain themselves inline, single sentences, or commentary about other artifacts.
</when_to_use>

<updating_vs_creating>
- Reuse the same \`identifier\` when iterating on existing content (the runtime records a new version automatically and writes a real backing file under the workspace \`artifacts/\` folder). If you are asked to modify a file-backed artifact and tool access is available, edit that file directly rather than reconstructing unrelated content from memory.
- Use a new \`identifier\` only when the user's request is for genuinely different content.
- Don't recap what you changed before the artifact — show the artifact, then explain inline if needed.
</updating_vs_creating>

<rules>
- Self-contained: an HTML/React artifact must run without external file references the runtime can't fulfill. Inline CSS, inline JS, no \`<script src=local-file>\`.
- For \`display="inline"\`, keep the artifact visually light in the chat: prefer transparent or host-friendly backgrounds, avoid full-page opaque shells unless the content truly needs them, and keep sizing compact/responsive.
- React artifacts: export a default component. Use only React + react-dom + libraries the runtime exposes via import maps (react, react-dom, lucide-react, recharts). Tailwind CSS is preloaded — use utility classes directly; don't import a stylesheet. Forms work but native modal alerts/prompts also work — pick whichever fits.
- HTML artifacts: include your own styles inline. If you need utility classes, add the Tailwind Play CDN yourself (\`<script src="https://cdn.tailwindcss.com"></script>\`) — it isn't auto-injected for HTML.
- SVG: inline markup, no external image refs. The runtime sanitises with DOMPurify.
- Don't nest artifact tags. Don't wrap an artifact in a code fence (see <critical_body_rules>).
</rules>

<recipe_schema>
For \`application/vnd.ant.recipe\`, the artifact body is a JSON object with this shape (TypeScript notation for clarity — emit JSON, not TS):

\`\`\`
{
  title: string;                          // required, ≤160 chars
  subtitle?: string;                       // ≤280 chars
  servings: {
    default: number;                       // required integer ≥1, the starting value
    min?: number; max?: number;            // optional bounds
    unitLabel?: string;                    // default "porții"; e.g. "felii", "pahare"
  };
  prepMinutes?: number;                    // active prep before cooking
  cookMinutes?: number;                    // time food is being cooked
  totalMinutes?: number;                   // total elapsed incl. rests; falls back to prep+cook
  difficulty?: 'usor' | 'mediu' | 'greu';
  imageQuery?: string;                     // search string used to fetch web images
  ingredients: Array<{
    amount?: number;                       // omit for "sare după gust"-style items
    unit?: 'g'|'kg'|'ml'|'cl'|'l'|'tsp'|'tbsp'|'bucata'|'buc'|'catel'|'catei'|'felie'|'felii'|'priza'|'varf'|'cana'|'capac';
    name: string;                          // required
    note?: string;                         // rendered as muted "(…)" aside
    scaleable?: boolean;                   // default true; false for items that don't scale linearly (1 frunză dafin, 1 ou într-un aluat mic)
    group?: string;                        // consecutive items with the same group render under that subheading ("Pentru sos:")
  }>;                                       // 1..60 items
  steps: Array<{
    title?: string;                        // short bolded action header
    body: string;                          // plain text or light markdown (no headings/code blocks)
    timerSeconds?: number;                 // 1..86400 — renders a live countdown chip
  }>;                                       // 1..40 items
  notes?: Array<{ heading?: string; bullets: string[] }>;
  attribution?: string;                    // recipe source (cookbook, site, chef)
}
\`\`\`

Rules:
- Units are METRIC ONLY (and Romanian count units). Never emit "oz", "cup", "lb", "fl oz" — the parser rejects them.
- If you write an \`amount\`, you MUST write a \`unit\`; if you write a \`unit\`, you MUST write an \`amount\`. Use neither for items like "sare după gust".
- \`scaleable: false\` for ingredients that don't double when servings double (single bay leaf, one egg in a small dough). Default \`true\`.
- \`timerSeconds\` ONLY for actual hands-off waits the user benefits from timing (sotat usturoi 2:30, fiert ou 8:00, dospit 60:00). Don't add a timer to "amestecă bine" or "serveşte cald".
- Scaleable quantities inside step \`title\` / \`body\` and inside note \`bullets\` MUST be wrapped in \`{{...}}\` so the renderer scales them with the servings stepper. Inside the braces write a single quantity in the form \`<number> <unit>\` or \`<low>-<high> <unit>\`, using the SAME metric units as the ingredient list. Examples:
    - "Păstrează {{120 ml}} din apa de fiert" → scales 120 ml × ratio
    - "Adaugă {{2-3 linguri}} de zahăr" → both ends scale
    - "Folosește {{0.5 catel}} usturoi" → scales fractional too
  Leave these as PLAIN TEXT (no braces) because they don't scale with portions:
    - times: "1 minut", "2-3 minute", "30 secunde"
    - oven temp: "180°C"
    - approximate / qualitative: "o priză de sare", "după gust", "câteva picături"
  When the body just refers to an ingredient already in the list, prefer naming it ("untul", "parmezanul") over restating the amount.
- \`imageQuery\` should be set for almost every recipe — it triggers the renderer to fetch attribution-clean photos from Wikimedia Commons and show them above the title. Use English search terms ("penne arrabbiata", "ciorbă de burtă", "ratatouille") rather than full sentences. Skip it only for very abstract dishes a search wouldn't find sensibly.
- Always include \`identifier\` and \`title\` attributes on the \`<artifact>\` tag. Use \`display="inline"\` unless the recipe is very long.
- Compose recipes as artifacts whenever the user asks for one — even simple ones. The card is the right surface; plain markdown is the fallback.
</recipe_schema>
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
// orchestrator, researcher, multipurpose, and concierge alike. Per-agent
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

Workspace context files (USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, MEMORY_DAY/<date>.md, AGENT_NEEDS.md, ONBOARDING.md, MONITORS.md, BOOT.md, and the integration runbook index) are loaded or listed live into your prompt below — treat them as current state, not a stale snapshot, and do not re-read them just to confirm what is already shown unless a block is marked [truncated] or you have specific reason to read a runbook or changed file during this turn. To change durable state you MUST write the file with tools; editing it only in your reasoning does not persist. Keep these files curated and compact: append meaningful actions and open loops, do not dump transcripts, and label uncertain entries as uncertain. \`.env.local\` is intentionally not loaded into prompt context; it is a runtime secret/config surface, not memory.

Agent needs backlog: when a task exposes a fixable system gap — missing capability, failed tool with no viable recovery, runtime blocker, integration gap, repo gap, documentation gap, or flaky test — call \`ReportAgentNeed\` if that tool is available. Report one concise entry with what was attempted, what is needed, and any workaround. Do not report ordinary missing user input, routine uncertainty, per-task todos, or secrets. If the tool is unavailable, return the blocker package to your parent or append a compact entry to AGENT_NEEDS.md only when you have file-write access.
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

If you are blocked by a missing capability, broken tool, runtime limitation, repo/documentation gap, or flaky behavior that should be fixed for future runs, call \`ReportAgentNeed\` when available before returning. Keep the report concrete and dedupable. If \`ReportAgentNeed\` is unavailable, include a compact "agent_need" section in your result so the parent can report it.
</sub_agent_collaboration>
`.trim()

export function buildSubAgentCollaboration(): string {
    return SUB_AGENT_COLLABORATION
}

/**
 * Build the tool reference block for an agent prompt.
 *
 * Format: name, description, then named parameters with types + required flag
 * + per-param description. Kept deliberately plain so providers map it well.
 */
export function buildToolsSection(ctx: PromptContext): string {
    const builtins = ctx.availableBuiltins ?? []
    if (ctx.availableTools.length === 0 && builtins.length === 0) return ''
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
        return [`- ${t.name}: ${t.description}`, params].join('\n')
    }).join('\n')
    const builtinDetails = builtins.length > 0
        ? [
            'Native provider built-ins enabled:',
            `- ${builtins.join(', ')}`,
            builtins.includes('web_search')
                ? '- web_search: use built-in web search directly for quick/current factual checks; delegate to researcher when the question needs exhaustive, cross-source, cross-language, market, legal/regulatory, medical/scientific, travel, or high-stakes evidence.'
                : '',
        ].filter(Boolean).join('\n')
        : ''

    return [
        '<runtime_tools>',
        'Tools available in this runtime:',
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
    if (a.id === 'browser_agent' || a.provider === 'browser') return 'active browser executor; prompt must be self-contained; use for interactive/visual/logged-in flows; can return screenshots/videos as uploads; stop at commit boundaries'
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

export function buildMediaPromptingGuide(): string {
    return `
<media_generation_guidance>
Use specialist media agents when the user asks for generated/edited media, or when another agent needs an asset to complete the task. The selected provider/model comes from Settings for that media agent. OpenAI is not a fallback for Google and Google is not a fallback for OpenAI; if Settings says OpenAI, prompt for the OpenAI image model and expect it to work. If Settings says Google, prompt for the Google model and expect it to work.

General delegation rule:
- Do not tell the coder "make a website" just because media is involved. Delegate to coder only when implementation work is needed. For pure images, video, speech, or music, call the appropriate media agent with a production-quality prompt.
- Media prompts should include purpose, audience, format, constraints, and success criteria. Avoid keyword piles. Use descriptive paragraphs and exact instructions.

Image generation and editing:
- Google image model: Nano Banana 2, \`gemini-3.1-flash-image-preview\`. OpenAI image model: \`gpt-image-2\`.
- Describe the scene, not just keywords. Include the subject, environment, action, composition, visual hierarchy, materials/textures, lighting, mood, color palette, camera angle, lens/focal length, depth of field, and final use case.
- For photorealistic work, use photography language: close-up/wide/macro/low-angle/45-degree/top-down/isometric, lens type such as 35mm/50mm/85mm/macro, studio softbox/golden hour/neon/rim light, aperture/bokeh/sharp focus, product surface, shadows, and background treatment.
- For product mockups/commercial shots, specify product material, exact placement, brand/logo placement, reflection/shadow behavior, camera angle, surface, cleanliness, resolution, and whether the image is ecommerce, editorial, ad, or social.
- For icons, stickers, and assets, specify style, outline weight, cel-shading/3D/tactile/flat/vector-like rendering, background color, and "no text" when text is not desired. Gemini image generation does not produce true transparent backgrounds; request white/solid background instead.
- For images containing text, write the exact visible text and describe the type style, placement, hierarchy, and layout. For professional text-heavy assets, prefer the higher-fidelity model selected in Settings. Best results often come from drafting the text first, then generating the image with that exact copy.
- For minimalist or negative-space images, explicitly say where the subject sits and where empty space must remain for overlay text.
- For sequential art/storyboards/comics, define number of panels, character continuity, scene progression, style, panel composition, speech text if any, and what should remain consistent across panels.
- For edits, provide the input image(s) plus a precise change list: what to add/remove/change, what must remain unchanged, and which region is being edited. Use semantic masking language such as "change only the blue sofa" or "keep the rest of the room unchanged."
- For style transfer, say to preserve composition, object placement, identity, and perspective while changing the rendering style. Do not ask for a living artist imitation when avoidable; describe visual traits instead.
- For multiple-reference composition, identify which reference supplies each element: subject, garment/product/logo, pose, background, lighting, color grade. For Gemini 3.1 Flash Image, up to 14 references are possible, with practical high-fidelity limits of up to 10 objects and 4 characters in one workflow.
- For high-fidelity faces, logos, products, or documents, describe critical details to preserve and explicitly say they must remain unchanged except for the requested edit.
- For sketches/rough drafts, say which lines/profile/proportions must be preserved and what finish to add: showroom photo, production concept art, polished UI, etc.
- Aspect ratio and image size matter. Common ratios: \`1:1\`, \`2:3\`, \`3:2\`, \`3:4\`, \`4:3\`, \`4:5\`, \`5:4\`, \`9:16\`, \`16:9\`, \`21:9\`; Gemini 3.1 Flash also supports \`1:4\`, \`4:1\`, \`1:8\`, \`8:1\`. Gemini image sizes are \`512\`, \`1K\`, \`2K\`, \`4K\` with uppercase K.
- Use Google Search/Web grounding when the image depends on current facts such as weather, recent events, charts, maps, or news. Use Image Search grounding only for accurate non-person visual references. Google Image Search grounding cannot be used to search for people, and generated grounded image outputs require source attribution in the UI/result.
- Use positive semantic negatives: instead of "no cars", write "an empty, deserted street with no signs of traffic." Still include critical exclusions when safety or brand constraints require them.

Video generation:
- Google video model: Veo 3.1, \`veo-3.1-generate-preview\`.
- Build the prompt like a shot brief: subject, action, location, time of day, visual style, camera position, camera movement, lens/focus, framing, pacing, lighting, atmosphere, color grade, and the intended emotional beat.
- Include audio direction. Veo can generate dialogue, sound effects, and ambient sound. Put spoken lines in quotes, identify the speaker, and describe delivery, background noise, music bed, or SFX explicitly.
- For cinematic realism, specify shot type and movement: close-up, medium shot, wide shot, dolly-in, handheld, locked-off, crane, tracking shot, rack focus, shallow depth of field, slow motion, etc.
- For animation or stylized video, specify style, material, rendering approach, motion quality, character design, and whether the motion should be smooth, snappy, stop-motion-like, clay-like, anime-like, or graphic.
- Specify output orientation when needed: \`16:9\` landscape or \`9:16\` portrait. Veo 3.1 supports 8-second videos and can target 720p, 1080p, or 4K depending on request/provider settings.
- Image-based direction can use up to three reference images. For first/last-frame generation, describe what changes between the frames and what should remain stable. For extension, describe continuity from the previous clip, not a new unrelated shot.

Speech/TTS generation:
- Google speech model: \`gemini-3.1-flash-tts-preview\`.
- TTS accepts text-only input and produces audio-only output. Begin with a clear instruction like "Synthesize speech from the transcript below" so director notes are not read aloud.
- Single speaker: choose or respect the selected voice, then write performance direction before the transcript. Multi-speaker: use exactly two named speakers; the speaker names in the transcript must exactly match the intended voices.
- The current user request wins over the saved TTS default. If the user asks for dialogue or two voices, author a two-speaker transcript even when Settings currently show single speaker. If the user asks for a monologue, author a single-speaker prompt even when Settings currently show multi speaker.
- Strong prompt structure: \`# AUDIO PROFILE\`, \`## THE SCENE\`, \`### DIRECTOR'S NOTES\`, \`#### TRANSCRIPT\`. Keep directions coherent with the transcript; do not overconstrain every syllable.
- Director notes can specify style, emotion, accent, pace, articulation, breathing, projection, energy, and relationship to the listener. Specific accents work better than broad labels.
- Use inline audio tags for local control: \`[whispers]\`, \`[shouting]\`, \`[laughs]\`, \`[giggles]\`, \`[sighs]\`, \`[gasp]\`, \`[short pause]\`, \`[excitedly]\`, \`[sarcastically]\`, \`[tired]\`, \`[curious]\`, \`[serious]\`, \`[very fast]\`, \`[very slow]\`.
- Available voice names include Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, and Sulafat.
- For longer speech, split transcripts into smaller chunks to reduce voice drift. If the model occasionally returns text/500 instead of audio, retrying is appropriate at the integration layer.

Music generation:
- Google music model: Lyria 3 Pro, \`lyria-3-pro-preview\`. This is the Pro/full-song path; do not treat it as a 30-second clip model unless the user asks for a short preview.
- Lead with genre and era: "early 90s hip-hop", "80s synth-pop", "modern EDM mixed with Europop", "cinematic orchestral", "lo-fi jazz hop", etc.
- Include instruments, timbre, production texture, BPM, key/scale, mood, energy curve, vocalist profile, language, and duration. Example details: warm Rhodes, dirty distorted bass, crisp hi-hats, analog pads, wall of fuzzy guitars, walking bass, D minor, 120 BPM.
- Structure matters. Use section tags and flow: \`[Intro]\` -> \`[Verse 1]\` -> \`[Chorus]\` -> \`[Verse 2]\` -> \`[Bridge]\` -> \`[Outro]\`. Describe crescendos, drops, silence, instrument entrances, and transitions.
- Timing can be explicit with timestamps, e.g. \`[0:00 - 0:10] Intro...\`, \`[0:30 - 0:50] Chorus...\`, or "the drop arrives at 22s."
- Lyrics: if the model should write lyrics, specify topic, point of view, language, chorus idea, and emotional arc. If providing custom lyrics, put them after a clear \`Lyrics:\` label and use section headers like \`[Verse]\`, \`[Chorus]\`, \`[Bridge]\`.
- Vocals: specify singer profile by range/timbre/delivery rather than named artists. Examples: crystalline female soprano, warm husky alto, bright male tenor, velvet baritone, raspy weathered rocker.
- For background/game/UI music, explicitly request "Instrumental only, no vocals." Otherwise vocals/lyrics may appear by default.

Safety and output expectations:
- All generated images/audio may include SynthID watermarking depending on provider. Respect rights for uploaded references, logos, likenesses, and copyrighted lyrics.
- Always return the generated artifact/audio/video/image with concise notes about any provider limitation that affected the result.
</media_generation_guidance>
`.trim()
}

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
    const nowDate = new Date()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    lines.push(`today: ${nowDate.toISOString().slice(0, 10)} (UTC date — MEMORY_DAY files are named by this)`)
    lines.push(`datetime_utc: ${nowDate.toISOString()}`)
    lines.push(`timezone: ${tz}`)
    lines.push(`local_time: ${nowDate.toLocaleString('en-CA', { timeZone: tz, hour12: false })} (resolve the user's relative dates/times against this)`)
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
    lines.push(`workspace_cwd: ${AGENT_WORKSPACE_DIR}`)
    lines.push(`file_tools_root: ${AGENT_WORKSPACE_DIR}`)
    lines.push(`runtime_state_dir: ${WORKSPACE_DIR}`)
    lines.push('filesystem_scope: relative file paths start in workspace_cwd. File tools reject paths outside that workspace unless a native CLI provider grants broader access; shell commands also start in workspace_cwd but may use host commands and absolute paths permitted by the runtime user.')
    lines.push('discovery_scope: file discovery tools may omit provider-private CLI metadata; shell command output is returned as produced by the command.')
    lines.push('workspace_files: these workspace files are intentionally accessible to every agent by exact path, relative to workspace_cwd (some are edited from dedicated Settings surfaces rather than the file editor):')
    const todayStamp = new Date().toISOString().slice(0, 10)
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
    }
    // Orchestrator-only surfaces: integrations + subsystems + active
    // doctrines all live next to each other so the model can see what
    // exists, what it has activated, and what's still gated. Sub-agents
    // don't need this surface — they receive their tools directly and
    // delegate composition back to the orchestrator.
    const isOrchestrator = ctx.agentId === 'orchestrator'
    return [
        runtime,
        buildAgentThreadsContextBlock(ctx),
        buildIntegrationsContextBlock(ctx.declaredToolIds ?? [], exposureOpts),
        // Native subsystems (watchlist, monitoring, scheduling) — orchestrator-
        // only. Sub-agents never schedule or set up monitors themselves.
        isOrchestrator ? buildSubsystemsContextBlock(exposureOpts) : '',
        // Lazy doctrines for activated capabilities (maps, weather, watchlist,
        // monitoring, scheduling, …). Empty until the orchestrator calls
        // ActivateIntegrationTools. Sits adjacent to <integrations>/<subsystems>
        // so the model sees the capability summary + its loaded doctrine
        // together.
        buildActiveCapabilityDoctrinesBlock(exposureOpts),
        buildIntegrationRunbooksContext(),
        buildWorkspaceContextFiles(ctx.agentId),
    ].filter(Boolean).join('\n\n')
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
    const updated = new Date(thread.updatedAt).toISOString()
    const runtime = [thread.provider, thread.model].filter(Boolean).join('/') || 'runtime not recorded yet'
    const summary = thread.summary ? `; summary="${compactForPrompt(thread.summary, 240)}"` : ''
    return `${thread.id}; agent=${thread.agentId}; title="${compactForPrompt(thread.title, 120)}"; updated=${updated}; runtime=${runtime}${summary}`
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
    'agents',
    'user',
    'identity',
    'boot',
    'memory',
    'memory-day',
    'monitors',
    'integration-index',
])

const MAX_CONTEXT_FILE_CHARS = 16_000
const MAX_CONTEXT_TOTAL_CHARS = 64_000

function readWorkspaceFile(relPath: string): string | null {
    const absolutePath = path.resolve(AGENT_WORKSPACE_DIR, relPath)
    if (absolutePath !== AGENT_WORKSPACE_DIR && !absolutePath.startsWith(AGENT_WORKSPACE_DIR + path.sep)) {
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

function buildWorkspaceContextFiles(agentId: string | undefined): string {
    const blocks: string[] = []
    let remaining = MAX_CONTEXT_TOTAL_CHARS

    // BOOT.md and ONBOARDING.md are the user-facing onboarding script —
    // only the orchestrator runs onboarding. Sub-agents (researcher,
    // multipurpose, concierge, etc.) get the durable context files
    // (USER/IDENTITY/MEMORY/MEMORY_DAY) but skip the onboarding script
    // so it doesn't bloat their prompts every turn while BOOT.md exists.
    const isOrchestrator = agentId === 'orchestrator'

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
        if (!isOrchestrator && (file.id === 'boot' || file.id === 'onboarding')) continue
        if (remaining <= 0) break

        if (file.id === 'memory-day') {
            // Rolling daily memory: today + the previous 2 UTC days, oldest
            // first so the agent reads the progression up to now.
            for (let back = 2; back >= 0; back--) {
                if (remaining <= 0) break
                const stamp = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10)
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
        if (file.id !== 'boot' && file.defaultContent && trimmed === file.defaultContent.trim()) continue

        if (!pushBlock(file.relativePath, file.id, content)) break
    }

    if (blocks.length === 0) return ''

    return [
        '<workspace_context_files>',
        'These user-managed context files are loaded LIVE from the workspace on every turn — they are current state, not a stale snapshot. Treat them as durable user/project context. Do not spend a tool call re-reading one just to confirm what is already shown here; only read from disk when a block is marked [truncated] or you have specific reason to think it changed mid-turn. To change durable state you must write the file with tools (see <safety_core>) — an in-context edit alone does not persist. Higher-priority runtime instructions and the current user message still win on conflict.',
        'Use BOOT.md only while it exists. Use ONBOARDING.md to resume long onboarding across conversations. If onboarding is completed or skipped, consolidate useful durable information into USER.md, IDENTITY.md, MEMORY.md, MONITORS.md, and config.json when app-level display names changed; mark ONBOARDING.md complete/skipped; then remove BOOT.md.',
        "Daily working memory lives at MEMORY_DAY/<UTC-date>.md (the date is in runtime_context `today`). Append meaningful actions, design discussions, external/physical actions, and open loops to today's file. If MONITORS.md or MEMORY.md records a model-owned consolidation preference, an existing scheduled/monitor wake after local midnight may consolidate the day that just ended; suggested wall-clock times are guidance, not a hard-coded runtime contract. Use MEMORY.md only for durable facts worth carrying forward. AGENT_NEEDS.md is the operational backlog for missing capabilities/tool/runtime gaps; prefer ReportAgentNeed over manual edits. MONITORS.md documents preferences/specs and scheduledTaskIds; an active monitor still requires an actual scheduled task.",
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
