import fs from "fs"
import path from "path"
import { createHash, randomUUID } from "crypto"
import { z } from "zod"

import { getConfig } from "@/lib/config"
import {
  activeRuntimePaths,
  runtimePathsForProfile,
} from "@/lib/runtime-paths"
import {
  getActiveProfileId,
  isAdminProfileId,
} from "@/lib/profiles/context"
import { ADMIN_PROFILE_ID } from "@/lib/profiles/constants"
import { getProfile } from "@/lib/profiles/store"
import {
  AGENT_NEEDS_DEFAULT_CONTENT,
  AGENT_NEEDS_RELATIVE_PATH,
} from "@/lib/agent-needs"
import {
  INTEGRATION_INDEX_DEFAULT_CONTENT,
  INTEGRATION_INDEX_PATH,
  INTEGRATION_RUNBOOKS,
} from "@/lib/integrations/runbooks"
import { LiveRegistrySchema, ThinkingLevelSchema } from "@/lib/models/schema"
import {
  getEffectiveRegistry,
  invalidateRegistryCache,
} from "@/lib/models/registry"
import { emitAppEvent } from "@/lib/events"
import {
  mergeMissingEnvDefaults,
  mergeRedactedEnvSubmission,
  parseEnvAssignment,
  parseEnvStoredValue,
  redactEnvContent,
  syncWorkspaceEnvToProcess,
  type WorkspaceEnvValue,
} from "@/lib/settings/workspace-files-env"
import { dateStampInTimezone } from "@/lib/timezone"

type WorkspaceFileKind = "json" | "env" | "markdown"
type WorkspaceFileSource = "physical" | "virtual"

/**
 * Semantic grouping used by the Settings file editor. Agents still see every
 * definition by path (see buildRuntimeContext); the category only drives how
 * the human-facing editor groups and labels files.
 */
export type WorkspaceFileCategory =
  | "knowledge"
  | "behavior"
  | "integrations"
  | "onboarding"
  | "system"
  | "models"

/**
 * `editor` files are shown in the Settings file editor. `reference` files stay
 * in the data model (agents and the prompt builder still rely on them) but are
 * intentionally not editable in the UI because a dedicated surface owns them
 * (the Models tab owns config + the model registry).
 */
export type WorkspaceFileSurface = "editor" | "reference"

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
  /** When 'daily', this id is a directory; reads/writes resolve to today's configured-local file (MEMORY_DAY/<YYYY-MM-DD>.md). */
  dynamic?: "daily"
  defaultContent?: string
}

export interface WorkspaceFileSummary extends WorkspaceFileDefinition {
  exists: boolean
  size: number | null
  updatedAt: number | null
  dailyDate?: string
  inherited?: boolean
}

export interface WorkspaceFilePayload extends WorkspaceFileSummary {
  content: string
  contentRedacted?: boolean
}

export type { WorkspaceEnvValue } from "@/lib/settings/workspace-files-env"

const MAX_FILE_BYTES = 512 * 1024
const MEMORY_EXPORT_VERSION = 1
const MEMORY_EXPORT_MAX_FILE_BYTES = MAX_FILE_BYTES
const MEMORY_EXPORT_MAX_TOTAL_BYTES = 5 * 1024 * 1024
const DAILY_MEMORY_ID = "memory-day"
const DAILY_MEMORY_ID_PREFIX = `${DAILY_MEMORY_ID}:`
const DAILY_MEMORY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/

const MEMORY_FILE_IDS = [
  "user",
  "memory",
  "memory-archive",
  "memory-day",
  "monitors",
  "playbooks",
  "boot",
  "onboarding",
] as const

export interface MemoryExportFile {
  id: string
  relativePath: string
  label: string
  content: string
}

export interface MemoryExportBundle {
  version: typeof MEMORY_EXPORT_VERSION
  exportedAt: string
  app: "orchestrator"
  files: MemoryExportFile[]
}

export interface MemoryImportResult {
  importedFiles: Array<{ id: string; relativePath: string; size: number }>
}

const AppConfigFileSchema = z
  .object({
    assistantName: z.string(),
    userName: z.string(),
    timezone: z.string().min(1).optional(),
    activeProvider: z.string().min(1),
    activeModel: z.string().min(1),
    thinkingLevel: ThinkingLevelSchema,
    agentOverrides: z.record(
      z.string(),
      z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
        thinkingLevel: ThinkingLevelSchema.optional(),
        modelOptions: z
          .record(z.string(), z.union([z.boolean(), z.string(), z.number()]))
          .optional(),
      })
    ),
    agentOrder: z.array(z.string()).optional(),
    browserAgent: z
      .object({
        backend: z.literal("patchright").optional(),
        light: z.object({
          provider: z.string().min(1),
          model: z.string().min(1),
          thinkingLevel: ThinkingLevelSchema,
          modelOptions: z
            .record(z.string(), z.union([z.boolean(), z.string(), z.number()]))
            .optional(),
        }),
        pro: z.object({
          provider: z.string().min(1),
          model: z.string().min(1),
          thinkingLevel: ThinkingLevelSchema,
          modelOptions: z
            .record(z.string(), z.union([z.boolean(), z.string(), z.number()]))
            .optional(),
        }),
      })
      .optional(),
    favorites: z.array(z.string()),
    updatedAt: z.number(),
  })
  .passthrough()

