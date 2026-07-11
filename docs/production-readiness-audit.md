# Production Readiness Audit

Snapshot: 2026-07-12, Orchestrator v1.3.134.

## Executive summary

The application is already on a strong production baseline: strict TypeScript passes, ESLint passes, the production build succeeds, the dependency audit reports no known production vulnerabilities, sensitive API routes have a centralized request/profile guard, persistent data has backup/restore and retention flows, and CI covers typecheck, lint, build, and monitor smoke tests.

The best low-risk optimization was client bundle splitting. Optional settings tabs, document viewers, image annotation, and heavy artifact renderers were previously part of initial route bundles even when unopened. They now load on demand. Dead UI files and unused Deck.gl packages were also removed. The Docker image now exposes a real health check, backed by the intentionally public, no-work `/api/ping` endpoint.

The lifecycle audit also found concrete long-uptime risks: several module-scoped caches and rate-limit maps had no hard bound, weather TTL entries were only evicted when the same key was read again, and deleted profiles could leave SQLite handles open. These are now bounded or explicitly closed. Live production telemetry does not show a monotonic Node heap leak in the observed window, but it does show a meaningful high-water mark, so post-deploy memory monitoring remains appropriate.

The managed-update drain was close but not complete. It only enumerated chat streams for the request's active profile, and async setup could finish after the final idle check. Updates now inspect every profile and close a process-wide admission barrier at handoff; already-registered work drains normally, late chat/Inbox starts receive a retryable maintenance response, and a scheduled claim that loses the race is restored without consuming the schedule.

## Measured baseline

| Area                         | Result                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| TypeScript/TSX/MJS volume    | 277,726 lines across app, components, hooks, lib, MCP, and scripts |
| TypeScript application files | 1,056                                                              |
| Client component files       | 248                                                                |
| API route handlers           | 187                                                                |
| Smoke-test files             | 83                                                                 |
| Production build             | Pass; 103 generated route entries                                  |
| Typecheck                    | Pass                                                               |
| ESLint                       | Pass                                                               |
| Production dependency audit  | 0 known vulnerabilities                                            |
| Duplicate code               | 0.44% of analyzed lines (40 clones, 1,082 lines)                   |

Duplicate code is low enough that broad deduplication would add abstraction and regression risk without a meaningful payoff. The reported clones are mostly parallel provider adapters, similar CRUD routes, and intentionally related UI controls.

## Bundle impact

Approximate unique route JavaScript, gzip-compressed, measured from Next.js client reference manifests:

| Route         | Before |  After | Change |
| ------------- | -----: | -----: | -----: |
| Settings      | 710 KB | 114 KB |   -84% |
| Main chat     | 540 KB | 406 KB |   -25% |
| Inbox         | 507 KB | 371 KB |   -27% |
| Scheduling    | 480 KB | 367 KB |   -24% |
| Artifact page | 505 KB | 397 KB |   -21% |
| Maps          | 534 KB | 458 KB |   -14% |

Optional chunks still download when their feature is opened, so functionality is preserved while the initial critical path is smaller.

## Architecture overview

- `app/`: Next.js App Router pages, loading states, file routes, and API handlers. Server components perform profile checks before protected pages render.
- `components/` and `hooks/`: client UI, the chat store/reducer, route surfaces, artifacts, document previews, settings, maps, monitoring, and workouts.
- `lib/ai/`: provider adapters, agent runner, prompt assembly, tool registry/executors, fallback logic, concurrency control, and background jobs.
- `lib/integrations/`: Gmail/Google, WhatsApp, Home Assistant, MCP, connection state, exposure policies, and product doctrines.
- `lib/scheduling/`, `lib/monitoring/`, `lib/microscripts/`: persistent scheduled work and model/deterministic background execution.
- `lib/db.ts` and domain stores: per-profile SQLite state under `.orchestrator/`, with schema initialization, retention, backup, and restore support.
- `lib/instrumentation/node-boot.ts`: lazy boot wiring for the scheduler, follow-up sweep, job watcher, memory watchdog, status prewarm, monitors, reflection, capability audit, and update confirmation.
- `scripts/start.mjs`: custom production HTTP/WebSocket server for Next.js, voice, and dev-preview upgrade routing.
- `scripts/` and `.github/workflows/`: smoke coverage, release/update flows, install/doctor tooling, CI, and GitHub releases.

