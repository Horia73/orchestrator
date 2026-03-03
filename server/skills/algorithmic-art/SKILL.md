---
name: algorithmic-art
description: Create original algorithmic art in p5.js with seeded randomness, interactive controls, and a self-contained HTML viewer. Use when users ask for generative art, creative coding, flow fields, particle systems, procedural sketches, plotter-like compositions, or custom p5.js art experiments. Build original work rather than imitating living artists or copying a specific copyrighted style.
license: Complete terms in LICENSE.txt
---

Create original generative art by turning a user prompt into:

1. an algorithmic philosophy (`.md` or inline markdown)
2. a self-contained interactive viewer (`.html`)

Only split the JavaScript into a separate file if the user explicitly asks for that structure. The default output is a single HTML file that works locally in a browser.

## Workflow

1. Distill the conceptual seed from the user's request.
2. Write a short algorithmic philosophy.
3. Implement the piece in p5.js.
4. Wrap it in the provided interactive viewer shell.
5. Tune the parameters until the work feels intentional, reproducible, and worth exploring across seeds.

## 1. Distill the Conceptual Seed

The user's prompt is a starting point, not a rigid storyboard.

Before coding, identify:

- the emotional tone
- the underlying motion or process
- the visual tension (order vs noise, density vs emptiness, geometry vs organic drift)
- the quiet reference or conceptual thread that should be embedded in the system

The reference should be subtle. Someone familiar with the source idea may notice it, but the work must still stand on its own as strong generative art.

## 2. Write the Algorithmic Philosophy

Write a 4-6 paragraph philosophy that describes the computational aesthetic you are about to build.

It should cover:

- what the system is trying to express
- how motion, randomness, and structure relate
- what kinds of forces, relationships, or transformations are central
- how variation should emerge from the seed and tunable parameters

Keep it specific enough to guide the implementation, but open enough that the code still has room for invention.

Avoid repetitive hype. The philosophy should sound deliberate, not inflated.

## 3. Read the Viewer Template First

Before writing HTML, read `templates/viewer.html`.

Use it as the starting point for the final piece.

### Keep

- the overall responsive layout
- the sidebar + canvas structure
- seed controls
- the parameters section pattern
- the actions section pattern
- the self-contained, browser-ready structure

### Replace or Customize

- title and subtitle
- the p5.js algorithm
- parameter definitions
- parameter controls
- the optional colors section
- button labels only if the interaction truly needs different wording

Do not rebuild the shell from scratch unless the user explicitly asks for a very different interface.

## 4. Implement the p5.js System

Let the philosophy drive the algorithm.

Do not start from a pattern menu like "maybe a flow field, maybe particles." Start from the actual behavior the piece needs:

- accumulation
- erosion
- resonance
- branching
- interference
- flocking
- turbulence
- recursion
- packing
- oscillation

The best pattern is the one that expresses the idea cleanly.

### Technical Requirements

#### Seeded randomness

Always make the output reproducible:

```javascript
let seed = 12345;
randomSeed(seed);
noiseSeed(seed);
```

#### Parameter design

Create parameters that expose meaningful dimensions of the system, such as:

- quantity
- speed
- scale
- angular drift
- attraction / repulsion strength
- threshold values
- density
- decay
- palette behavior

Avoid filler controls that do not materially change the work.

#### Performance

The piece should feel polished:

- same seed -> same result
- parameters update predictably
- no accidental frame-by-frame instability unless animation is the intent
- no obvious performance collapse from poorly chosen counts or loops

## 5. Build the Interactive Viewer

The final HTML viewer should be self-contained except for the p5.js CDN import already used by the template.

### Required Viewer Features

#### Seed controls

Keep working controls for:

- current seed display/input
- previous seed
- next seed
- random seed

#### Parameters

Expose the controls that matter for the piece. Use sliders, numeric inputs, toggles, or color pickers as appropriate.

#### Actions

Keep the action area working. The default template supports:

- regenerate
- reset
- download PNG

If the piece needs a different action, add it without removing the basic utility of the viewer.

#### Single-file delivery

The HTML should open directly in a browser. No server, build step, or asset folder should be required unless the user explicitly asks for a larger project structure.

## Output Format

Default deliverables:

1. **Algorithmic philosophy**: markdown or prose that explains the movement and implementation direction
2. **Interactive viewer**: one HTML file with the p5.js code inline

Optional deliverables when useful:

- a separate `.js` file for the sketch logic
- a short README explaining the controls
- a list of favorite seed presets

## Variation and Exploration

The viewer exists so the work can be explored, not just rendered once.

When useful, add:

- a few named seed presets
- a palette toggle
- a motion on/off control
- a gallery note that suggests interesting seeds to try

Do not spam the UI with controls. Keep only the knobs that reveal the character of the system.

## Creative Bar

Aim for pieces that feel intentional and authored:

- strong composition even under randomness
- coherent palette choices
- meaningful interaction between parameters
- no generic "noise for the sake of noise"

Originality matters more than novelty theater. A restrained system with excellent tuning is better than a complicated sketch with no point of view.

## Resources

- `templates/viewer.html`
  - Required starting point for the browser UI shell
  - Keep the layout, seed controls, and action framework
  - Replace the algorithm, controls, copy, and optional color inputs

- `templates/generator_template.js`
  - Reference for p5.js structure and seeded-randomness patterns
  - Use it as implementation guidance, not as a style to copy literally

## Final Reminders

- Build original work.
- Favor process over literal illustration.
- Keep the viewer usable on desktop and mobile.
- The seed should reveal variation inside a coherent artistic system, not produce unrelated images.
