import { MONITORING_DOCTRINE } from '@/lib/integrations/doctrines/monitoring'
import { SCHEDULING_DOCTRINE } from '@/lib/integrations/doctrines/scheduling'
import { WATCHLIST_DOCTRINE } from '@/lib/integrations/doctrines/watchlist'
import { MICROSCRIPTS_DOCTRINE } from '@/lib/integrations/doctrines/microscripts'
import { APP_GUIDE_DOCTRINE } from '@/lib/integrations/doctrines/app-guide'
import { MEDIA_GENERATION_DOCTRINE } from '@/lib/integrations/doctrines/media-generation'
import { BROWSER_AGENT_DOCTRINE } from '@/lib/integrations/doctrines/browser-agent'
import { RECIPE_DOCTRINE } from '@/lib/integrations/doctrines/recipe'
import { WORKOUT_DOCTRINE } from '@/lib/integrations/doctrines/workout'
import { CAD_DOCTRINE } from '@/lib/integrations/doctrines/cad'
import { APPS_DOCTRINE } from '@/lib/integrations/doctrines/apps'
import { SELF_DEVELOPMENT_DOCTRINE } from '@/lib/integrations/doctrines/self-development'

// ---------------------------------------------------------------------------
// Subsystem manifest — orchestrator-native capabilities that mirror the
// integration manifest's lazy-doctrine pattern.
//
// Unlike integrations (Gmail, Calendar, Maps, …), subsystems have no
// connection state and no setup runbook: they ship with the orchestrator.
// But their operating doctrine — schema, rule grammars, lifecycle nuances —
// is heavy enough that always-on inclusion bloats every turn. So we route
// them through the same activation primitive (ActivateIntegrationTools):
// the always-on <subsystems> block tells the orchestrator each subsystem
// exists; the doctrine block is loaded only after activation.
//
// New subsystem? Add the doctrine file under lib/integrations/doctrines/
// and register the entry below. The activation tool and the prompt
// builders pick it up automatically.
// ---------------------------------------------------------------------------

export type SubsystemId =
    | 'watchlist'
    | 'monitoring'
    | 'scheduling'
    | 'microscripts'
    | 'app_guide'
    // Doctrine-only "playbooks": no tools of their own, just heavy guidance that
    // used to sit always-on in the base prompt. Activated on demand like any
    // other capability so the orchestrator pays for them only when relevant.
    | 'media'
    | 'browser'
    | 'recipe'
    | 'workout'
    | 'cad'
    | 'apps'
    | 'self_dev'
    // Tool-only capability groups (no doctrine): rarely-needed-in-main-chat tool
    // schemas pulled out of the always-on surface and loaded on demand.
    | 'observability'
    | 'inbox'
    | 'setup'
    | 'profile_admin'

export interface SubsystemManifestEntry {
    /** Stable id used by ActivateIntegrationTools and the activation store. */
    id: SubsystemId
    /** Display label for the <subsystems> block. */
    label: string
    /** 1–2 line plain-language summary of what the subsystem does. Always in context. */
    capability: string
    /**
     * Heavy operating doctrine loaded lazily — flow, rules, protocols, gotchas.
     * Optional: tool-only capability groups (inbox/setup/observability) gate a
     * set of tool schemas with no accompanying doctrine.
     */
    doctrine?: string
    /**
     * Operational tool ids gated behind activation (schemas loaded only after
     * ActivateIntegrationTools). Deliberately a SAFE SUBSET — tools shared with
     * always-on flows (e.g. notify_inbox, set_task_state used by scheduled-task
     * wakes, monitor_wake_feedback used by Smart Monitor wakes) are intentionally
     * left OUT so those flows never lose access. Omit/empty for a doctrine-only
     * subsystem whose tools (if any) must stay always-on.
     */
    toolIds?: string[]
}