The architecture is domain-oriented and generally coherent. Complexity is concentrated in a few orchestration and UI hot spots rather than spread uniformly.

The line count is therefore mostly product breadth rather than copy-paste: 36,384 lines are in AI/providers/tools, 23,586 in operational and smoke scripts, 22,473 in Settings, 21,979 in artifact UI, 17,810 in integrations, 16,705 in API routes, and 10,609 in the browser-agent runtime. The repository has 187 API route files and 83 smoke files. Some large files, notably the map iframe runtime, contain intentionally embedded sandbox code and should not be judged by raw LOC alone.

## Memory and resource lifecycle

Production was inspected read-only on `polybot-linux`. The running container had zero restarts and no OOM kill. Recent watchdog samples showed the main Node process moving between roughly 253–272 MB heap and 540–552 MB RSS, including a visible garbage-collection sawtooth rather than monotonic growth. The container total was about 943 MB at the later sample; cgroup accounting attributed approximately 565 MB to anonymous memory and 440 MB to reclaimable file cache, while `ps` showed the Node process at about 566 MB RSS. Container memory must therefore not be mistaken for Node heap alone.

A fresh local production start from the optimized build reached `/api/ping` at roughly 344 MB RSS. The live production container was about 568 MB during the final check. This supports the conclusion that the observed multi-gigabyte development footprint is not representative of `next build` + production start.

Static lifecycle review covered timers, DOM listeners, observers, EventSources, global background loops, process-wide singletons, database handles, and module-scoped maps. Browser live view, CLI terminal, Updates, scheduler, watchdog, and the iframe sandbox all have corresponding cleanup or intentional process-lifetime ownership. No active timer/listener runaway was found. The concrete unbounded-retention issues fixed were:

- three duplicate Shiki HTML caches, now one shared LRU capped by both entries and retained characters, with in-flight request deduplication;
- recipe image, app-binding, integration-status, historical-weather, pollen, radar, and pending-weather-artifact caches, now hard-bounded;
- image-search and webhook rate-limit buckets, now using one bounded sliding-window implementation;
- app-binding lookups, now aborted after ten seconds and always removed from the in-flight map;
- per-profile SQLite connections, now closed and forgotten before profile deletion.

Dedicated smoke coverage verifies LRU eviction/weight budgets, rate-window expiry, SQLite handle closure, SSE byte-boundary parsing, stream terminal-message fallback, and artifact-event bridging.

## Main maintainability hotspots

Complexity was measured in addition to LOC. The following are rewrite candidates in priority order; the recommendation is incremental extraction with behavior tests, not full-file replacement:

| Priority | Hotspot                                                  | Evidence                                                                   | Decision                                                                                                                                                                                           |
| -------- | -------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | `hooks/use-chat-store.tsx`                               | 3,479 lines; provider 3,300 lines; stream event handler was complexity 256 | Started now: SSE wire parsing, terminal message construction, and artifact bridging are separate tested units. Event-handler complexity fell to 184. Next extract tool and agent event processors. |
| P0       | `app/api/chat/route.ts`                                  | 2,295 lines; `POST` 2,132 lines; stream `start` 1,119 lines/complexity 61  | Extract provider-run lifecycle and terminal persistence together, guarded by route-level stream tests. Do not replace the route wholesale.                                                         |
| P1       | `components/chat-view.tsx`                               | 3,561 lines; component complexity 90                                       | Split scroll restoration, composer/layout coordination, and message viewport into hooks/components when adding UI tests.                                                                           |
| P1       | `components/app-sidebar.tsx`                             | component 1,300 lines/complexity 68                                        | Extract conversation-tree state and navigation sections; lower risk than chat transport but less runtime value.                                                                                    |
| P1       | `lib/browser-agent-runtime/browser.ts`                   | 3,220 lines; manager 2,839 lines; launch complexity 40                     | Split action dispatch and browser lifecycle behind the existing manager interface.                                                                                                                 |
| P2       | map place UI, image editor, message bubble, Profiles tab | 1,300–2,881 lines; complexity 35–89                                        | Refactor alongside feature work; these are render-heavy domain surfaces, not current leak sources.                                                                                                 |

