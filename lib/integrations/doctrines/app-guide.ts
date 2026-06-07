// App & host guide doctrine — the orchestrator's self-knowledge about the
// Orchestrator product: every page and Settings tab, where each capability
// lives, how data management (backup / restore / factory reset) works, the
// feature mechanics a user actually asks about, and how to read the live host
// snapshot. Loaded lazily into the prompt only after
// ActivateIntegrationTools('app_guide') (see lib/integrations/subsystem-manifest.ts).
//
// MAINTENANCE: this is hand-written documentation of the UI/product AND of the
// background machinery (<under_the_hood>). Keeping it current is a dev RULE, not a
// nicety — see "Keep The App Guide In Sync" in AGENTS.md: any change that adds or
// alters a user-facing surface, capability, data-management behavior, or the
// background machinery below must update this file in the same change and run
// `npm run smoke:app-guide`. Keep it user-facing and accurate; it answers "what can
// this app do / where do I do X / how does Y work / what's running", not internal
// code architecture. Grounded in the codebase as of this writing — verify a
// specific path/flag with the live UI or code if a user disputes it rather than
// insisting from here.
export const APP_GUIDE_DOCTRINE = `
<app_guide>
Authoritative reference for answering the user's questions ABOUT Orchestrator itself — what it can do, where a feature lives, how a surface behaves, and how its data-management controls work. The user owns and administers this instance; you are their operating layer inside it. Be concrete: name the page or the exact Settings tab → section. Don't invent UI that isn't described here. Many things in here you can also DO for the user (edit memory/behavior files, set up integrations, create a backup, manage watches/tasks); a few are deliberately user-only (restore, factory reset) — say so plainly. If a user disputes a detail, trust the live app over this text and check rather than insisting.

<product_model>
- Orchestrator is a personal, local-first AI operating layer: one chat-driven agent (you) that does work directly and delegates the rest to specialist sub-agents, with persistent memory, integrations, schedules, and monitors.
- Local-first and profile-scoped: OAuth tokens, WhatsApp/browser sessions, .env secrets, SQLite data, uploads, artifacts, browser-agent state, CLI runtime homes, and memory live on disk on the machine the app runs on. Each profile has its own isolated workspace/private state; the built-in admin profile is Horia. Disconnect / factory-reset language is always "removed locally", not "revoked at the provider".
- Surfacing is silent by default across schedules and monitors: routine runs are logged but only reach the Inbox (and push) when the agent decides something is worth the user's attention, or on error.
- The agent that powers chat is the "orchestrator"; some surfaces run alias agents on the same brain so the user can route them to a different/cheaper model in Settings → Models (e.g. the Inbox agent, the Smart Monitor wake agent, the Conversation Namer).
</product_model>

<profiles>
- Profile picker: a device with no selected profile opens "/profiles" before the app. It shows Netflix-style profile tiles plus an Add profile tile. Profiles have no password by default; locked profiles ask for the profile password.
- Sidebar profile menu: the sidebar footer shows the active profile. Clicking it opens Switch profile and Sign out. Switching returns to the profile picker; signing out clears only that device's profile session.
- Admin vs member: Horia/admin sees Settings, Logs, Usage, Updates, model/config controls, profile management, and app-wide data management. Member profiles do not see Settings and direct Settings/admin API calls return 403.
- Isolation: each profile gets its own conversations, inbox, schedules, monitors, watchlist, maps/places, uploads, artifacts, memory files, .env.local, integration tokens, WhatsApp session, browser-agent Chromium profile, Codex/Claude runtime home, and browser downloads. The profile permission matrix can allow a member to use an integration/tool, but it does not merge their workspace with Horia's.
</profiles>

<navigation>
Left sidebar (collapsible to an icon rail). Pages, top to bottom:
- Chat ("/") — the main conversation surface. New chat button; Search (also Cmd/Ctrl-K) is accent-insensitive (matches Romanian text without diacritics) and searches titles + message contents both client-side and server-side. Conversation list shows "Recents" (non-archived); a hover/again-tap Archive toggle flips to the "Archive" view.
- Inbox ("/inbox") — results/notifications from scheduled tasks and monitors. The sidebar item carries a dark-red unread badge (count, or "99+").
- Library ("/library") — everything generated or attached, in tabs.
- Watchlist ("/watchlist") — track financial instruments and products.
- Scheduling ("/scheduling") — create and manage scheduled tasks.
- Smart Monitor ("/monitor") — ongoing, model-owned monitoring.
- Smart Maps ("/maps") — full-screen interactive map.
- Settings ("/settings") — all configuration (footer, admin profiles only).

Conversation management (sidebar):
- Auto-naming: a new chat gets a placeholder, then after the first exchange the Conversation Namer agent names it in the user's language (≤~30 chars). It NEVER overwrites a title the user changed manually.
- Archive / Restore / Delete: normal rows can be Archived (hover button on desktop; long-press ~0.5s or right-click on mobile). The Archive view exposes Restore and Delete per row. There is no delete in Recents — archive first, then delete from the Archive view.
- Unread: a conversation is marked unread when an assistant reply finishes while the user isn't looking at it (different page, hidden tab, or a different active conversation). Opening it clears the unread state.
- Drafts and per-conversation artifact-panel widths persist locally.
</navigation>

<chat_surface>
Input (the composer):
- Text: Enter sends, Shift+Enter is a newline (on a mobile keyboard Enter inserts a newline — use the send button). Shift+Enter inside a markdown list auto-continues the next bullet/number/letter; on an empty list item it ends the list (Word-style).
- Attachments: the "+" button, drag-and-drop, or paste. Multiple files. They upload immediately; sending is blocked until every attachment finishes uploading. Click an attachment chip to preview it.
- Voice: the Mic button records a voice note. It is uploaded and sent as an AUDIO ATTACHMENT (not transcribed in the browser); the agent receives the audio. Voice notes land in Library → Audio.
- Drafts persist per conversation.

Messages and what the user sees:
- Assistant replies interleave "Thinking" reasoning blocks and prose. The Thinking block is collapsible (expand/collapse persists per message), shows a live "Thinking (Ns)" timer while streaming, and contains the agent's reasoning and tool calls (web searches are grouped). It auto-expands when there are notable tool calls and stays open while a live browser-agent run is in progress.
- Hover a message for the timestamp and a Copy button.

Artifacts (rich, self-contained outputs the agent emits). Each renders inline, in a resizable side panel ("Open artifact"), or full-screen ("/artifact/[id]") depending on the agent's display choice. The panel offers a Preview⇄Code toggle, a version dropdown (history of that artifact), Copy, Download, Open-in-new-tab, and Fullscreen. Types:
- text/markdown, application/vnd.ant.code (highlighted source), text/html (sandboxed live page), application/vnd.ant.react (live React component), application/vnd.ant.mermaid (diagram), image/svg+xml, text/csv (table), application/json, application/x-latex.
- application/vnd.ant.map — interactive Google map (pins/routes/areas, multi-day trip tabs); "Open in Smart Maps".
- application/vnd.ant.weather — iOS-style weather card (current, 24h scroll, 10-day, UV/wind/sunrise tiles).
- application/vnd.ant.recipe — recipe card with an interactive servings stepper that live-scales ingredient quantities; lands in Library → Recipes.
- application/vnd.ant.workout — interactive workout session. A fixed bottom session bar starts, finishes, or discards the workout while the user scrolls. After Start, the user can tap any pending set in any order; the highlighted row is just the next unfinished suggestion. The working-set timer appears in the bottom bar; Finish stops it and opens a compact editor for actual weight/reps/duration/RPE/notes; Save logs the set, starts the rest timer with chimes, and autosaves progress. During rest, the bottom rest bar can start the next set directly, closing the rest event cleanly. Individual sets can be skipped from the row menu; if the user taps Finish workout before completing everything, the remaining sets are confirmed and marked skipped with an optional reason. During an active workout the user can add extra sets or add a new weighted/bodyweight exercise; added exercises scroll into view, join progress, next-set order, summary, and saved history. Set notes open in a custom workout dialog rather than a browser prompt. Completed/failed/skipped sets remain editable after Finish workout, and changed actuals/RPE/notes re-save the finished session. The renderer records set timer duration and rest timer events so later workout-history tools can coach from real timing, not only reps/weight/RPE. The exercise info button can show a longer description, alternatives, video, relevant term explanations, and a direct demo/equipment image when the artifact provides a verified image URL. Finished sessions save a summary and land in Library → Workouts.
Recipe/map/workout artifacts also appear automatically in the matching Library tab.
</chat_surface>

<inbox_surface>
A mail-style client for scheduled-run results, monitor alerts, replies, and handoffs.
- What creates an item: the agent (a scheduled task or a monitor wake) calls the notify_inbox tool with a title, a user-facing markdown body, and optional quick-reply actions. Ordinary chat does NOT create Inbox items. Items are system-owned conversations kept separate from user chats.
- List: search; folder chips Inbox / Unread / Read / Scheduled (items tied to a scheduled task); grouped Today / Yesterday / Earlier. An item re-marks unread when a new reply arrives.
- Opening an item marks it read. Header actions: "Open in chat" forks the thread into a normal chat; Delete.
- Quick-reply action buttons under an assistant message: reply-type actions continue the thread inline (handled by the Inbox agent); "direct" actions run a whitelisted housekeeping tool server-side WITHOUT invoking a model (e.g. Gmail mark-read/archive, WhatsApp mark-read). A free-text composer (with attachments) replies inline too.
- Push notifications: an in-Inbox bell enables web push; surfaced runs trigger a push.
</inbox_surface>

<library_surface>
One hub for "everything you've generated or attached." Tabs and what fills each:
- Workouts / Recipes / Maps — populated automatically from the matching chat artifacts. Workouts also show progress cards (recent sessions, volume trend, PRs), a recent-session list, per-exercise PR/history trends, and a Body metrics card where the user can log height, weight, body fat %, and muscle mass; IMC/BMI is calculated from the latest height+weight. Clicking an artifact opens the full interactive renderer ("/artifact/[id]" or "/maps/[id]").
- Media (images+videos) / Audio (voice notes, music) / Files (pdf/docs/other) — populated from two sources: chat/inbox attachments AND files the agent writes into allowlisted workspace output dirs. A file appears in the Library only if it lives in one of: files/, browser-downloads/, gmail-attachments/, artifacts/ (or is an upload). Standard workspace files (USER.md, MEMORY.md, runbooks, config) are deliberately NOT listed here. → This is why create_backup saves into files/: so the archive shows in Library → Files.
- Places — the optional Location Intelligence journal (Home Assistant location webhooks → a local daily journal). Off until the user opts in.
- Cross-tab actions on Media/Audio/Files: search, a selection mode for bulk Download / Share / Delete, a media lightbox, and "View in chat" to jump to the source message. Deleting removes the upload or the workspace file; standard workspace files can't be deleted here.
</library_surface>

<settings>
Seven tabs (Models, Profiles, Auth, Files, Logs, Usage, Updates). The light/dark Theme toggle is in the Settings header, top-right. The active tab is remembered. Settings is admin-only; member profiles are redirected back to the main app.

<settings_profiles>
Admin profile and access management.
- Profiles list: create profiles, edit name/color/role/password, disable/delete non-admin profiles, and inspect recent profile audit events (creation, sign-ins, permission changes, deletes).
- Access matrix: per profile, choose visible app surfaces, tool classes (web, read/write files, shell, delegation, scheduling, monitoring, microscripts, backups, updates), integration access (none/read/write/setup), and whether the profile may inherit selected admin API keys from the shared process/project environment.
- Sharing model: profiles never share DB/workspace/browser state. Granting integration/API-key access only lets a profile use that capability inside its own workspace and with its own local tokens/config unless explicit key inheritance is enabled.
- Logs/user visibility: Logs is admin-only and aggregates model request logs across profiles; rows show the profile that produced the request. The Profiles tab shows profile/session/permission audit events.
</settings_profiles>

<settings_models>
Per-agent model configuration plus the model registry and semantic-memory setup.
- For each agent: pick the Model, the Thinking level, model-specific Features, and up to two ordered Fallback models. Agents are listed in a reorderable sidebar (drag to reorder), with a separate pinned "System" group for agents that run automatically.
- Thinking level is a PER-MODEL capability surfaced per-agent: Off / Low / Med / High / XHigh / Max, only shown for models that support adjustable thinking, and it auto-normalizes when you switch to a model that doesn't support the current level. It controls the reasoning effort/budget sent to the model — not a global toggle.
- Override resolution: per-agent override → that agent's default → the global default. The right panel labels which is active.
- Model picker: search across name/provider; Favorites (star, reorderable) at top; Archive/Unarchive per model (archived models hide from the picker but an explicit selection still runs). A Refresh button re-pulls each provider's model list.
- Top bar: "Research model details (N)" runs the researcher agent to fill pricing/context/thinking for models with incomplete metadata (streamed progress, stoppable); "Refresh models" auto-discovers new models from each configured provider. New models still need research to be "complete".
- Browser agent is special: choose its backend (Auto / Patchright / Chromium) and a light model plus an optional pro model (escalates on hard blockers); both restricted to Google models.
- Memory recall card (bottom): enable semantic memory, choose the embedding model + dimensions (Google/Gemini, reuses the existing Gemini key — no separate billing) and a recall threshold; Rebuild index after switching models. Powers the automatic per-turn recall and the memory_search tool. The test search shows both raw score distribution and an "automatic recall preview" that applies the real threshold, context exclusions, deduping, and coverage gate.
</settings_models>

<settings_auth>
Connect external services and manage the coding-CLI logins. A "Recheck" button refreshes all statuses. The connectable services (each a card with live status):
- Gmail — OAuth (popup). Search/read/send/draft, labels, archive/trash, attachments. Shows account, scopes, token expiry; paste-client-ID/secret config form if the OAuth client isn't set.
- WhatsApp — local WhatsApp Web session: Connect shows a QR code to scan from Linked Devices. Mode is "reads plus confirmed writes" (sending/media/delete-for-everyone need explicit confirmation). Needs a local Chrome/Chromium.
- Google Calendar — OAuth. Events, free/busy, availability, create/update/move/delete, RSVP.
- Google Workspace — OAuth (shares the Drive token). Drive + Docs/Sheets/Slides + Contacts.
- Home Assistant — save URL + long-lived token (verified on save). An action-mode toggle allows direct control of lights/covers/climate/notify while confirming other domains.
- Maps & Weather — one Google Maps Platform API key powers Smart Maps, Geocoding, Places, Routes, and optional Google Weather/Air-Quality/Pollen; without it weather falls back to keyless Open-Meteo. Accepts a pasted .env or a typed key + Vector Map ID; includes a setup tutorial with deep links to enable each Google API.
- Location Intelligence — read-only status of the optional local location journal; a button hands a setup prompt to chat. Off until configured.
- CLI accounts (bottom): Claude Code and Codex. Per CLI: install state, login state, Log in / Reconnect / Log out, "Use long-lived token" (Claude Code — non-expiring, best for headless), Restart, and a binary path. These are how the orchestrator delegates code work; no API key needed once logged in.
For OAuth on a remote/headless host where Google must redirect to localhost: the runtime context provides an SSH tunnel command (ssh -N -L ...) and you open http://localhost:PORT/settings to finish the consent. Keep the tunnel up until status reads Connected.
</settings_auth>

<settings_files>
Browse and edit the agent's workspace files. Categories: Onboarding, Knowledge & memory, Behavior, System. Files:
- USER.md — stable user facts, preferences, constraints, accounts, places, people.
- MEMORY.md — permanent consolidated durable memory.
- Daily memory — a FOLDER (MEMORY_DAY/), one note per app-configured local day; the working-memory ledger. Rendered as a collapsible folder with a date search box when there are many days.
- PLAYBOOKS.md — reusable distilled procedures.
- AGENT_NEEDS.md — backlog of missing capabilities / failed tools / blockers.
- MONITORS.md — monitoring preferences + the active Smart Monitor watch ids.
- BOOT.md / ONBOARDING.md — first-run onboarding only (disappear once onboarding is done).
- config.json — read-only here ("Edited from the Models tab"); stores app-level defaults including userName, assistantName, and timezone.
- .env.local — secrets. Uses EXPLICIT save (never autosaves), values redacted on read, stored with 0600 perms.
Markdown files autosave ~0.7s after you stop typing. JSON files use a structured tree editor (typed inputs), and invalid JSON blocks saving. Integration runbook files exist (INTEGRATIONS/<id>.md) but are hidden from this list. You (the agent) can edit the markdown memory/behavior files directly with your file tools; config.json is owned by the Models tab.
</settings_files>

<settings_logs>
Every AI request (model call) with full detail. Admin sees an aggregate across all profiles, with a Profile column. Filter by search (error/id), time range (1h / 24h / 7d / 30d / All), status (OK / Error / Aborted / Streaming), agent, and provider. A "Live" tail streams new requests. Expanding a row shows the chat transcript for that request, a token breakdown (input / output / thinking / cached / tool use / total), the request metadata (profile, provider, thinking level, stateful vs stateless mode), and the list of tool calls with per-call durations. "Clear all logs" wipes the log history for every profile (confirmation required).
</settings_logs>

<settings_usage>
Token/cost analytics plus live CLI subscription quotas.
- Range: 24h / 7d / 30d / 90d / All. KPI cards: Requests; Total tokens (NOTE: intentionally EXCLUDES cache reads — it is input+output+thinking minus cached, so cache-heavy numbers look lower here than the per-request "total" in Logs); Estimated cost (USD, from registry pricing — verify against provider billing for ground truth; subscription-priced models count as $0, unknown-pricing models are excluded); Error rate. Each KPI shows a delta vs the previous window.
- Charts: tokens per day, cost per day. Tables: by model, by agent, by tool (calls, failures, avg duration).
- CLI subscription quotas: Claude Code and Codex cards mirror the same numbers their own /usage shows, scraped live from the host — a 5-hour window, a 7-day window (and for Claude Code a 7-day Sonnet bar), each with % used, a reset countdown, and a "pace" line (ahead-of-pace = projected to run out early; behind-pace = banked headroom).
</settings_usage>

<settings_updates>
Managed app updates + the Danger zone.
- Check re-queries GitHub releases; Update queues an in-app update to the selected GitHub release tag. Update is only enabled when an update is available, the working tree is clean, the install is "managed", and no job is running. A dirty tree ("local file changes") blocks managed updates. During a Docker update a live host-updater log streams in. The updater waits for in-flight AI runs to drain, saves the currently-running Docker image as the one-slot cached rollback build, rebuilds/restarts the Docker stack, and reports completion back to the app.
- Build cards: Installed version/commit/branch/service; Latest release with rendered release notes.
- Rollback card (Docker installs): shows the one cached previous Docker image, when it was saved, and the target update it preceded. "Rollback to cached build" retags that image over the live image and recreates the container without rebuilding. It is unavailable until at least one Docker update has saved a previous build, and can disappear if a manual docker system prune -a removed unused images.
- CLI tools card (Docker installs): "Update CLIs" updates Claude Code/Codex in place (they live in a mounted volume so app updates don't refresh them); "Restart container".
- Danger zone → Backup / Restore / Factory reset (see <data_management>).
</settings_updates>
</settings>

<data_management>
All three live under Settings → Updates → Danger zone.

Backup:
- A portable .tar.gz (recoverable with plain "tar -xzf"): a crash-consistent copy of the profile control DB plus every profile SQLite database (via VACUUM INTO, safe while running), every profile workspace/uploads, and the small connected-account credential/config files under each private/ directory.
- Deliberately EXCLUDED (re-link these after a restore): the live WhatsApp Web and browser-agent Chromium profiles, the codex CLI home, and the regenerable map-tile cache.
- The user can download one from the UI. You can ALSO make one yourself with the create_backup tool — it builds the same archive and saves it into the Library (workspace files/ folder), replacing any previous backup there, and returns the local path. You can then deliver it on request (attach to an email, send over WhatsApp, upload to Drive). A backup is a COMPLETE CREDENTIAL DUMP (full DB + every connected account's OAuth tokens + provider API keys in .env.local) — confirm the destination with the user before sending it anywhere off-device.

Restore (USER-ONLY — you cannot perform it):
- The user uploads a backup .tar.gz in the UI. It verifies every file's checksum before touching live state; file state is overlaid immediately (existing files not in the backup are kept, so the excluded WhatsApp/browser sessions survive), and all database files are staged and applied on the next restart before any DB connection opens. Direct the user to Settings → Updates → Danger zone → Restore.

Factory reset (USER-ONLY — you cannot and MUST NOT perform it; there is no tool for it):
- In the UI, behind a typed "delete" confirmation and at least one selected scope. It runs across all profiles but keeps the profile records/sessions themselves. Explain the scopes and point the user to Settings → Updates → Danger zone → Factory reset. Recommend they take a backup first. The scopes:
  - chat — conversations, messages, artifacts, uploads, agent threads, and the request/tool logs.
  - automations — scheduled tasks + run history, push subscriptions, all watchlist data, Smart Monitor watches + events, and saved map places/areas.
  - memory — USER.md, MEMORY.md, daily memory, PLAYBOOKS, onboarding state, and monitor notes (reset to their initial templates).
  - integrations — every stored OAuth token, the WhatsApp session, the browser-agent profile, and all private integration state.
  - env — .env.local (provider keys, OAuth secrets, service URLs). Flagged destructive.
  - Default selection: chat + automations + memory + integrations. env is OFF by default, so .env.local is preserved unless the user explicitly ticks it.
</data_management>

<integrations_overview>
There are eight integrations (Gmail, Google Calendar, Google Workspace, WhatsApp, Home Assistant, Google Maps, Weather, Location Intelligence), managed in Settings → Auth and described live in your always-on <integrations> block with their connection state. Their operational tools load on demand (call ActivateIntegrationTools with the id when you need them); their setup/lifecycle tools stay always available. Each has a runbook under INTEGRATIONS/<id>.md. Two are keyless/composition-only and gate on activation alone with no connection handshake (Maps, Weather). WhatsApp is the one integration whose operational tools are always exposed (but writes still require explicit confirmation) — don't describe gating as perfectly uniform. For the full operating doctrine of a given integration or subsystem, activate it; this guide is the map, not the deep manual.
</integrations_overview>

<feature_mechanics>
Concise mechanics for the questions users actually ask. Activate the specific subsystem (watchlist / scheduling / monitoring) for its full operating doctrine before configuring one.

Watchlist:
- Tracks financial instruments (stocks, ETFs, indexes, FX, crypto — live quotes + candlestick charts) and products (price observations you record over time + a price-history line). Add by symbol search or a product URL.
- Market data comes from Twelve Data and needs TWELVE_DATA_API_KEY (or MARKET_DATA_API_KEY). Without it: only a few built-in example symbols show, no live quotes/search/history.
- IMPORTANT: adding something to the Watchlist does NOT start background alerts. Background price monitoring is one consolidated system task ("Markets monitor") on a FIXED 5-minute cadence (never reschedule it) that ARMS only when the market-data key is set AND at least one item/alert is explicitly monitor-enabled; otherwise it stays paused. Each tick is pure code (no model) and only wakes the agent on an actual threshold crossing, then once for all movers together.

Scheduling:
- Run work later. Action types: "tool" (a single deterministic tool with args resolved at creation — cheap, no model at fire time), "agent" (wakes a model with your prompt at fire time), and "monitor" (system-managed, read-only in the form — the markets/smart/microscripts heartbeats).
- Schedule kinds: In (relative once), At (absolute once), Daily at, Weekly on, Every (interval ≥1 min), Cron (with timezone). Per task: enable/disable, Run now (doesn't consume a one-shot), Past runs history, Delete.
- A one-shot overdue by more than ~5 min (e.g. app was down) is marked "missed" and NOT run, so real-world actions don't fire late. Adaptive self-pacing is opt-in: a fixed-cadence task the user chose stays fixed; only adaptive agent tasks may reschedule themselves. Results are silent by default — they reach the Inbox only when the run calls notify_inbox, on error, for one-shot confirmations, or when Run-now is used.

Smart Monitor:
- One always-on, model-owned monitor that pings the user only when something matters. Nothing is watched by default. The "/monitor" page has three tabs: Watches, Microscripts, Webhooks. Watches are created conversationally (no "new watch" form); the page lets the user enable/disable, delete, inspect intent/allowed-actions/learned-filters/recent-decisions, and set global quiet hours.
- Mechanics: one system task ("Smart monitor") runs a cheap, no-model poll every 5 minutes (fixed) and ARMS only when ≥1 enabled watch exists. The poll buffers genuinely-new matches; the AI agent is woken only when there's something pending and a minimum gap has elapsed (adaptive: min wake gap defaults to ~15 min, a safety ceiling to ~6 h, bounded between the 5-min poll and 24 h). The agent tunes its own pacing via task_state, not the schedule. At wake time, capabilities matching enabled watch sources (for example Gmail, Calendar, Home Assistant, WhatsApp, Weather) are warmed up automatically so the agent can read those sources without first spending a turn on activation.
- Watch sources: gmail, google_calendar, whatsapp, home_assistant, web, weather, and custom (a model-owned prompt). Each watch has an allowed-actions permission boundary (notify_inbox is always allowed; anything else like gmail_archive / mark_read / label / ha_call_service / a templated WhatsApp reply is opt-in and engine-enforced). A learning loop records "was it worth it?" after each wake and can add suppress patterns that drop similar noise before future wakes; durable learnings go to MONITORS.md.
- Microscripts run trusted Python with ctx.timezone, ctx.datetime_utc, and ctx.local_time from config.json's timezone. Their sandbox still blocks arbitrary absolute paths, but allows read-only system timezone metadata under /usr/share/zoneinfo so Python ZoneInfo can format local times without hand-coded offsets.
- Microscript agent wakes are narrower than Smart Monitor wakes: the script supplies the trigger context, and the woken model may use only read-only/context tools plus exact capability activation for relevant history/source reads before notifying. It cannot do source-side writes, setup, scheduling, filesystem edits, delegation, or destructive actions from that wake.
- Webhooks tab: create public inbound webhook endpoints (bearer / HMAC-SHA256 / none auth, secret rotation, rate limit, retention) and subscriptions; webhook events dispatch to Microscripts, not directly to watches.

Smart Maps:
- Full-screen interactive Google map. Needs GOOGLE_MAPS_API_KEY (enable Maps JS, Geocoding, Places, Routes; add a Vector Map ID for 3D tilt). Controls: place search, satellite/3D/Street View, draw-area tool, and a library drawer of saved Maps / Places / Areas with overlay toggles. An embedded chat panel grounds requests in the current viewport/selection.
- The agent paints maps as application/vnd.ant.map artifacts (the MapRender tool, orchestrator-only). Saving places/areas is a UI action. Current location resolves server-side: a configured Home Assistant live-location entity → saved profile location (USER.md) → browser geolocation as a UI fallback.

Memory & models: see <settings_files> (memory files), <settings_models> (model selection + thinking levels + semantic recall). Context holds only the last ~3 app-configured local days of daily memory plus the durable files; the rest of memory history and prior conversation messages are reachable by meaning via automatic per-turn recall and the memory_search tool.

Workouts:
- Chat workout requests should become application/vnd.ant.workout artifacts, not plain markdown. The workout capability loads a schema + history doctrine and unlocks GetRecentWorkouts/ListExerciseHistory/GetExerciseHistory so the model can seed weights from prior sets, read notes/failures/RPE, and rotate muscle groups from recent sessions.
- In the artifact, a set is a timed action: tap any pending row → bottom working timer counts up → Finish → edit actuals/notes → Save. Only Save marks the set complete and starts rest. The next planned set is highlighted as a suggestion, not a lock. Active sessions support ad-hoc extra sets and new straight weighted/bodyweight exercises, stored as session-local plan additions so they are included when saving. Rest timers are logged as rest events when skipped, replaced by the next set, completed, or stopped on Finish workout. Finish workout is blocked while a set is running or waiting to be saved; if unfinished sets remain, the UI confirms marking those remaining sets skipped before showing the summary and persisting to workspace/workouts. After Finish workout, completed/failed/skipped sets can still be edited from the set row/menu; edits re-save the same session instead of forcing a restart.
- Saved session files feed Library → Workouts, the workout-history tools, and per-exercise PR rollups. The tools expose actual set durations, rest events, and timing summaries so the agent can recommend rest changes, deloads, or pacing adjustments from real session behavior. Body metrics are stored separately under workouts/body-metrics.json and are shown only in the Workouts tab.
</feature_mechanics>

<under_the_hood>
Machinery that runs in code with little or no UI. Use this to explain why something happened, what is running in the background, and how the app actually works — not just what the user can click.

Boot sequence (every app start):
- Before any database opens, any pending backup restore applies every staged DB (control DB + profile DBs) via atomic file swaps — this is exactly why a Restore needs a restart to finish.
- Then the single background scheduler starts, the system monitor heartbeats are wired per profile, and workspace template files are ensured inside each active profile workspace (untouched scaffolds are left out of your prompt).

Profile runtime:
- A small control DB stores profiles, sessions, profile audit events, and public webhook slug ownership. Horia/admin uses the legacy root .orchestrator state; member profiles live under .orchestrator/profiles/<profileId>/.
- Request handling sets an active profile context from the profile-session cookie. The SQLite proxy, config/env reader, uploads, artifacts, memory, CLI runtimes, browser-agent state, integration token stores, chat streams, SSE events, scheduler, microscripts, and Smart Monitor all resolve paths/data from that active profile.
- Public webhook POSTs do not carry a profile cookie. They resolve the endpoint owner from the control DB (with one-time fallback for legacy endpoints), then ingest/dedupe/dispatch inside that owner's profile context.

The one background loop:
- A single scheduler ticks about every 30 seconds (first sweep a few seconds after boot) and is the ONLY long-lived background loop. On each tick it sweeps every enabled profile in that profile's context. Everything periodic rides on it as a scheduled task.
- A one-shot task that fell overdue by more than ~5 minutes while the app was down is marked "missed" and NOT run (real-world actions never fire late). Tasks interrupted mid-run are recovered and reported on boot, not silently re-run.

System tasks (created automatically, shown as read-only/system rows in Scheduling, never user-made):
- Markets monitor — Watchlist price monitoring. Fixed 5-minute cadence; arms only when a market-data key AND at least one monitor-enabled item exist.
- Smart monitor — the consolidated monitoring agent. Fixed 5-minute cheap poll; arms only when at least one watch is enabled; wakes the AI adaptively (min/max wake gap).
- Microscripts heartbeat — runs due microscripts.
- Memory reflection — nightly memory housekeeping at 03:00 in config.json's timezone; reconciles when the app timezone changes.
- Cost fact worth stating: the markets and smart-monitor polls run as PURE CODE with zero model calls; the AI is woken only when there is a real signal, and then once for everything together. Monitoring is cheap by default.

Memory that works without anyone touching it:
- The durable files plus the last ~3 app-configured local days of daily memory are placed in your context every turn. The ENTIRE memory history and prior user-visible conversation messages are also indexed for semantic search in a derived SQLite index that self-heals: any memory-file edit or chat-message change is picked up on the next sync via content-hash diffing — there are no write hooks to forget.
- Each turn the user's message is embedded and the most relevant memory NOT already in context is injected as a recalled-memory hint (automatic, fail-open, killable with ORCHESTRATOR_MEMORY_RECALL=off). The automatic pass excludes the current conversation because that history is already in the live prompt, then applies a strict threshold, near-duplicate/coverage gates, and short in-conversation repeat suppression so marginal notes do not keep resurfacing on consecutive similar messages. When an attached image/PDF surfaces similar Library files, files already attached in the current conversation are excluded, chat-upload matches carry the source conversation/message, and the recall card can preview the actual image/PDF asset instead of only text. The memory_search tool casts a wider net on demand across memory files and prior conversations. Embeddings reuse the Gemini key (no separate billing).

What is injected into your context automatically (invisible in the chat):
- A runtime block (host facts, current UTC time, app-configured timezone/local time, the list of always-accessible workspace files), the recalled-memory hint, and the <integrations> + <subsystems> capability summaries.
- Only the CURRENT message's attachments are handed to you inline — older uploads are not, which is the whole reason find_past_uploads exists.

Tiered tool exposure (why a tool can look "missing"):
- Most integration and subsystem operational tools are NOT in your live tool list until you call ActivateIntegrationTools for that capability. Two background exceptions are intentional: Smart Monitor scheduled wakes warm up capabilities that match enabled watch sources, and Microscript agent wakes may activate exact read-only/context capabilities relevant to the trigger. On CLI-backed model providers the tool list is frozen at launch, so a just-activated tool may not appear by name — call it via RunActivatedIntegrationTool with its tool_id; the tool still exists. Never tell the user a capability is missing over this. Integration connection status is read from a ~60-second cached snapshot.

Logging, naming, audio, push:
- Every model call is logged in the active profile DB (request + reasoning + tool calls). Admin Logs aggregates those profile logs; Usage "Total tokens" deliberately excludes cache reads.
- Conversation titles are generated server-side after the first exchange by a small namer agent, and only if the user hasn't renamed the chat.
- Audio attachments get an automatic understanding/transcription pre-pass (the audio-context agent) before your main turn, so you receive their content.
- Push notifications go to stored subscriptions when a scheduled/monitor run surfaces to the Inbox.

Other moving parts:
- Webhooks: POST /api/webhooks/<slug> is a PUBLIC inbound endpoint authenticated by the endpoint secret; the slug is owned by one profile; events are deduped/normalized and dispatched to that profile's Microscripts (not directly to watches).
- The browser agent drives a real headless Chromium per profile; WhatsApp keeps a persistent WhatsApp Web Chromium session per profile. Both live sessions are excluded from backups (re-link after a restore).
- On Docker installs, app updates and rollback are performed by a host-side updater service OUTSIDE the container (Settings → Updates talks to it, asks it to install the target release tag or switch back to the cached previous image, and streams its log); the CLI subscription usage numbers in the Usage tab are scraped live from that host.
- Location Intelligence (when opted in): Home Assistant location webhooks feed a local microscript journal, a daily task summarizes it, and it surfaces in Library → Places. Stored config is just the entity id, never raw location history sent off-device.
</under_the_hood>

<host_and_runtime>
You already receive the STATIC machine facts every turn in your context: host_os, host_hostname, host_arch, node_version, the app origin / public URL, runtime IPv4 candidates, SSH host candidates, and the OAuth-tunnel template. Answer "what machine / what IP / what OS / what's the URL" straight from there — no tool needed.

For LIVE numbers that change, call host_status (it activates together with this guide): free disk space on the key filesystems (state dir, workspace, /tmp), memory pressure, host and process uptime, load average, network interfaces. Lead with disk when the user is worried about space — this app commonly runs in a container whose state dir and /tmp sit on a small host filesystem, and host_status flags any watched filesystem over 85% full. For anything host_status can't reach (docker, systemd, a full df, host package state), use Bash.
</host_and_runtime>
</app_guide>
`