export const WORKSPACE_FILE_DEFINITIONS: WorkspaceFileDefinition[] = [
  {
    id: "user",
    label: "User",
    relativePath: "USER.md",
    kind: "markdown",
    category: "knowledge",
    surface: "editor",
    description:
      "Stable facts, preferences, constraints, accounts, places, and personal operating context for the user.",
    defaultContent: [
      "# USER",
      "",
      "Stable user knowledge goes here.",
      "",
      "Keep only information that should help future requests. Prefer durable preferences, recurring constraints, trusted defaults, important places, important people, account/service preferences, health or legal constraints the user explicitly wants remembered, and communication style.",
      "",
    ].join("\n"),
  },
  {
    id: "boot",
    label: "Boot onboarding",
    relativePath: "BOOT.md",
    kind: "markdown",
    category: "onboarding",
    surface: "editor",
    description:
      "Temporary onboarding script. When completed, the agent should consolidate what it learned and remove this file.",
    defaultContent: [
      "# BOOT",
      "",
      "Purpose: run initial user onboarding.",
      "",
      "When this file exists, the orchestrator should prioritize learning enough about the user to become useful as a personal operator. Onboarding can be long and can span multiple conversations. Use ONBOARDING.md to remember progress, resume from the next unfinished stage, and keep moving stage by stage until onboarding is complete or the user explicitly skips/stops it. Run onboarding as a short staged conversation instead of one monolithic questionnaire: ask a small logical group of high-leverage questions, wait for the user reply, record progress, then continue with the next group. Keep the tone conversational, friendly, and helpful. Do not ask for secrets, passwords, recovery codes, payment details, government identifiers, or unnecessary sensitive data.",
      "",
      "Onboarding flow:",
      "1. Start with a brief welcome and explain that setup will be split into a few small parts so it stays easy to answer.",
      "2. Ask 2-4 focused questions per turn, grouped by topic. Let the user skip anything.",
      "3. Move through the stages naturally based on the answers; do not dump every question at once.",
      "4. After finishing one stage, update ONBOARDING.md and proceed to the next unfinished stage unless the user is clearly switching tasks.",
      "5. If the user starts a different conversation or task while onboarding is active, handle that task first, then resume onboarding from ONBOARDING.md when it is natural and low-friction.",
      "6. Keep temporary onboarding progress in ONBOARDING.md or daily memory if needed, but wait to update config.json, USER.md, and MEMORY.md until the user has answered enough or chooses to stop.",
      '7. If the user says skip/stop/not now for onboarding, force-finish onboarding: consolidate known durable facts, record missing non-blocking fields in ONBOARDING.md or MEMORY.md as "ask opportunistically later", set ONBOARDING.md Status to skipped, and remove BOOT.md.',
      "8. Ask follow-up questions only for genuine blockers or contradictions.",
      "",
      "Suggested stages:",
      "1. Identity and assistant style: preferred user name, language, assistant name, and how the assistant should sound or behave (for example professional, concise, warm, direct, proactive, low-interruption, or more explanatory).",
      "2. Work and daily context: location/timezone, frequent cities, home/work or common commute anchors if the user wants them saved, work context, projects, tools, repositories, and preferred ways to collaborate.",
      "3. Communication and operating preferences: channels the user cares about, what counts as urgent, calendar/reminder preferences, quiet hours, shopping, food, transport, delivery, booking, and travel defaults.",
      '4. Proactive monitoring: explain silent-until-noteworthy monitors in plain language. Recommended default: check about every 15 minutes, adaptively slow down when quiet, speed back up when activity returns, and notify only when important. Ask whether the user prefers important-only Inbox items, summaries at specific times, or both. Ask what "important" means for Gmail/WhatsApp/Home Assistant.',
      "5. Boundaries and confirmation preferences: ask which classes of action the user always wants asked about before you act (e.g. logged-in dashboard navigation, runtime credential storage, free signup flows), and any service-specific exceptions. The hard confirmation boundary (payments, sends, account/security changes, legal acceptance, destructive actions, sensitive uploads) is always asked regardless — never ask the user to opt out of it. Record durable preferences as plain notes in USER.md/MEMORY.md, not as a tier label.",
      "6. Browser profile setup: ask whether the user wants to configure the browser agent now. If yes, use browser_agent to open the managed browser profile and yield control so the user can sign in to Chrome/Google or key web services themselves. Ask which accounts/sites may be reused later, whether free setup/login/API-key flows may use existing sessions automatically, and which situations should always ask first. Do not ask for or store passwords, recovery codes, or 2FA codes.",
      "7. Integrations and optional capabilities: walk the user through the live <integrations> block in plain language. State each one's connection state, ask which to set up now versus later, and for each chosen one follow its runbook from <integration_runbooks> — do not duplicate setup steps here. Be especially proactive about Gmail, WhatsApp, and read-only Home Assistant monitoring; they unlock high-value personal-operator workflows. Treat Maps and Weather as ordinary integrations: Weather works out of the box (Open-Meteo, keyless); Maps and the Google Weather/AQ/Pollen upgrades share one optional Google Maps Platform key (free $200/month credit). The maps and weather runbooks carry the exact provider-console steps. Offer Location Intelligence only as an explicit opt-in: explain local Home Assistant location journaling, raw points in points.jsonl, stays inferred from webhook gaps, daily summaries, Library Places Places/Raw views, privacy implications, finite retention versus keep everything, and Maps mode choices before enabling anything. Also offer the Watchlist financial-data key (TWELVE_DATA_API_KEY, free tier) when the user expresses interest in markets. When Home Assistant is connected, identify the `person.*`/`device_tracker.*` entity that represents the user and save it as the default Smart Maps location source (see the home-assistant runbook).",
      "",
      "Discover:",
      "- preferred user name and language;",
      "- what name the user wants to give the assistant;",
      "- preferred assistant style/personality, including tone, verbosity, proactivity, and how much explanation the user wants by default;",
      "- location, timezone, frequent cities, travel defaults, and optional home/work commute anchors. Infer the IANA timezone from explicit location, browser/host runtime, calendar/home-assistant metadata, or user wording when reliable; otherwise ask. Save the final timezone to config.json as `timezone`;",
      "- work context, projects, tools, repositories, and preferred ways to collaborate;",
      "- communication channels the user cares about and what counts as urgent;",
      "- proactive monitoring preference: default 15-minute adaptive checks versus fixed cadence, important-only Inbox notifications versus timed summaries, and quiet hours;",
      "- Gmail monitoring rules: urgent/VIP/action-needed criteria, digest timing, and whether the user wants a first-week spam/offers cleanup review for main-inbox emails with quick archive/keep choices before any archiving automation;",
      "- WhatsApp monitoring rules: contacts/chats that matter, urgency criteria, quiet hours, and whether to notify immediately or summarize;",
      "- Home Assistant monitoring rules: read-only sensors/devices/problems worth watching, alert thresholds, actions that always need explicit confirmation, and the saved `person.*` or `device_tracker.*` entity inferred as the user's live location when one exists;",
      '- optional Location Intelligence preference: whether the user wants Home Assistant location journaling at all, which source entity to use, whether raw points should be preserved in `points.jsonl`, retention (`retentionDays` or `retention: "forever"` / keep everything), Maps mode (`strict`, `balanced`, or `relaxed`), and privacy boundaries for home/work labels;',
      "- shopping, food, transport, delivery, and booking preferences;",
      "- calendar/reminder preferences and quiet hours;",
      "- privacy boundaries and what the assistant must never do without explicit confirmation;",
      "- confirmation preferences: which classes of reversible action (logged-in dashboard navigation, runtime credential storage, free signup flows, existing-session reuse) the user wants asked about every time, and which can proceed without asking. The hard confirmation boundary is always asked regardless;",
      "- browser agent setup preference: whether to open the managed browser during onboarding for manual login, which accounts/sites may be reused, and whether future free setup/login/API-key flows can proceed automatically until the consent boundary;",
      "- which available integrations the user cares about, what they should be used for, and whether the user wants to set any of them up now or later;",
      "- whether the user wants help setting up optional external API keys: `TWELVE_DATA_API_KEY` (Watchlist financial data, free tier) and `GOOGLE_MAPS_API_KEY` (interactive maps, geocoding/Places/Routes + Google Weather/AQ/Pollen upgrades, $200/month free credit). Exact setup steps live in the maps and weather runbooks;",
      "- whether the user wants optional Location Intelligence set up. Do not enable tracking unless they opt in and choose retention/privacy/Maps settings;",
      "- whether the user wants the assistant to use browser automation for free signup/login/setup flows by default, while still stopping before payments, subscriptions, paid trials, permission grants, legal-term acceptance, destructive actions, public sharing, or submitting sensitive personal documents/data unless the exact action is confirmed;",
      "- any stable constraints the user explicitly wants remembered.",
      "",
      "After onboarding is complete:",
      '1. Update config.json with userName, assistantName, and timezone when known; keep defaults as "User", "Orchestrator", and the detected system timezone if not specified.',
      "2. Update USER.md with stable facts and preferences, including assistant style/setup facts learned during onboarding (assistant name, style, operating boundaries).",
      "3. Update MEMORY.md with durable operating conclusions.",
      "4. Update ONBOARDING.md with Status complete or skipped and any missing fields that should be asked opportunistically later.",
      "5. Store confirmation preferences, browser-agent profile preferences, and service-specific exceptions as non-secret memory only; never store passwords, 2FA, recovery codes, cookies, or API key values in markdown.",
      "6. Remove BOOT.md so onboarding does not run again.",
      "",
    ].join("\n"),
  },
  {
    id: "onboarding",
    label: "Onboarding progress",
    relativePath: "ONBOARDING.md",
    kind: "markdown",
    category: "onboarding",
    surface: "editor",
    description:
      "Long-running onboarding progress, pending stages, and missing information to ask opportunistically later.",
    defaultContent: [
      "# ONBOARDING",
      "",
      "Status: active",
      "Last stage: not_started",
      "Next stage: identity_and_style",
      "",
      "Use this file to resume onboarding across conversations. Keep it compact: completed stages, pending stages, temporary answers not yet consolidated, and missing information to ask later.",
      "",
      "## Completed",
      "",
      "## Pending",
      "- identity_and_style",
      "- work_and_daily_context",
      "- communication_and_urgency",
      "- proactive_monitoring",
      "- boundaries_and_confirmations",
      "- browser_profile",
      "- integrations",
      "",
      "## Missing Later",
      "",
    ].join("\n"),
  },
  {
    id: "memory",
    label: "Long memory",
    relativePath: "MEMORY.md",
    kind: "markdown",
    category: "knowledge",
    surface: "editor",
    description:
      "Permanent consolidated memory. Updated deliberately with durable, future-useful facts.",
    defaultContent: [
      "# MEMORY",
      "",
      "Permanent memory belongs here.",
      "",
      "Keep this file compact. Store durable facts, recurring preferences, standing instructions, long-running goals, and decisions that should affect future behavior. Do not store one-off chatter, temporary state, unverified assumptions, or sensitive data unless the user explicitly wants it remembered.",
      "",
    ].join("\n"),
  },
  {
    id: "memory-archive",
    label: "Memory archive",
    relativePath: "MEMORY_ARCHIVE.md",
    kind: "markdown",
    category: "knowledge",
    surface: "editor",
    description:
      "Cold long-term memory: durable facts demoted from MEMORY.md because they are rarely needed day-to-day. Never injected into the prompt, but indexed for semantic recall, so demotion is lossless.",
    defaultContent: [
      "# MEMORY ARCHIVE",
      "",
      "Cold storage for durable memory. The nightly reflection moves rarely-used durable facts here from MEMORY.md to keep the always-loaded memory lean.",
      "",
      "This file is NOT loaded into the prompt every turn. It is indexed for semantic recall, so anything here still surfaces when a message is relevant to it. Promote a fact back to MEMORY.md when it becomes routinely relevant again. Keep entries compact and durable; never store secrets or transient state.",
      "",
    ].join("\n"),
  },
  {
    id: "memory-day",
    label: "Daily memory",
    // Directory, not a single file: one note per configured-local day at
    // MEMORY_DAY/<YYYY-MM-DD>.md. resolveDefinitionPath / summarizeFile /
    // getWorkspaceFile resolve "today"; the editor shows today's note.
    relativePath: "MEMORY_DAY",
    kind: "markdown",
    category: "knowledge",
    surface: "editor",
    dynamic: "daily",
    description:
      "Today's working memory. One file per day under MEMORY_DAY/; agents append actions and open loops to the current day.",
  },
  {
    id: "agent-needs",
    label: "Agent needs",
    relativePath: AGENT_NEEDS_RELATIVE_PATH,
    kind: "markdown",
    category: "behavior",
    surface: "editor",
    description:
      "Operational backlog of missing capabilities, failed tools, runtime blockers, and repo/documentation gaps reported by agents.",
    defaultContent: AGENT_NEEDS_DEFAULT_CONTENT,
  },
  {
    id: "monitors",
    label: "Monitors",
    relativePath: "MONITORS.md",
    kind: "markdown",
    category: "behavior",
    surface: "editor",
    description:
      "Proactive monitoring preferences, candidate monitor specs, recurring check prompts, and active Smart Monitor watch ids.",
    defaultContent: [
      "# MONITORS",
      "",
      "Document proactive monitoring preferences, candidate monitor specs, recurring check prompts, and active Smart Monitor watch ids here.",
      "",
      "A Smart Monitor entry is active only when it has a runtime watchId. Notes in this file are not automation by themselves. The only scheduledTaskId expected here is the single consolidated Smart Monitor heartbeat when useful for audit.",
      "",
      "Each entry should define status, watchId when active, what to check, cadence/check timing, sources/connectors or custom scope, check prompt, notify threshold, whether the user wants important-only Inbox messages or timed summaries, and when to stay silent.",
      "",
    ].join("\n"),
  },
  {
    id: "playbooks",
    label: "Playbooks",
    relativePath: "PLAYBOOKS.md",
    kind: "markdown",
    category: "knowledge",
    surface: "editor",
    description:
      "Reusable procedures distilled from complex tasks the user guided once: a trigger, the ordered steps with the tools/sub-agents used, and the parameters to fill on replay.",
    defaultContent: [
      "# PLAYBOOKS",
      "",
      "Reusable, distilled procedures live here. When the user guides you through a complex multi-step task that is likely to recur, save it as a compact playbook so next time is one step instead of many.",
      "",
      "Each playbook should have: a short title, a trigger phrase (how a future request will sound), the ordered steps you actually ran (noting the tool, integration, or sub-agent and any decision branch), and the run-specific values replaced by named {{parameters}}. Keep this file curated: merge near-duplicates and delete playbooks that stopped working.",
      "",
      "A playbook is a guide you execute with judgment, not a rigid script, and not an automation that runs itself. For work that should fire on a schedule or condition without the user asking, use Scheduling, Microscripts, or Smart Monitor instead.",
      "",
    ].join("\n"),
  },
  {
    id: "integration-index",
    label: "Integrations",
    relativePath: INTEGRATION_INDEX_PATH,
    kind: "markdown",
    category: "integrations",
    surface: "editor",
    description: "Index and operating rules for service integration runbooks.",
    defaultContent: INTEGRATION_INDEX_DEFAULT_CONTENT,
  },
  ...INTEGRATION_RUNBOOKS.map(
    (runbook): WorkspaceFileDefinition => ({
      id: `integration-${runbook.id}`,
      label: runbook.label,
      relativePath: runbook.relativePath,
      kind: "markdown",
      category: "integrations",
      surface: "editor",
      description: runbook.description,
      defaultContent: runbook.defaultContent,
    })
  ),
  {
    id: "app-config",
    label: "Config",
    relativePath: "config.json",
    kind: "json",
    category: "system",
    surface: "reference",
    description:
      "Global defaults, app timezone, per-agent model overrides, agent order, favorites, and app-level preferences. Edited from the Models tab.",
  },
  {
    id: "env-local",
    label: "Env",
    relativePath: ".env.local",
    kind: "env",
    category: "system",
    surface: "editor",
    description: "Local variables and provider keys.",
    defaultContent: [
      "GEMINI_API_KEY=",
      "OPENAI_API_KEY=",
      "ANTHROPIC_API_KEY=",
      "OPENROUTER_API_KEY=",
      "",
      "ORCHESTRATOR_PUBLIC_URL=",
      "ORCHESTRATOR_LAN_ORIGIN=",
      "ORCHESTRATOR_SSH_USER=",
      "ORCHESTRATOR_SSH_HOST=",
      "ORCHESTRATOR_HOST_LAN_IP=",
      "",
      "GOOGLE_OAUTH_CLIENT_ID=",
      "GOOGLE_OAUTH_CLIENT_SECRET=",
      "GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI=",
      "GMAIL_OAUTH_REDIRECT_URI=",
      "",
      "HOME_ASSISTANT_URL=",
      "HOME_ASSISTANT_TOKEN=",
      "",
      "TWELVE_DATA_API_KEY=",
      "GOOGLE_MAPS_API_KEY=",
      "GOOGLE_MAPS_MAP_ID=",
      "",
      "ORCHESTRATOR_UPDATE_GITHUB_TOKEN=",
      "",
    ].join("\n"),
  },
  {
    id: "models-api",
    label: "API models",
    relativePath: "api-models.json",
    kind: "json",
    category: "models",
    surface: "reference",
    description:
      "Raw model catalog discovered from provider APIs and local CLIs. Managed from the Models tab.",
    defaultContent:
      JSON.stringify({ version: 1, providers: {} }, null, 2) + "\n",
  },
  {
    id: "models-current",
    label: "Current models",
    relativePath: "current-models.json",
    kind: "json",
    category: "models",
    surface: "reference",
    description:
      "Generated view of every non-archived model currently available to the app.",
    readOnly: true,
    source: "virtual",
  },
  {
    id: "models-archived",
    label: "Archived models",
    relativePath: "archived-models.json",
    kind: "json",
    category: "models",
    surface: "reference",
    description:
      "Generated view of every archived model currently hidden from normal model pickers.",
    readOnly: true,
    source: "virtual",
  },
]

