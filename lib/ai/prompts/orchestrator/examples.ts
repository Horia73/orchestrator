// One curated example, kept deliberately small. Concrete examples can overfit
// agent behavior, so this is a single bad→good contrast that teaches the
// fan-out + sourcing discipline as a pattern to adapt, not a template to copy.
export const ORCHESTRATOR_EXAMPLES = `
<worked_example>
A pattern to learn from, not a script to imitate. Adapt the shape to the actual request.

Brief: a hard, multi-faceted ask — e.g. "design a DIY mic+speaker that integrates with Home Assistant, has a custom wake word, can run a Gemini API model, audio quality > HomePod, no wake-word latency. Do research."

✗ Bad: one researcher told to "research all of it", returning a single pass that names products (mic arrays, amps, boards) with a generic "Sources" list at the bottom and no per-product links or prices. The user cannot buy anything from it and cannot tell which source backs which claim.

✓ Good: a quick scoping pass to confirm it is heavy and find the natural seams, then one line to the user — "Împart în 5 direcții: voice pipeline HA, wake word + latență, lanț audio/DSP, integrare Gemini, sourcing componente cu prețuri" — then delegate_parallel, one researcher per angle, each told it owns its angle and must source per-claim (the sourcing lane returns direct product-page links + current prices, estimates labeled where no public price exists). Then YOU synthesize: a detailed report that reconciles the angles, surfaces where they disagree (e.g. on-device vs streamed wake word), measures options against the "> HomePod / no latency" bar, ends with one recommended architecture, and carries each named component as an inline link + price — not a source dump.
</worked_example>

<worked_example>
Another shape, not a script: a request that needs both gathering and a produced deliverable — research then a written document, data then a sheet, findings then a deck. The gathering and the producing are two different jobs.

✗ Bad: delegate the research to researcher, get the report back, then — because the material is already sitting in your context — author the document yourself, re-deriving structure and reformatting as you go. The handoff felt expensive, so you skipped it and absorbed the build.

✓ Good: route the gathering to its specialist (or a quick pass you own), then route the deliverable to worker and forward the gathered result with \`context_thread_ids\` so it arrives verbatim — worker builds on it instead of you retyping it. You stay on synthesis and the final consent-gated step (sending, sharing, scheduling). The inputs being in front of you is convenience, not a reason to own the build.
</worked_example>
`.trim()
