# Product-design audit framework

## Flow-level questions

- Is the entry point discoverable and is the user's next action clear?
- Does each step preserve context and reduce uncertainty?
- Are prerequisites, cost/impact, privacy, and irreversible consequences explained before commitment?
- Do validation, loading, empty, error, permission, offline, and success states help the user recover or continue?
- Are defaults safe and useful? Can the user go back without losing work?
- Does the final state clearly confirm what happened and what comes next?

## Screen-level lenses

### Hierarchy and comprehension

Check primary goal/action, heading and grouping, progressive disclosure, reading order, scannability, terminology, and whether important context competes with decorative elements.

### Interaction and feedback

Check affordances, hover/focus/pressed/disabled states, form labels and validation timing, inline feedback, destructive-action confirmation, optimistic state honesty, and whether controls behave consistently.

### Visual system

Check typography roles, spacing rhythm, alignment, color semantics, icon consistency, component reuse, content density, imagery relevance, and whether visual emphasis matches product importance.

### Responsive and state resilience

Check representative desktop and narrow/mobile widths, long labels, localization expansion, dynamic content, keyboard overlays, scroll/overflow, sticky elements, tables/charts, and empty or dense data states.

### Accessibility signals

From screenshots, note visible contrast risk, reliance on color alone, apparent target size, text legibility, zoom/reflow risk, and missing visible focus only when focus state was actually captured. Use interactive/DOM checks for semantics, labels, keyboard order, focus management, and screen-reader behavior.

## Finding template

For each actionable issue record:

- priority and short title;
- evidence: exact screen/step and observed state;
- user consequence and affected task;
- recommendation stated as an outcome, not arbitrary styling;
- confidence and any validation still needed.

Example: `P1 — Error recovery loses entered address. Evidence: 03-payment-error returns to an empty shipping form after card decline. Consequence: users must repeat high-effort input and may abandon. Preserve form state and move focus to the inline payment error; verify with keyboard and mobile flows.`

## Report shape

1. **Verdict:** one paragraph on critical-path health.
2. **Flow status:** numbered steps with pass/risk/block and evidence id.
3. **Prioritized findings:** P0/P1 first, each tied to evidence.
4. **Top changes:** the smallest set with greatest expected impact.
5. **Strengths to preserve:** specific successful patterns, not generic praise.
6. **Coverage limits:** blocked states, missing devices/data, and claims not tested.