export function listWorkspaceFiles(): WorkspaceFileSummary[] {
  return WORKSPACE_FILE_DEFINITIONS.flatMap((def) =>
    def.dynamic === "daily" ? listDailyFileSummaries(def) : [summarizeFile(def)]
  ).filter((summary) => shouldListFile(summary))
}

const WORKSPACE_INIT_MARKER = ".workspace-initialized"

/**
 * Files the materializer keeps present: editor-surface markdown notes plus the
 * rolling daily memory file. Excludes .env.local (user-owned secrets), the
 * virtual/reference model + config files, and BOOT (first-run only — see below).
 */
function isMaterializable(def: WorkspaceFileDefinition): boolean {
  if (def.id === "boot") return false
  if (def.id === "onboarding") return false
  if (def.source === "virtual") return false
  if (def.surface === "reference") return false
  if (def.kind === "env") return false
  return Boolean(def.defaultContent) || def.dynamic === "daily"
}

/**
 * Per-install record of the scaffold signature each materialized file was
 * created with: { "<relativePath>": "<sha256 of the trimmed default>" }.
 *
 * The prompt builder skips workspace files the user never touched, so an empty
 * template adds no prompt noise. Comparing live content against the *current*
 * code default is brittle: when a default's text changes in a later release,
 * an already-materialized untouched file (still holding the OLD default) no
 * longer matches and silently starts leaking into every prompt. Freezing the
 * signature at write time keeps "untouched" stable across template edits, with
 * no hardcoded history of past defaults to maintain.
 */
