---
name: frontend-design
description: Design and implement distinctive, production-grade frontend experiences for standalone sites, apps, pages, dashboards, demos, and HTML/React artifacts. Use for greenfield frontend creation, visual exploration, screenshot/mockup-to-code, or an explicit redesign; explore visual directions before broad implementation and verify the result in a browser. Do not use for routine Orchestrator UI maintenance.
license: Complete terms in LICENSE.txt
---

# Frontend Design

Build from an intentional visual reference and a real user journey. Do not begin a broad greenfield interface by improvising components directly in code.

## Orchestrator Runtime

- Use this skill for standalone frontend work, explicit redesigns, visual prototypes, and selected mockup/screenshot-to-code tasks.
- Do not apply it to routine Orchestrator UI changes. The Orchestrator UI has an established theme, density, layout, and component system; follow the repository unless the user explicitly requests visual exploration or redesign.
- Respect an existing external product's design system before introducing a new aesthetic.
- For a complete site/app/project, activate `project_dev`, prepare the managed project run, and delegate implementation to `coder`. For a reusable internal mini-app, activate `apps`. Use a self-contained `text/html` or `application/vnd.ant.react` artifact only for a bounded prototype/demo, not as a substitute for a requested full project.

## Route the Task

Choose one route before implementation:

1. **Precise maintenance:** a bounded fix inside an established design system. Skip visual exploration; preserve local patterns and verify the affected state.
2. **Selected visual target:** the user supplied or selected a screenshot, mockup, or generated direction. Treat it as the visual source of truth and move to implementation.
3. **Broad greenfield/redesign:** the visual hierarchy, layout, or product framing is not yet selected. Run the exploration gate below before coding.
4. **Audit only:** activate `product-design-audit`; do not implement unless requested.

## Exploration Gate

For a broad greenfield or redesign request:

### 1. Establish the brief

Identify the primary user/job, most important screen or journey, required content/actions/states, brand/reference material, technical constraints, target viewport, accessibility needs, and what success should feel like. Prefer a focused primary experience over a mockup that inventories every possible feature.

### 2. Generate exactly three independent directions

If `image_generator` is available:

- Call `ActivateIntegrationTools("media")` before authoring production prompts.
- Use `delegate_parallel` for exactly three independent `image_generator` jobs. Generate one image per job, not a collage or three options inside one canvas.
- Keep product requirements, copy, brand constraints, and viewport constant. Vary hierarchy, layout, density, interaction framing, color/typography mood, and product storytelling so the options are genuinely different.
- Name each direction and write a complete UI prompt. Useful targets: mobile `390×844`, tablet `834×1194`, desktop product screen `1440×1024`, landing page `1440` wide.
- Ask for a focused, readable interface with realistic content, clear primary action, 14–16px-equivalent body text, at most two font families, no browser/device chrome, and no card-inside-card default shell.
- Show all three generated mockups as the result of this phase. Do not start implementation until the user makes a selection, unless the user explicitly delegated that choice to you.

### 3. Degrade honestly

If `image_generator` is unavailable or fails because its configured provider/model, API key, quota, or runtime cannot generate images:

- do not silently switch providers and do not claim visual mockups exist;
- provide exactly three concise text directions, each with hierarchy, layout, palette/type mood, signature interaction, and a small Mermaid/SVG/HTML layout sketch when a visual sketch materially helps;
- recommend one direction and ask for selection before broad implementation, unless the user explicitly told you to choose;
- if the user explicitly asked for generated mockup images, report the image-generation blocker and stop after offering the text-direction fallback. Do not turn the fallback into unapproved implementation.

The active text-model provider or its fallback does not change this rule: media availability is determined by the configured `image_generator` route, and a failed media delegation must remain a graceful, visible fallback.

## Implement the Selected Direction

### 1. Resolve the target

Identify one selected/provided visual unambiguously. Catalog its layout regions, hierarchy, spacing rhythm, type roles, color tokens, components, imagery, interactions, responsive implications, and required states. Do not blend unselected directions into the build without user intent.

### 2. Source assets deliberately

Reuse supplied/project/brand assets first. Generate required raster hero art, textures, illustrations, or product imagery through `image_generator` when available; include precise purpose, composition, crop, palette, and negative-space requirements. If generation fails, use legitimate existing/project assets or adjust the design transparently—never fabricate a broken placeholder or pretend a substitute matches the reference.

Use the project's icon library or `lucide-react` for interface icons. CSS gradients, borders, shadows, and geometry are appropriate interface treatments; do not use them to counterfeit required photographic/product assets.

### 3. Build the real experience

Implement the core user journey and meaningful loading, empty, error, validation, success, disabled, hover, focus, and responsive states. Match the selected reference's proportions and visual hierarchy before adding secondary flourish. Use semantic HTML, keyboard-accessible controls, visible focus, adequate contrast, and reduced-motion handling.

Avoid generic AI defaults: context-free purple gradients, arbitrary glass cards, excessive rounded containers, giant marketing headlines inside product tools, fake metrics, decorative motion on every element, and a layout that ignores the user's actual content.

## Browser QA

Run the actual artifact/app and activate `browser` before delegating to `browser_agent`.

1. Capture the implementation at the same viewport and state as the selected visual target.
2. Compare structure, content hierarchy, spacing, typography, palette, imagery, and component geometry.
3. Exercise the critical interaction plus loading/error/success states; inspect console and network errors.
4. Check at least one narrow/mobile and one desktop width when the surface is responsive.
5. Fix P0–P2 discrepancies and repeat until the experience is coherent and the critical flow works.

Do not call a build faithful or production-ready from source inspection alone. State any remaining browser, accessibility, data, or provider limitation in the handoff.
