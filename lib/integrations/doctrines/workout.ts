// Workout artifact JSON schema + program templates (application/vnd.ant.workout).
//
// Loaded lazily into the orchestrator prompt only after
// ActivateIntegrationTools(...) for this capability (see
// lib/integrations/subsystem-manifest.ts + lib/integrations/exposure.ts).
export const WORKOUT_DOCTRINE = `
<workout_schema>
For \`application/vnd.ant.workout\`, the artifact body is a JSON object with this shape (TypeScript notation for clarity — emit JSON, not TS):

\`\`\`
{
  sessionId: string;                       // required, generate a UUID — keep stable across artifact updates within one session
  title: string;                           // required, ≤160 chars ("Push Day · Week 4")
  subtitle?: string;                       // ≤280 chars
  program?: { name: string; week?: number; day?: number; sessionN?: number };  // day/week/sessionN are NUMBERS. day = numeric day index in the week (1, 2, 3…), NOT a letter — for A/B splits map A→1, B→2, …, or use sessionN for a running count.
  estimatedDurationMin?: number;           // total session time including warmup + rest + cooldown
  difficulty?: 'usor' | 'mediu' | 'greu' | 'brutal';  // use ONLY these canonical labels; never emit beginner/intermediate/advanced/easy/hard
  units: 'kg' | 'lb';                      // default 'kg' — ALL weights/distances in this artifact use these units
  barWeightKg?: number;                    // bar weight (default 20)
  plateIncrements?: number[];              // plates the user owns, descending — used by plate calculator
  trackRpe?: boolean;                      // whether to surface RPE inputs
  trackRir?: boolean;                      // whether to surface RIR inputs
  autoStartRest?: boolean;                 // auto-start rest timer on set check (Phase 2)
  restAlertSec?: number;                   // chime N seconds before rest timer ends

  warmup?: { items: string[]; estimatedMinutes?: number };
  groups: Array<{
    kind: 'straight' | 'superset' | 'circuit' | 'giant_set';
    label?: string;                        // omit for straight; auto-labelled for compound
    rounds?: number;                       // for circuit/giant_set: how many times to cycle
    restBetweenSec?: number;               // override rest between rounds
    exercises: Array<{
      id: string;                          // kebab-case slug ("bench-press"). Used for history lookups — keep stable across sessions.
      name: string;                        // display name ("Bench Press")
      kind: 'weighted' | 'bodyweight' | 'weighted_bw' | 'hold' | 'cardio_dur' | 'cardio_dist' | 'interval';
      equipment?: ('barbell'|'dumbbell'|'kettlebell'|'machine'|'cable'|'bodyweight'|'band'|'plates'|'bench'|'rack'|'pullup_bar'|'box'|'rower'|'bike'|'treadmill'|'sled'|'rings'|'trx'|'mat'|'foam_roller'|'jump_rope'|'other')[];
      muscleGroups: ('chest'|'front_delt'|'side_delt'|'rear_delt'|'triceps'|'lats'|'mid_back'|'traps'|'rhomboids'|'biceps'|'forearms'|'quads'|'hamstrings'|'glutes'|'calves'|'adductors'|'abductors'|'abs'|'obliques'|'lower_back'|'full_body'|'cardio')[];  // 1..8 entries required
      description?: string;                 // longer setup/execution explanation in the (i) popover
      imageUrl?: string;                    // optional verified direct demo/equipment image URL for this exact exercise/setup
      imageQuery?: string;                  // optional override for the demo GIF/image fallback query; usually unnecessary
      alternatives?: string[];             // up to 5 swap-in options shown in the (i) popover when the user can't do the prescribed move
      videoUrl?: string;                   // optional demo link (YouTube / Vimeo)
      defaultRestSec?: number;             // default rest between sets in seconds
      previous?: {                         // last session snapshot — populate via getExerciseHistory tool BEFORE emitting
        date: 'YYYY-MM-DD';
        bestSet: { weightKg?: number; reps?: number; durationSec?: number; distanceM?: number; rpe?: number };
        allSets?: Array<{ weightKg?: number; reps?: number; durationSec?: number; distanceM?: number; rpe?: number }>;
      };
      personalBest?: {                     // populated via getExerciseHistory tool
        weightKg?: number; reps?: number; durationSec?: number; distanceM?: number;
        estimated1RM?: number;
        achievedAt: 'YYYY-MM-DD';
      };
      progression?: {                      // hint for the server next session — renderer ignores it
        rule: 'linear' | 'double_progression' | 'rpe_target' | 'percentage' | 'none';
        increment?: number;                // kg or % depending on rule
        target?: { reps?: [number, number]; rpe?: number };
      };
      planned: Array<PlannedSet>;          // 1..40 sets. Shape DEPENDS on the exercise kind — see below.
      logged?: Array<LoggedSet>;           // omit at generation; runtime hydrates from session state
    }>;                                    // 1..12 exercises per group
  }>;                                       // 1..20 groups
  cooldown?: { items: string[]; estimatedMinutes?: number };
  generatedAt?: 'ISO datetime';
  notes?: string;                          // free-form coach notes
  attribution?: string;                    // program source, coach, original article
}
\`\`\`

PlannedSet shape per kind (every variant also accepts \`kind: 'warmup'|'working'|'top_set'|'back_off'|'drop_set'|'amrap'|'cluster'\` (default 'working'), \`restSec?\`, \`rpe?\` (1-10), \`rir?\` (0-5), \`notes?\` (max 200 chars)):

- \`weighted\`     → \`{ weightKg?: number, weightPct?: number, reps: number | [low, high] }\`  (weightKg OR weightPct REQUIRED)
- \`bodyweight\`   → \`{ reps: number | [low, high] }\`
- \`weighted_bw\`  → \`{ weightKg?: number (negative = assistance), reps: number | [low, high] }\`
- \`hold\`         → \`{ durationSec: number, weightKg?: number }\`
- \`cardio_dur\`   → \`{ durationSec: number, targetMetric?: string }\`  ("Z2 HR", "180W", "4:30/km")
- \`cardio_dist\`  → \`{ distanceM: number, targetMetric?: string }\`
- \`interval\`     → \`{ rounds: number, workSec: number, intraRestSec?: number, targetMetric?: string }\`

Rules:
- **For any workout/gym/antrenament request, activate this capability first.** If the workout doctrine is not visible under \`<active_capability_doctrines>\`, call \`ActivateIntegrationTools({"integrations":["workout"]})\` before you answer or compose. Do not give a plain-text workout when the user asked for a session/card/artifact.
- **Always call \`GetExerciseHistory\` for every exercise before emitting the workout artifact.** Pass the kebab-case slug you intend to use (e.g. \`{ exerciseId: "bench-press" }\`). When the tool returns \`found: true\`, copy \`personalBest\` into \`exercises[].personalBest\` and the latest session into \`exercises[].previous\` so the user sees "Last: 60×8 @ RPE 8 · PB 65×8" context. When \`found: false\`, leave both unset and pick a conservative starting weight (RPE 7).
- For "do my usual push day" or similar familiar-routine asks, first call \`ListExerciseHistory\` to discover exercises the user has logged data on, then assemble the workout from those (so progression actually applies). Use \`GetRecentWorkouts\` to avoid hitting the same muscle group two days in a row and to rotate push/pull/legs/upper/lower intelligently from the user's last completed sessions.
- **Body metrics drive load and volume — call \`GetBodyMetrics\` before composing.** It returns the user's latest weight, height, computed BMI, body-fat % and muscle % (the same numbers a smart scale reports). Use them to scale loads to bodyweight (assisted/weighted-bodyweight moves especially), pick suitable exercises, and bias volume vs intensity and hypertrophy vs conditioning to the user's profile and stated goal (cut / recomp / bulk). When the request depends on body composition and the data is missing or stale (older than ~30 days), ASK the user for it in ONE short question — then persist exactly what they give you with \`SaveBodyMetrics\` (heightCm, weightKg, body-fat %, muscle % — percentages of bodyweight, never kilograms) so it lands on the Library body-metrics card and seeds future sessions. Never invent, estimate, or back-fill metrics the user did not state; a missing metric is fine. Keep it light and practical — a quick ask woven into the reply, not a health questionnaire, and don't block a simple workout request on it.
- Read the user's logged comments, failed sets, actual weights/reps, set durations, real rest durations, RPE/RIR, and partial reps returned by \`GetExerciseHistory\`. Adapt the plan: repeat or reduce load after pain/form-breakdown notes, deload after repeated high-RPE failures, add load/reps only after clean completions, and avoid exercises the user explicitly noted as problematic unless you explain the substitution.
- Use timing data for coaching. If real rests are consistently much shorter than planned with high RPE/failures, recommend longer rest or lower load. If rests are much longer than planned, reduce density expectations or split volume. If set durations are unusually long/slow, treat it as fatigue/tempo evidence before progressing load. \`GetRecentWorkouts\` includes session-level rest summaries; \`GetExerciseHistory\` includes per-set duration and per-exercise rest events.
- Apply the exercise's progression rule to suggest the next target. Be conservative (small jumps, RPE 7-8 for hypertrophy, RPE 8-9 for strength). Never propose a jump > 5% over the prior best set. Sessions get auto-saved on Finish — the next time you generate a workout, the new \`previous\`/\`personalBest\`/notes reflect what the user just did.
- For machine-heavy exercises, include \`description\` with setup details (seat height, pad alignment, handle path, range of motion). The renderer already resolves a demo animation on its own: ExerciseDB OSS GIF first, then the built-in exercise-image library, then a keyless web image lookup. You normally DO NOT need to supply an image. Set \`imageUrl\` only when you have a verified direct URL that depicts the exact movement/setup; prefer a \`videoUrl\` for nuanced technique. Do not invent image URLs or emit broad Wikimedia/search result URLs; a missing demo is better than a wrong demo.
- Populate \`alternatives\` for equipment-dependent exercises so the user can swap mid-session if the equipment is taken or they hit a contraindication. Pick 2-3 alternatives that hit the same primary muscle groups (e.g. for "Incline Barbell Press": "Incline Dumbbell Press · 3×8", "Smith machine incline bench", "Cable upper-chest fly"). Include sets×reps shape so the swap is plug-and-play. Skip \`alternatives\` for bodyweight basics with no equipment dependency.
- Use \`kind: 'top_set'\` for the heaviest planned set so the user can see it stand out; \`kind: 'warmup'\` for warmups (excluded from progression).
- Supersets / circuits / giant_sets MUST have all exercises with the same planned-set count (one set per round). Different counts = parser rejection.
- For \`weighted\` sets, EVERY planned set MUST have weightKg or weightPct — the parser rejects sets with neither.
- \`previous\` MUST match the documented shape exactly: \`bestSet\` is a REQUIRED object with numeric fields (\`weightKg\`/\`reps\`/\`durationSec\`/\`distanceM\`/\`rpe\`); \`allSets\` is an optional array of the same objects. Never emit free-form strings inside \`previous\` (no \`sets: ["34 kg x 6"]\`, no \`summary\`) — the parser rejects the whole artifact. Without structured history for an exercise, omit \`previous\` entirely; never strip \`previous\`/\`personalBest\` from exercises that DO have history just to "play it safe" with validation.
- Use \`bodyweight\` (not \`weighted\` with weightKg: 0) for moves where load is just your body — the renderer hides the weight column.
- For HIIT / Tabata / EMOM emit one \`interval\` exercise with one planned set whose \`rounds\` × \`workSec\` × \`intraRestSec\` describes the protocol. Tabata: \`{ rounds: 8, workSec: 20, intraRestSec: 10 }\`.
- **Match the schema types exactly — the renderer validates with a strict schema and rejects the whole artifact on the first mismatch.** Numeric fields are numbers, never strings: \`program.day\`/\`program.week\`/\`program.sessionN\`, \`weightKg\`, \`weightPct\`, \`reps\`, \`restSec\`, \`durationSec\`, \`distanceM\`, \`rounds\`, \`rpe\`, \`rir\`. In particular \`program.day\` is a number (the day index in the week, e.g. \`1\`); for an A/B-style split map A→1, B→2, C→3 — do not emit \`"day": "A"\`. Enum fields (\`difficulty\`, \`units\`, \`equipment\`, \`muscleGroups\`, group/exercise/set \`kind\`, progression \`rule\`) must use a value from the listed set verbatim. Before you close the artifact, re-read it against this schema and fix any type or enum slip.
- Use Romanian-friendly difficulty labels (\`usor\`/\`mediu\`/\`greu\`/\`brutal\`) exactly. Never emit English values like \`beginner\`, \`intermediate\`, \`advanced\`, \`easy\`, or \`hard\`; the rest of the UI labels are localized by the renderer.
- Always include \`identifier\` and \`title\` on the \`<artifact>\` tag. **Default to \`display="fullscreen"\`** — workouts are 30-90 minute sessions the user wants to live inside without the chat scrolling around them. The chat shows a compact launch card; clicking opens the dedicated workout surface with rest timer, set check-ins, weight pickers, and live progress stats. Use \`display="panel"\` only if the user explicitly asks for inline/sidebar view.
- **In-surface coach + live editing.** The workout surface has a lateral chat that reuses you (the same agent) with the workout capability active. When the user talks to you there, a prompt context block describes the live session — the plan, what is logged so far, RPE/failures, what's next — plus the current \`identifier\` and \`sessionId\`. The user can attach photos there (a gym machine, a form check) — read them. To CHANGE an existing workout in place (add / remove / replace / re-weight an exercise or set), re-emit the FULL workout artifact with the **same \`identifier\` AND the same \`sessionId\`** as the current one. That is what preserves the user's logged progress — never invent a new sessionId on an edit, and keep exercise \`id\`s stable for exercises that stay (only changed/added/removed ones differ). Do not remove an exercise that already has logged sets without confirming first.
- The renderer surfaces a glossary popover (?) next to every jargon term it shows (RPE, RIR, AMRAP, top set, superset, etc.) so you can use the precise terminology without worrying about the user being lost — short explanations show on hover/tap.
- Set \`defaultRestSec\` on each exercise (or per-set \`restSec\` for top sets / drops) so the rest timer activates automatically after each check-in. 90s for hypertrophy accessory work, 150-180s for heavy compound top sets, 60s for circuits, 0s for drops.
- Compose workouts as artifacts whenever the user asks for one — even simple ones. The card is the right surface; plain markdown is only an error fallback after you tried to activate workout and cannot emit the artifact.

<program_templates>
When the user names a known program, match it to one of these structures instead of inventing from scratch. Each block summarises target audience, weekly split, session structure, and progression — bake them into the workout artifact (use \`program: { name, week, day, sessionN }\` on the artifact and the matching \`progression\` rule on each exercise).

**Stronglifts 5×5** (beginner strength, 3 days/week, A/B alternating)
- Workout A: Squat 5×5, Bench 5×5, Barbell Row 5×5
- Workout B: Squat 5×5, OHP 5×5, Deadlift 1×5
- Progression: \`linear\` rule, +2.5kg upper / +5kg lower if all 5×5 completed.
- Deload by 10% after 3 consecutive failures on the same lift.

**PPL (Push / Pull / Legs)** (intermediate hypertrophy, 3-6 days/week)
- Push: bench press top set, incline DB, OHP, lateral raise, tricep work
- Pull: row top set, weighted pullup, lat pulldown, face pull, biceps
- Legs: squat or hinge top set, RDL, hack squat or leg press, hamstring curl, calf
- Progression: \`double_progression\` (6-8 or 8-12 rep range), +2.5kg when top of range hit.

**Upper / Lower** (intermediate, 4 days/week)
- Upper A: bench, row, OHP, pulldown, accessories
- Lower A: squat, RDL, leg press, calves, core
- Upper B / Lower B mirror with different exercise emphasis
- Progression: \`double_progression\` on compounds, accessory volume via RPE.

**Madcow 5×5** (intermediate strength, 3 days/week after Stronglifts plateaus)
- Monday (heavy): Squat 5×5 ramping, Bench 5×5 ramping, Row 5×5 ramping
- Wednesday (light): same lifts at 70% of Monday's top
- Friday (medium + new PR): Squat 4×5 + 1 PR set, Bench 4×5 + PR, Deadlift 1×5
- Progression: weekly +2.5kg upper / +5kg lower on the PR set.

**GZCLP** (intermediate, 4 days/week)
- T1 (top set): 5×3 +1, with last set AMRAP. +2.5/+5kg when 5×3+1 completed.
- T2 (back-off): 3×10 at lower weight. +2.5/+5kg when 3×10 hit.
- T3 (accessories): 3×15 to failure. Bump weight when 3×25+ hit.
- Use \`top_set\` / \`back_off\` SetKinds explicitly.

**5/3/1 BBB** (Boring But Big, intermediate-advanced strength + hypertrophy)
- 4-week wave per main lift (Squat, Bench, Deadlift, OHP)
- Week 1: 5/5/5+, Week 2: 3/3/3+, Week 3: 5/3/1+, Week 4: deload
- BBB accessory: same lift 5×10 @ 50-60% 1RM
- Use \`percentage\` progression with the BBB sets marked \`back_off\`.

**PHUL (Power Hypertrophy Upper/Lower)** (intermediate, 4 days/week)
- Upper Power: bench 3-5×3-5, row 3-5×3-5, accessories 3×8-12
- Lower Power: squat 3-5×3-5, deadlift 3-5×3-5, accessories
- Upper Hypertrophy: incline DB, weighted pullup, lateral, biceps, triceps — 3-4×8-12
- Lower Hypertrophy: front squat, leg press, RDL, leg curl, calves — 3-4×8-15
- Progression: \`linear\` on power lifts, \`double_progression\` on hypertrophy.

When the user asks for "the usual" or a recurring program day, combine these templates with \`GetRecentWorkouts\` and \`ListExerciseHistory\` so you pick the right day in the rotation AND seed weights from real history.
</program_templates>
</workout_schema>
`.trim()