const SCAFFOLD_HASHES_FILE = ".workspace-templates.json"

function agentWorkspaceDir(): string {
  return activeRuntimePaths().agentWorkspaceDir
}

function scaffoldHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex")
}

export function readScaffoldHashes(
  root: string = agentWorkspaceDir()
): Record<string, string> {
  try {
    const raw = fs.readFileSync(
      /* turbopackIgnore: true */ path.join(root, SCAFFOLD_HASHES_FILE),
      "utf-8"
    )
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>
      )) {
        if (typeof value === "string") out[key] = value
      }
      return out
    }
  } catch {
    // Missing or malformed: treat as no recorded scaffolds.
  }
  return {}
}

/**
 * True when `trimmedContent` still equals the scaffold this install wrote for
 * `def`. Prefers the signature frozen at materialization time; falls back to
 * the live default for files/installs that predate the manifest.
 */
export function isUntouchedScaffold(
  def: WorkspaceFileDefinition,
  trimmedContent: string,
  hashes: Record<string, string>
): boolean {
  const recorded = hashes[def.relativePath]
  if (recorded) return scaffoldHash(trimmedContent) === recorded
  const liveDefault = def.defaultContent?.trim()
  return Boolean(liveDefault) && trimmedContent === liveDefault
}

/**
 * Freeze the scaffold signature of any materialized file that still equals the
 * current default and has no recorded signature yet — fresh writes, plus a
 * backfill for installs that predate the manifest or were just reset. Never
 * overwrites an existing entry, so a later default-text change cannot rewrite
 * an install's frozen signature. Best effort: failures never block a build.
 */
