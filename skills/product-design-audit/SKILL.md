---
name: product-design-audit
description: Audit a product flow, user journey, funnel, onboarding, checkout, settings path, screen, or responsive experience from screenshots and browser evidence. Use for UX/UI critique, usability and visual-hierarchy review, state/interaction audits, and prioritized product-design recommendations; capture evidence before judging.
---

# Product Design Audit

Audit what users can actually see and do. Screenshots and observed states are evidence; memory of the product, generic heuristics, and assumptions are not.

## Orchestrator Runtime

- For a live product, activate `browser` and delegate to `browser_agent` with the exact URL, account/session constraints, viewport, flow steps, evidence checkpoints, and stop boundary. Use its persistent session when logged-in state matters; use incognito only for a clean logged-out path.
- For supplied screenshots, forward their attachment ids to the inspecting agent or copy them into the workspace when local inspection is needed. Inspect every image returned; do not audit from filenames alone.
- For Orchestrator itself, activate `self_dev` only if implementation or a managed preview is requested. For an external project, use `project_dev` only when implementation is requested. An audit request alone is read-only.
- Use `frontend-design` after the audit only when the user asks for visual exploration/redesign. Do not turn critique into an unapproved build.

## Workflow

### 1. Define the audit contract

Establish the product, target user, job to be done, entry and success states, critical path, device/viewport, known constraints, and requested emphasis. If the user names no emphasis, cover task success, hierarchy, interaction clarity, feedback/states, consistency, accessibility signals, responsiveness, and trust.

### 2. Build an evidence plan

Read [references/audit-framework.md](references/audit-framework.md). List the minimum screens/states needed to represent the flow, including validation/error/empty/loading/success states where reachable. For multi-step work, use numbered evidence names such as `01-entry`, `02-form-filled`, `03-validation`, `04-success`.

### 3. Capture before judging

Walk the actual flow. Capture each meaningful state and inspect every screenshot immediately. Record viewport, step, action, visible result, console/network issue when relevant, and any blocked/unreachable state.

Never claim complete-flow coverage when authentication, data, permissions, or another blocker prevented reaching a state.

### 4. Analyze the journey and screens

First assess whether the flow lets the user understand, act, recover, and finish. Then assess each screen's hierarchy, information architecture, copy, affordances, form behavior, state feedback, visual system, density, responsive behavior, and accessibility signals.

Tie every finding to a specific step/screen and visible evidence. Distinguish observed defect, likely usability risk, and optional taste-level enhancement.

### 5. Prioritize

Use impact × frequency × confidence × effort, then assign:

- **P0:** blocks the critical task, causes loss/security risk, or makes the flow unusable;
- **P1:** materially harms completion, comprehension, trust, or accessibility;
- **P2:** noticeable friction or inconsistency with bounded impact;
- **P3:** polish or speculative improvement.

Do not let a long list of cosmetic notes bury the few changes that affect task success.

### 6. Deliver and stop

Return an answer-first audit with verdict, flow status by step, prioritized findings, top recommended changes, strengths worth preserving, and evidence/coverage limits. If implementation was not requested, stop there.

If the user asks for fixes, hand the prioritized acceptance criteria into the appropriate development workflow, then re-run the audited path and compare the same states/viewports.

## Evidence Limits

Screenshots can support findings about visible contrast, hierarchy, density, labels, layout, and apparent states. They cannot by themselves prove keyboard behavior, semantic HTML, screen-reader labels, focus order, touch target size, dynamic errors, performance, or full accessibility conformance. State those limits and test interactively when the claim matters.
