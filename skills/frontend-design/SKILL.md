---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces for new standalone web apps, pages, dashboards, demos, HTML/React artifacts, or visual prototypes. Use for user-requested frontend creation or visual polish of a standalone experience; do not use for ordinary Orchestrator product UI maintenance, where the existing app theme and local component conventions win unless the user explicitly asks for a redesign.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, artifact, demo, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Orchestrator Runtime

Use this skill for new standalone frontend work: websites, landing pages, dashboards, visual prototypes, HTML artifacts, React artifacts, or app-like demos.

Do not apply this skill to routine Orchestrator UI code changes. Orchestrator has its own theme, density, layout, component patterns, and product constraints; when editing the Orchestrator app itself, follow the existing codebase and design system unless the user explicitly asks for a creative redesign or visual exploration.

If the task is an existing external app, respect that app's existing design system first and use this skill to raise quality within those constraints. If the task is a fresh app or artifact, choose a stronger original direction.

For Orchestrator artifacts:
- `application/vnd.ant.react` artifacts should be self-contained React components that export a default component and use the runtime-provided libraries.
- `text/html` artifacts should be self-contained HTML/CSS/JS.
- For substantial standalone apps, prefer `display="panel"` or `display="fullscreen"` when the parent agent will emit the artifact.
- Keep chat-inline artifacts compact and host-friendly; avoid full-page shells when the artifact is meant to sit inside the conversation.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.