function recordScaffoldHashes(
  root: string,
  defs: WorkspaceFileDefinition[]
): void {
  const hashes = readScaffoldHashes(root)
  let changed = false
  for (const def of defs) {
    if (def.dynamic === "daily" || !def.defaultContent) continue
    if (hashes[def.relativePath]) continue
    try {
      const target = resolveDefinitionPath(def)
      if (!fs.existsSync(/* turbopackIgnore: true */ target)) continue
      const current = fs
        .readFileSync(/* turbopackIgnore: true */ target, "utf-8")
        .trim()
      if (current !== def.defaultContent.trim()) continue
      hashes[def.relativePath] = scaffoldHash(def.defaultContent)
      changed = true
    } catch {
      // Best effort per file.
    }
  }
  if (!changed) return
  try {
    writeTextAtomic(
      path.join(root, SCAFFOLD_HASHES_FILE),
      `${JSON.stringify(hashes, null, 2)}\n`
    )
  } catch {
    // Best effort: a failed manifest write must not block the request.
  }
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
  const root = agentWorkspaceDir()
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ root, { recursive: true })
  } catch {
    return
  }

  const standard = WORKSPACE_FILE_DEFINITIONS.filter(isMaterializable)
  const markerPath = path.join(root, WORKSPACE_INIT_MARKER)
  const markerExists = fs.existsSync(markerPath)
  const anyStandardExists = standard.some((def) => {
    try {
      return fs.existsSync(
        /* turbopackIgnore: true */ resolveDefinitionPath(def)
      )
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
      const content =
        def.dynamic === "daily"
          ? buildDailyMemoryTemplate()
          : (def.defaultContent ?? "")
      if (!content) continue
      writeTextAtomic(target, content)
    } catch {
      // Best effort: a failed template write must not block the request.
    }
  }

  if (firstRun) {
    for (const id of ["boot", "onboarding"]) {
      const def = getDefinition(id)
      if (!def?.defaultContent) continue
      try {
        const target = resolveDefinitionPath(def)
        if (!fs.existsSync(/* turbopackIgnore: true */ target))
          writeTextAtomic(target, def.defaultContent)
      } catch {
        // ignore
      }
    }
  }

  // Freeze each materialized file's scaffold signature so a future change to a
  // default's text cannot make an untouched template leak into prompts.
  recordScaffoldHashes(root, standard)

  if (!markerExists) {
    try {
      writeTextAtomic(markerPath, `initialized ${new Date().toISOString()}\n`)
    } catch {
      // ignore
    }
  }
}

export function resetWorkspaceFilesToInitialState(opts?: {
  preserveEnvLocal?: boolean
}): {
  preservedEnvLocal: boolean
} {
  const preserveEnvLocal = opts?.preserveEnvLocal ?? true
  const envDef = getDefinition("env-local")
  let envContent: string | null = null

  if (preserveEnvLocal && envDef) {
    try {
      const envPath = resolveDefinitionPath(envDef)
      if (fs.existsSync(/* turbopackIgnore: true */ envPath)) {
        envContent = fs.readFileSync(
          /* turbopackIgnore: true */ envPath,
          "utf-8"
        )
      }
    } catch {
      envContent = null
    }
  }

  const root = agentWorkspaceDir()

  fs.rmSync(/* turbopackIgnore: true */ root, {
    recursive: true,
    force: true,
  })
  fs.mkdirSync(/* turbopackIgnore: true */ root, {
    recursive: true,
  })

  for (const def of WORKSPACE_FILE_DEFINITIONS) {
    if (def.source === "virtual" || def.surface !== "editor") continue
    if (def.kind === "env") {
      const content = mergeMissingEnvDefaults(
        envContent ?? def.defaultContent ?? "",
        def.defaultContent ?? ""
      )
      writeTextAtomic(resolveDefinitionPath(def), content, 0o600)
      continue
    }

    const content =
      def.dynamic === "daily"
        ? buildDailyMemoryTemplate()
        : (def.defaultContent ?? "")
    if (!content) continue
    writeTextAtomic(resolveDefinitionPath(def), content)
  }

  try {
    writeTextAtomic(
      path.join(root, WORKSPACE_INIT_MARKER),
      `initialized ${new Date().toISOString()}\n`
    )
  } catch {
    // ignore
  }

  return { preservedEnvLocal: envContent !== null }
}

export function resetWorkspaceMemoryToInitialState(): { resetFiles: string[] } {
  const resetFiles: string[] = []

  for (const id of MEMORY_FILE_IDS) {
    const def = getDefinition(id)
    if (!def || def.source === "virtual" || def.surface !== "editor") continue

    if (def.dynamic === "daily") {
      const dailyDir = resolveDailyMemoryDir(def)
      fs.rmSync(/* turbopackIgnore: true */ dailyDir, {
        recursive: true,
        force: true,
      })
      const todayPath = resolveDefinitionPath(def, appDateStamp())
      writeTextAtomic(todayPath, buildDailyMemoryTemplate())
      resetFiles.push(dailyMemoryRelativePath())
      continue
    }

    const content = def.defaultContent ?? ""
    if (!content) continue
    writeTextAtomic(resolveDefinitionPath(def), content)
    resetFiles.push(def.relativePath)
  }

  emitAppEvent({ type: "settings.changed", reason: "memory" })
  return { resetFiles }
}

export function resetWorkspaceEnvToInitialState(): { reset: boolean } {
  const def = getDefinition("env-local")
  if (!def) return { reset: false }
  const previousContent = readExistingDefinitionContent(def)
  const nextContent = def.defaultContent ?? ""
  validateContent(def, nextContent)
  writeTextAtomic(resolveDefinitionPath(def), nextContent, 0o600)
  syncWorkspaceEnvToProcess(previousContent, nextContent)
  emitAppEvent({ type: "settings.changed", reason: "env" })
  return { reset: true }
}

export function exportWorkspaceMemory(): MemoryExportBundle {
  ensureWorkspaceTemplates()
  const files: MemoryExportFile[] = []

  for (const id of MEMORY_FILE_IDS) {
    const def = getDefinition(id)
    if (!def || def.source === "virtual" || def.surface !== "editor") continue

    if (def.dynamic === "daily") {
      for (const stamp of listDailyMemoryStamps(def)) {
        const relativePath = dailyMemoryRelativePath(stamp)
        const content = readExistingDefinitionContent(def, stamp)
        files.push({
          id: dailyMemoryFileId(stamp),
          relativePath,
          label: stamp,
          content,
        })
      }
      continue
    }

    const targetPath = resolveDefinitionPath(def)
    if (!fs.existsSync(/* turbopackIgnore: true */ targetPath)) continue
    files.push({
      id: def.id,
      relativePath: def.relativePath,
      label: def.label,
      content: readExistingDefinitionContent(def),
    })
  }

  return {
    version: MEMORY_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    app: "orchestrator",
    files,
  }
}