export const SUBSYSTEM_MANIFEST: readonly SubsystemManifestEntry[] = [
    {
        id: 'watchlist',
        label: 'Watchlist',
        capability: 'Track financial instruments (stocks, ETFs, indexes, FX, crypto) and products with local price observations and charts. The Watchlist surface itself is local; background market monitoring is one consolidated heartbeat that auto-arms once a market-data key + at least one monitor-enabled item exists.',
        doctrine: WATCHLIST_DOCTRINE,
        toolIds: [
            'WatchlistAddFinancialInstrument',
            'WatchlistAddProduct',
            'WatchlistRemoveItem',
            'WatchlistListItems',
            'WatchlistRecordProductPrice',
        ],
    },
    {
        id: 'monitoring',
        label: 'Smart Monitor',
        capability: 'Ongoing recurring model-owned work: persistent source monitoring, recurring summaries, recurring maintenance, and tell-me-when subscriptions. One consolidated scheduled agent wake handles connector-backed and custom prompt-backed watches; the agent decides what to inspect, notify, digest, and how to self-pace from history.',
        doctrine: MONITORING_DOCTRINE,
        // monitor_wake_feedback now lives in the 'inbox' capability (pre-activated
        // for every wake), so it is reachable during wakes without bloating the
        // main-chat surface. Here we gate only the watch-lifecycle tools, used in
        // user-conversation setup/inspection; source connector capabilities are
        // warmed up per wake from the enabled watch sources.
        toolIds: [
            'monitor_describe_sources',
            'monitor_watch_list',
            'monitor_watch_get',
            'monitor_watch_add',
            'monitor_watch_update',
            'monitor_watch_remove',
        ],
    },
    {
        id: 'scheduling',
        label: 'Scheduled tasks',
        capability: 'Real runtime automation for one-shot, delayed, bounded, and time-critical future work. Two action types: "tool" (cheap, no model at fire time) or "agent" (wakes a model with your prompt). Ongoing recurring model-owned work belongs in Smart Monitor.',
        doctrine: SCHEDULING_DOCTRINE,
        // notify_inbox and set_task_state are NOT here — they are general
        // inbox/notification primitives (now in the 'inbox' capability, which is
        // pre-activated for every wake/inbox/scheduled run), not scheduling
        // lifecycle tools.
        toolIds: [
            'schedule_task',
            'list_tasks',
            'cancel_task',
            'reschedule_task',
        ],
    },
    {
        id: 'microscripts',
        label: 'Microscripts',
        capability: 'Bounded Python automations for small stateful watchers: run short checks, request permitted operations through the parent runtime, notify or act when conditions are met, then pause/complete/expire so they do not run forever.',
        doctrine: MICROSCRIPTS_DOCTRINE,
        toolIds: [
            'webhook_describe_capabilities',
            'webhook_list',
            'webhook_create',
            'webhook_update',
            'webhook_delete',
            'webhook_subscription_create',
            'microscript_describe_capabilities',
            'microscript_create',
            'microscript_list',
            'microscript_get',
            'microscript_update',
            'microscript_pause',
            'microscript_resume',
            'microscript_delete',
            'microscript_run_now',
            'microscript_get_run',
        ],
    },
    {
        id: 'app_guide',
        label: 'App & host guide',
        capability: 'Self-knowledge about Orchestrator itself: what each page/Settings tab does and where a feature lives, how backup/restore/factory-reset work (you can create a backup; restore + factory reset stay user-only), and the host_status tool for a live machine snapshot. Activate when the user asks what the app can do, where to do something in the UI, how to back up / reset, or how the server/disk/memory is doing.',
        doctrine: APP_GUIDE_DOCTRINE,
        toolIds: ['host_status'],
    },
    // --- Doctrine-only playbooks (no tools) ---------------------------------
    {
        id: 'media',
        label: 'Media production prompts',
        capability: 'Per-modality prompting playbook for the image/video/speech/music specialist agents (composition, camera/lens, audio direction, song structure, edits). Activate before you author a production prompt to delegate to a media agent.',
        doctrine: MEDIA_GENERATION_DOCTRINE,
    },
    {
        id: 'browser',
        label: 'Browser agent handoff',
        capability: 'Handoff playbook for browser_agent: session/thread reuse, the time-critical execution contract, data in/out boundaries, stop boundary, evidence, runtime-error recovery, checkpoint/continue/abort, and the confirmation flow. Activate before your first browser_agent delegation in this conversation.',
        doctrine: BROWSER_AGENT_DOCTRINE,
    },
    {
        id: 'recipe',
        label: 'Recipe artifact schema',
        capability: 'The exact JSON schema for application/vnd.ant.recipe artifacts (scalable ingredients, timed steps, metric units). Activate before emitting a recipe artifact.',
        doctrine: RECIPE_DOCTRINE,
    },
    {
        id: 'workout',
        label: 'Workout artifact schema',
        capability: 'The exact JSON schema + named program templates for application/vnd.ant.workout artifacts (per-exercise sets, history seeding, progression). Activate before emitting a workout artifact or answering gym/antrenament requests; use the history tools to seed weights, read notes/failures/RPE, and rotate muscle groups from recent sessions; read/save body metrics to scale loads and volume to the user.',
        doctrine: WORKOUT_DOCTRINE,
        toolIds: [
            'GetExerciseHistory',
            'ListExerciseHistory',
            'GetRecentWorkouts',
            'GetBodyMetrics',
            'SaveBodyMetrics',
            'PatchWorkout',
        ],
    },
    {
        id: 'cad',
        label: 'CAD artifact schema',
        capability: 'The exact JSON schema for application/vnd.ant.cad artifacts (interactive in-chat 3D model viewer backed by a workspace GLB) plus the CAD generation workflow: the bundled `cad` skill (build123d → STEP → GLB/STL/3MF exports) and the `step-parts` catalog for real models of named purchasable components. Activate whenever the user asks to design/modify a mechanical part, adapter, bracket, enclosure, or wants files for 3D printing.',
        doctrine: CAD_DOCTRINE,
    },
    {
        id: 'apps',
        label: 'Internal apps',
        capability: 'Build reusable internal mini-apps — any self-contained interactive tool (calculators, planners, trackers, generators, dashboards, configurators, games, …) — as html/react artifacts with a persistent per-app JSON data store, then recall, show, and update them in any later conversation. Activate when the user wants a custom tool/app, mentions one you built before, asks to add data to one, or describes a recurring workflow a small app would solve.',
        doctrine: APPS_DOCTRINE,
        toolIds: [
            'AppsList',
            'AppGet',
            'AppSave',
            'AppDelete',
            'AppDataGet',
            'AppDataSet',
            'AppShow',
        ],
    },
    {
        id: 'self_dev',
        label: 'Self-development & project runs',
        capability: 'The full protocol for code work on the Orchestrator itself or any other repository/new project: isolated worktrees under .orchestrator/project-runs, the self-dev:prepare / project-run:prepare helpers, managed dev previews, the coder handoff contract, the git commit/rebase/push gate, and the self-update deploy path. Activate BEFORE preparing any code work, coder delegation, or Orchestrator self-development — the helpers and boundaries live in the doctrine, not in your base prompt.',
        doctrine: SELF_DEVELOPMENT_DOCTRINE,
    },
    // --- Tool-only capability groups (no doctrine) --------------------------
    {
        id: 'observability',
        label: 'Run & log inspection',
        capability: 'Introspect past agent runs and logs: search/read prior request runs and sub-agent transcripts, and read the runtime index. Activate when you need to debug what happened on an earlier run, audit a tool call, or trace a failure across runs.',
        toolIds: [
            'search_past_runs',
            'get_past_run',
            'search_agent_logs',
            'get_agent_log',
            'read_runtime_index',
        ],
    },
    {
        id: 'inbox',
        label: 'Inbox & wake notifications',
        capability: 'Post a card to the Inbox surface (notify_inbox), persist per-run task state across wakes (set_task_state), and report the Smart Monitor learning-loop signal (monitor_wake_feedback). These are background/autonomous primitives — the main chat answers inline, so they load on demand. Auto-active for the Inbox and Smart Monitor agents and every scheduled/wake/microscript run.',
        toolIds: [
            'notify_inbox',
            'set_task_state',
            'monitor_wake_feedback',
        ],
    },
    {
        id: 'setup',
        label: 'Integration setup',
        capability: 'Connect, configure, and re-auth connection-based integrations: Gmail/Calendar/Drive (status/configure/OAuth), Home Assistant (status/configure), WhatsApp (status/connect), and Remote MCP servers (configure/OAuth/disconnect/remove). Live connection state is already shown in <integrations>, so activate this only when you are actually about to connect, repair, or reconfigure an integration.',
        toolIds: [
            'GoogleCalendarStatus',
            'GoogleCalendarConfigure',
            'GoogleCalendarStartOAuth',
            'GoogleDriveStatus',
            'GoogleDriveConfigure',
            'GoogleDriveStartOAuth',
            'HomeAssistantStatus',
            'HomeAssistantConfigure',
            'WhatsAppStatus',
            'WhatsAppConnect',
            'RemoteMcpStatus',
            'RemoteMcpConfigure',
            'RemoteMcpStartOAuth',
            'RemoteMcpDisconnect',
            'RemoteMcpRemove',
        ],
    },
    {
        id: 'profile_admin',
        label: 'Profile administration',
        capability: 'Admin-only profile and integration-sharing changes: inspect profiles/connections, grant or revoke Home Assistant connection access, and set a profile default connection. Activate only when the admin asks to change profile access; mutation tools require explicit confirmation and non-admin profiles cannot see or run them.',
        toolIds: [
            'ProfileAdminListAccess',
            'ProfileAdminGrantHomeAssistantAccess',
            'ProfileAdminRevokeHomeAssistantAccess',
            'ProfileAdminSetHomeAssistantDefault',
        ],
    },
]

const MANIFEST_BY_ID = new Map(SUBSYSTEM_MANIFEST.map((entry) => [entry.id, entry]))

export function getSubsystemManifest(id: string): SubsystemManifestEntry | undefined {
    return MANIFEST_BY_ID.get(id as SubsystemId)
}

export const ALL_SUBSYSTEM_IDS: SubsystemId[] = SUBSYSTEM_MANIFEST.map((entry) => entry.id)

/** Every gated subsystem tool id mapped back to its subsystem id (for exposure gating). */
const SUBSYSTEM_TOOL_TO_ID = new Map<string, SubsystemId>()
for (const entry of SUBSYSTEM_MANIFEST) {
    for (const toolId of entry.toolIds ?? []) SUBSYSTEM_TOOL_TO_ID.set(toolId, entry.id)
}

/** Returns the subsystem id if `toolId` is a gated subsystem tool, else undefined. */
export function subsystemForGatedTool(toolId: string): SubsystemId | undefined {
    return SUBSYSTEM_TOOL_TO_ID.get(toolId)
}