`chat-store-reducer.ts` also reports high cyclomatic complexity because a large discriminated-action switch counts each case. It is large, but this metric alone is not a rewrite reason: the reducer is pure and already centralizes state transitions. `lib/db.ts` is similarly large because it owns the schema; its lifecycle issue was fixed directly rather than risking a schema-layer rewrite.

## Changes completed in this audit

- Lazy-loaded all Settings tab implementations.
- Lazy-loaded PDF, Office, code, markdown, HTML, CAD, SVG, and image-annotation viewers.
- Lazy-loaded heavy map, weather, recipe, workout, CAD, and dev-preview artifact renderers.
- Removed three unreferenced UI components (502 lines).
- Removed four unreferenced Deck.gl packages (44 installed packages including transitives).
- Made `/api/ping` match its documented public reachability contract and added regression coverage.
- Added a Docker health check against `/api/ping`.
- Added an application-level route error fallback with retry and an error reference.
- Added client bundle budgets for chat, Settings, and Inbox to CI and release checks.
- Added a reusable entry/weight-bounded LRU and replaced all confirmed unbounded runtime data caches in the audited surfaces.
- Added one bounded sliding-window rate limiter for image-search and webhook ingress.
- Closed cached profile databases before profile deletion.
- Extracted and tested chat SSE transport, terminal message construction, and artifact-event bridging from the chat-store monolith.
- Closed the update lifecycle race with cross-profile stream enumeration and an atomic top-level AI admission barrier covering chat, Inbox replies, and scheduled runs.
- Preserved scheduled claims that meet the update barrier so the lifecycle event is not recorded as an application failure.
- Reordered Docker layers so build provenance and changing app output no longer invalidate apt, Python, Node, CAD, or Patchright layers. Patchright and the one-slot rollback image remain intact; consecutive images can share the heavyweight runtime layers.

## AI Provider comparison note

The extracted `agenticweb-provider` retains the same core Codex/Claude subprocess adapters, but not Orchestrator's surrounding lifecycle guarantees: there is no active-run drain, no graceful HTTP shutdown, no top-level retry/fallback/persistence layer, and chat/session SSE cancellation delegates entirely to the incoming request signal. Its production container also runs without an init/reaper. On 2026-07-12 it was healthy (0 restarts, no OOM, about 539 MiB) but had accumulated 85 direct zombie children under PID 1 in roughly one day; Orchestrator's `tini`-based container had zero. The provider's first operational fix should be an init/reaper, followed by route-owned abort controllers and graceful shutdown/drain.

## Prioritized follow-up backlog

### High value, incremental

1. Add browser tests around lazy feature entry points (open a file preview, switch Settings tabs, render one artifact of each heavy type).
2. Continue the chat stream extraction with tool and agent event processors, then add a simulated full-turn stream test before touching retry/recovery.
3. Add a small boot-readiness probe if operations need to distinguish “HTTP process alive” from “SQLite and background wiring ready.” Keep `/api/ping` as the liveness probe.

### Worth doing when nearby code changes

1. Consolidate the three Google integration config routes through a shared validated helper.
2. Consolidate repeated image/PDF conversion route plumbing.
3. Standardize provider streaming error/usage normalization behind shared helpers.
4. Review exported-but-internal symbols module by module; static analysis reports many false positives because tools and runtime files are registered dynamically.

### Avoid as standalone projects

- Repository-wide “god file” splitting without behavioral tests.
- Abstracting every duplicate reported by clone detection.
- Removing manual scripts or runtime assets solely because static import analysis cannot see path/URL-based loading.
- Pruning document-generation dependencies used by bundled runtime skills.

## Production checklist

- [x] Clean, synchronized Git baseline before changes
- [x] Strict typecheck
- [x] ESLint
- [x] Production build
- [x] Production dependency security audit
- [x] Central API/profile request guard
- [x] Container liveness health check
- [x] Graceful route-level UI error recovery
- [x] CI and release workflows
- [x] Backup/restore and retention mechanisms
- [x] Full smoke suite after the final change set
- [ ] Live server verification after deployment