export function importWorkspaceMemoryBundle(
  input: unknown
): MemoryImportResult {
  const bundle = parseMemoryImportBundle(input)
  let totalBytes = 0
  const seenTargets = new Set<string>()
  const writes: Array<{
    def: WorkspaceFileDefinition
    dailyStamp?: string
    file: MemoryExportFile
    size: number
  }> = []

  for (const file of bundle.files) {
    const target = resolveMemoryImportTarget(file)
    if (!target)
      throw new Error(
        `Unsupported memory file: ${file.relativePath || file.id}`
      )
    const targetPath = effectiveRelativePath(target.def, target.dailyStamp)
    if (seenTargets.has(targetPath)) {
      throw new Error(`Memory import contains duplicate target: ${targetPath}.`)
    }
    seenTargets.add(targetPath)
    const size = Buffer.byteLength(file.content, "utf-8")
    if (size > MEMORY_EXPORT_MAX_FILE_BYTES) {
      throw new Error(`${file.relativePath} is too large to import.`)
    }
    totalBytes += size
    if (totalBytes > MEMORY_EXPORT_MAX_TOTAL_BYTES) {
      throw new Error("Memory import is too large.")
    }
    validateContent(target.def, file.content)
    writes.push({ ...target, file, size })
  }

  for (const write of writes) {
    writeTextAtomic(
      resolveDefinitionPath(write.def, write.dailyStamp),
      write.file.content
    )
  }
  emitAppEvent({ type: "settings.changed", reason: "memory" })

  return {
    importedFiles: writes.map((write) => ({
      id: write.dailyStamp ? dailyMemoryFileId(write.dailyStamp) : write.def.id,
      relativePath: effectiveRelativePath(write.def, write.dailyStamp),
      size: write.size,
    })),
  }
}

export function getWorkspaceFile(id: string): WorkspaceFilePayload | null {
  const target = resolveDefinitionTarget(id)
  if (!target) return null
  const { def, dailyStamp } = target

  const summary = summarizeFile(def, dailyStamp)
  if (!shouldListFile(summary)) return null
  const readSource = resolveDefinitionReadSource(def, dailyStamp)
  let content =
    def.dynamic === "daily"
      ? buildDailyMemoryTemplate(dailyStamp)
      : (def.defaultContent ?? "")
  let contentRedacted = false

  if (def.source === "virtual") {
    content = buildVirtualFileContent(def.id)
  } else if (readSource?.exists) {
    const absolutePath = readSource.absolutePath
    const stat = fs.statSync(/* turbopackIgnore: true */ absolutePath)
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large to edit here (${stat.size} bytes).`)
    }
    content = fs.readFileSync(/* turbopackIgnore: true */ absolutePath, "utf-8")
    if (def.id === "env-local" && readSource.filterInheritedEnv) {
      content = filterInheritedEnvContent(content)
    }
    if (def.id === "env-local" && !readSource.inherited) {
      const nextContent = mergeMissingEnvDefaults(
        content,
        def.defaultContent ?? ""
      )
      if (nextContent !== content) {
        writeTextAtomic(absolutePath, nextContent, 0o600)
        content = nextContent
      }
    }
  }

  if (def.id === "env-local") {
    content = redactEnvContent(content)
    contentRedacted = true
  }

  return {
    ...summary,
    description: summary.inherited
      ? `${summary.description} Inherited from the admin profile.`
      : summary.description,
    content,
    ...(contentRedacted ? { contentRedacted } : {}),
  }
}

export function writeWorkspaceFile(
  id: string,
  content: string
): WorkspaceFilePayload | null {
  const target = resolveDefinitionTarget(id)
  if (!target) return null
  const { def, dailyStamp } = target
  if (def.readOnly) throw new Error(`${def.label} is read-only.`)
  if (def.source === "virtual")
    throw new Error(`${def.label} is generated and cannot be saved.`)

  const existingContent = readExistingDefinitionContent(def, dailyStamp)
  const contentToWrite =
    def.id === "env-local"
      ? mergeRedactedEnvSubmission(content, existingContent)
      : content

  validateContent(def, contentToWrite)
  writeTextAtomic(
    resolveDefinitionPath(def, dailyStamp),
    contentToWrite,
    def.id === "env-local" ? 0o600 : undefined
  )
  if (def.id === "env-local")
    syncWorkspaceEnvToProcess(existingContent, contentToWrite)

  if (def.id === "models-api") {
    invalidateRegistryCache()
  }
  if (def.id === "app-config") {
    emitAppEvent({ type: "config.updated" })
    emitAppEvent({ type: "settings.changed", reason: "config" })
  } else if (def.id === "env-local" || def.id === "models-api") {
    emitAppEvent({
      type: "settings.changed",
      reason: def.id === "env-local" ? "env" : "models",
    })
  }

  return getWorkspaceFile(id)
}

export function revealWorkspaceEnvValue(
  id: string,
  key: string,
  occurrence = 0
): WorkspaceEnvValue | null {
  const target = resolveDefinitionTarget(id)
  if (!target) return null
  const { def, dailyStamp } = target
  if (def.id !== "env-local")
    throw new Error("Only environment files support value reveal.")
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    throw new Error("Invalid env var name.")

  const content = readExistingDefinitionContent(def, dailyStamp)
  const requestedOccurrence = Math.max(
    0,
    Math.floor(Number.isFinite(occurrence) ? occurrence : 0)
  )
  let seen = 0

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const parsed = parseEnvAssignment(line)
    if (!parsed || parsed.key !== key) continue
    if (seen === requestedOccurrence) return parseEnvStoredValue(parsed.value)
    seen += 1
  }

  return null
}

function shouldListFile(summary: WorkspaceFileSummary): boolean {
  if (summary.category === "integrations") return false
  // BOOT.md and ONBOARDING.md are first-run onboarding state, not reusable
  // templates. They should be visible only while real files exist.
  if (summary.id === "boot" || summary.id === "onboarding")
    return summary.exists
  return true
}

function getDefinition(id: string): WorkspaceFileDefinition | undefined {
  return WORKSPACE_FILE_DEFINITIONS.find((def) => def.id === id)
}

function resolveDefinitionTarget(
  id: string
): { def: WorkspaceFileDefinition; dailyStamp?: string } | null {
  const dailyStamp = parseDailyFileId(id)
  if (dailyStamp) {
    const def = getDefinition(DAILY_MEMORY_ID)
    return def?.dynamic === "daily" ? { def, dailyStamp } : null
  }

  const def = getDefinition(id)
  return def ? { def } : null
}

function summarizeFile(
  def: WorkspaceFileDefinition,
  dailyStamp?: string
): WorkspaceFileSummary {
  if (def.source === "virtual") {
    const content = buildVirtualFileContent(def.id)
    return decorateDailySummary(
      {
        ...def,
        exists: true,
        size: Buffer.byteLength(content, "utf-8"),
        updatedAt: getModelRegistryUpdatedAt(),
      },
      dailyStamp
    )
  }

  if (def.id === "models-api") {
    migrateLegacyApiModelsFile()
  }

  const readSource = resolveDefinitionReadSource(def, dailyStamp)
  const absolutePath = readSource?.absolutePath ?? resolveDefinitionPath(def, dailyStamp)
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

  return decorateDailySummary(
    {
      ...def,
      relativePath: effectiveRelativePath(def, dailyStamp),
      readOnly:
        def.readOnly ||
        !canManageSettingsFilesForActiveProfile() ||
        readSource?.inherited === true,
      exists,
      size,
      updatedAt,
      ...(readSource?.inherited ? { inherited: true } : {}),
    },
    dailyStamp
  )
}

function canManageSettingsFilesForActiveProfile(): boolean {
  const profileId = getActiveProfileId()
  if (isAdminProfileId(profileId)) return true
  return getProfile(profileId)?.permissions.tools.settings_files === true
}

function canInheritAdminEnvForActiveProfile(): boolean {
  const profileId = getActiveProfileId()
  if (isAdminProfileId(profileId)) return false
  return getProfile(profileId)?.permissions.inheritAdminApiKeys === true
}

function resolveDefinitionReadSource(
  def: WorkspaceFileDefinition,
  dailyStamp?: string
): {
  absolutePath: string
  exists: boolean
  inherited: boolean
  filterInheritedEnv: boolean
} | null {
  if (def.source === "virtual") return null
  const activePath = resolveDefinitionPath(def, dailyStamp)
  if (fs.existsSync(/* turbopackIgnore: true */ activePath)) {
    return {
      absolutePath: activePath,
      exists: true,
      inherited: false,
      filterInheritedEnv: false,
    }
  }
  if (def.id !== "env-local" || !canInheritAdminEnvForActiveProfile()) {
    return {
      absolutePath: activePath,
      exists: false,
      inherited: false,
      filterInheritedEnv: false,
    }
  }

  const adminPath = path.join(
    /* turbopackIgnore: true */ runtimePathsForProfile(ADMIN_PROFILE_ID).workspaceDir,
    def.relativePath
  )
  return {
    absolutePath: adminPath,
    exists: fs.existsSync(/* turbopackIgnore: true */ adminPath),
    inherited: true,
    filterInheritedEnv: true,
  }
}

function filterInheritedEnvContent(content: string): string {
  const allowed = allowedInheritedAdminEnvKeys()
  if (allowed === null) return content
  const lines = content.replace(/\r\n/g, "\n").split("\n").filter((line) => {
    const parsed = parseEnvAssignment(line)
    return Boolean(parsed && allowed.has(parsed.key))
  })
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

function allowedInheritedAdminEnvKeys(): Set<string> | null {
  const profile = getProfile(getActiveProfileId())
  if (!profile?.permissions.inheritAdminApiKeys) return new Set()
  const allowed = profile.permissions.allowedProviderApiKeys
  if (allowed.includes("*")) return null
  return new Set(allowed)
}

function listDailyFileSummaries(
  def: WorkspaceFileDefinition
): WorkspaceFileSummary[] {
  const stamps = new Set<string>([
    appDateStamp(),
    ...listDailyMemoryStamps(def),
  ])

  return Array.from(stamps)
    .sort((a, b) => b.localeCompare(a))
    .map((stamp) => summarizeFile(def, stamp))
}

function listDailyMemoryStamps(def: WorkspaceFileDefinition): string[] {
  const stamps = new Set<string>()
  const dailyDir = resolveDailyMemoryDir(def)

  try {
    const entries = fs.readdirSync(/* turbopackIgnore: true */ dailyDir, {
      withFileTypes: true,
    })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = DAILY_MEMORY_FILE_RE.exec(entry.name)
      if (match && isDailyStamp(match[1])) stamps.add(match[1])
    }
  } catch {
    // Missing MEMORY_DAY is fine; ensureWorkspaceTemplates creates today's file.
  }

  return Array.from(stamps).sort((a, b) => b.localeCompare(a))
}

function decorateDailySummary(
  summary: WorkspaceFileSummary,
  dailyStamp?: string
): WorkspaceFileSummary {
  if (summary.dynamic !== "daily" || !dailyStamp) return summary
  return {
    ...summary,
    id: dailyMemoryFileId(dailyStamp),
    label: dailyStamp,
    dailyDate: dailyStamp,
    description: `Daily working memory for ${dailyStamp} (${configuredTimezone()} date).`,
  }
}

function dailyMemoryFileId(stamp: string): string {
  return `${DAILY_MEMORY_ID_PREFIX}${stamp}`
}

function parseDailyFileId(id: string): string | null {
  if (!id.startsWith(DAILY_MEMORY_ID_PREFIX)) return null
  const stamp = id.slice(DAILY_MEMORY_ID_PREFIX.length)
  return isDailyStamp(stamp) ? stamp : null
}

function isDailyStamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  )
}

function configuredTimezone(): string {
  return getConfig().timezone
}

function appDateStamp(date: Date = new Date()): string {
  return dateStampInTimezone(date, configuredTimezone())
}

function dailyMemoryRelativePath(stamp: string = appDateStamp()): string {
  return `MEMORY_DAY/${stamp}.md`
}

/** Path actually read/written for a definition; daily files resolve to today. */
function effectiveRelativePath(
  def: WorkspaceFileDefinition,
  dailyStamp?: string
): string {
  return def.dynamic === "daily"
    ? dailyMemoryRelativePath(dailyStamp)
    : def.relativePath
}

function buildDailyMemoryTemplate(stamp: string = appDateStamp()): string {
  return [
    `# MEMORY_DAY ${stamp}`,
    "",
    `Daily working memory for ${stamp} (${configuredTimezone()} date).`,
    "",
    "Append compact entries for meaningful actions, decisions, open loops, promises, blockers, and follow-ups. This file is noisy by design.",
    "",
  ].join("\n")
}

function resolveDefinitionPath(
  def: WorkspaceFileDefinition,
  dailyStamp?: string
): string {
  const root = agentWorkspaceDir()
  const resolved = path.resolve(
    /* turbopackIgnore: true */ root,
    effectiveRelativePath(def, dailyStamp)
  )
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Configured file escapes allowed root: ${def.id}`)
  }
  return resolved
}

function resolveDailyMemoryDir(def: WorkspaceFileDefinition): string {
  if (def.dynamic !== "daily")
    throw new Error(`${def.id} is not a daily memory definition.`)
  const root = agentWorkspaceDir()
  const resolved = path.resolve(
    /* turbopackIgnore: true */ root,
    def.relativePath
  )
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Configured file escapes allowed root: ${def.id}`)
  }
  return resolved
}

function parseMemoryImportBundle(input: unknown): MemoryExportBundle {
  const candidate =
    input && typeof input === "object" && "bundle" in input
      ? (input as { bundle?: unknown }).bundle
      : input
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Missing memory import bundle.")
  }

  const record = candidate as Record<string, unknown>
  if (record.version !== MEMORY_EXPORT_VERSION) {
    throw new Error(
      `Unsupported memory import version: ${String(record.version ?? "missing")}.`
    )
  }
  if (record.app !== "orchestrator") {
    throw new Error("This is not an Orchestrator memory export.")
  }
  if (!Array.isArray(record.files) || record.files.length === 0) {
    throw new Error("Memory import contains no files.")
  }

  const seen = new Set<string>()
  const files: MemoryExportFile[] = []
  for (const raw of record.files) {
    if (!raw || typeof raw !== "object")
      throw new Error("Memory import contains an invalid file entry.")
    const fileRecord = raw as Record<string, unknown>
    const id = typeof fileRecord.id === "string" ? fileRecord.id.trim() : ""
    const relativePath =
      typeof fileRecord.relativePath === "string"
        ? fileRecord.relativePath.trim()
        : ""
    const label =
      typeof fileRecord.label === "string"
        ? fileRecord.label.trim()
        : relativePath || id
    const content = fileRecord.content
    if (!id && !relativePath)
      throw new Error("Memory import file is missing id or relativePath.")
    if (typeof content !== "string")
      throw new Error(`${relativePath || id} is missing string content.`)
    const dedupeKey = relativePath || id
    if (seen.has(dedupeKey))
      throw new Error(`Memory import contains duplicate file: ${dedupeKey}.`)
    seen.add(dedupeKey)
    files.push({ id, relativePath, label, content })
  }

  return {
    version: MEMORY_EXPORT_VERSION,
    exportedAt:
      typeof record.exportedAt === "string"
        ? record.exportedAt
        : new Date().toISOString(),
    app: "orchestrator",
    files,
  }
}

function resolveMemoryImportTarget(
  file: Pick<MemoryExportFile, "id" | "relativePath">
): { def: WorkspaceFileDefinition; dailyStamp?: string } | null {
  const id = file.id.trim()
  const relativePath = file.relativePath.replace(/\\/g, "/").trim()

  const dailyFromId = parseDailyFileId(id)
  const dailyFromPath =
    /^MEMORY_DAY\/(\d{4}-\d{2}-\d{2})\.md$/.exec(relativePath)?.[1] ?? null
  const dailyStamp =
    dailyFromId ??
    (dailyFromPath && isDailyStamp(dailyFromPath) ? dailyFromPath : null)
  if (dailyStamp) {
    const def = getDefinition(DAILY_MEMORY_ID)
    return def?.dynamic === "daily" ? { def, dailyStamp } : null
  }

  const allowedIds = new Set<string>(
    MEMORY_FILE_IDS.filter((memoryId) => memoryId !== DAILY_MEMORY_ID)
  )
  const byId = allowedIds.has(id) ? getDefinition(id) : undefined
  if (byId) return { def: byId }

  const byPath = WORKSPACE_FILE_DEFINITIONS.find(
    (def) =>
      allowedIds.has(def.id) &&
      def.surface === "editor" &&
      def.source !== "virtual" &&
      def.relativePath === relativePath
  )
  return byPath ? { def: byPath } : null
}

function validateContent(def: WorkspaceFileDefinition, content: string): void {
  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large to save here. Limit is ${MAX_FILE_BYTES} bytes.`
    )
  }
  if (content.includes("\0")) {
    throw new Error("File contains a NUL byte.")
  }

  if (def.kind !== "json") return

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new Error(
      `Invalid JSON: ${err instanceof Error ? err.message : "parse failed"}`
    )
  }

  const result =
    def.id === "app-config"
      ? AppConfigFileSchema.safeParse(parsed)
      : def.id === "models-api"
        ? LiveRegistrySchema.safeParse(parsed)
        : z.unknown().safeParse(parsed)

  if (!result.success) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")
    )
  }
}

function readExistingDefinitionContent(
  def: WorkspaceFileDefinition,
  dailyStamp?: string
): string {
  const fallback =
    def.dynamic === "daily"
      ? buildDailyMemoryTemplate(dailyStamp)
      : (def.defaultContent ?? "")
  try {
    const absolutePath = resolveDefinitionPath(def, dailyStamp)
    if (!fs.existsSync(/* turbopackIgnore: true */ absolutePath))
      return fallback
    return fs.readFileSync(/* turbopackIgnore: true */ absolutePath, "utf-8")
  } catch {
    return fallback
  }
}

function buildVirtualFileContent(id: string): string {
  if (id === "models-current") {
    return buildModelViewContent(false)
  }
  if (id === "models-archived") {
    return buildModelViewContent(true)
  }
  return (
    JSON.stringify({ generatedAt: new Date().toISOString() }, null, 2) + "\n"
  )
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

  return (
    JSON.stringify(
      {
        version: 1,
        view: archived ? "archived" : "current",
        generatedAt: new Date().toISOString(),
        providers,
      },
      null,
      2
    ) + "\n"
  )
}

function getModelRegistryUpdatedAt(): number | null {
  const root = agentWorkspaceDir()
  const candidates = [
    path.resolve(root, "api-models.json"),
    path.resolve(root, "model-overrides.json"),
    path.resolve(root, "models-live.json"),
    path.resolve(root, "models-curated.json"),
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
  const root = agentWorkspaceDir()
  const targetPath = path.resolve(root, "api-models.json")
  const legacyPath = path.resolve(root, "models-live.json")
  if (
    fs.existsSync(/* turbopackIgnore: true */ targetPath) ||
    !fs.existsSync(/* turbopackIgnore: true */ legacyPath)
  )
    return
  try {
    fs.copyFileSync(/* turbopackIgnore: true */ legacyPath, targetPath)
  } catch {
    // The model store performs the same migration when the registry is read.
  }
}

function writeTextAtomic(
  targetPath: string,
  content: string,
  mode?: number
): void {
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(targetPath), {
    recursive: true,
  })
  const tmpPath = path.join(
    /* turbopackIgnore: true */ path.dirname(targetPath),
    `.tmp-${path.basename(targetPath)}-${randomUUID()}`
  )
  fs.writeFileSync(/* turbopackIgnore: true */ tmpPath, content, {
    encoding: "utf-8",
    mode,
  })
  fs.renameSync(/* turbopackIgnore: true */ tmpPath, targetPath)
  if (mode !== undefined) {
    try {
      fs.chmodSync(/* turbopackIgnore: true */ targetPath, mode)
    } catch {
      // Best effort; the content is already saved.
    }
  }
}
