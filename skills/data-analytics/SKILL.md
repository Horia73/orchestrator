---
name: data-analytics
description: Analyze structured data, metrics, dashboards, query results, spreadsheets, and business evidence. Use for data-quality checks, KPI or metric diagnostics, quantitative comparisons, charting, decision analysis, and durable evidence-backed reports; do not use for purely mechanical file reformatting with no analytical question.
---

# Data Analytics

Turn quantitative evidence into a trustworthy answer, not a pile of calculations. Preserve source identity, validate the data before drawing conclusions, and make uncertainty visible.

## Orchestrator Runtime

- For substantial work, delegate to `worker` and name `$data-analytics` in the handoff. Keep only small bounded checks in the parent agent.
- Use the user's attachments and workspace files first. Use connected integrations only when their data is relevant and authorized; use web research for external facts, not as a substitute for the user's primary data.
- Activate the relevant file skill for `.xlsx`/`.csv`, PDF, DOCX, or PPTX inputs. Never infer spreadsheet contents from a screenshot when the underlying file is available.
- Use Python/SQL/shell or a reproducible notebook/scratch file for non-trivial transformations. Save user-kept supporting files under `files/`.
- Deliver through the existing surface that fits the request: inline answer for a bounded lookup; `.xlsx`, `.pdf`, `.docx`, or `.pptx` when requested; `text/html` or `application/vnd.ant.react` for a self-contained analytical artifact; `apps` for a reusable internal dashboard; `project_dev` for a complete standalone analytics app. Do not invent a new artifact type.

## Workflow

### 1. Frame the decision

State the question, audience, intended use, metric or outcome, population/grain, period, comparison basis, and decision threshold. Ask only for missing information that could materially change the analysis.

### 2. Build a source ledger

Record every material source with its exact file/dataset/query identity, relevant sheet/table/range, extraction time, filters, and known limitations. Never invent provenance. Preserve source artifacts and transformation code.

### 3. Validate before analyzing

Read [references/data-quality.md](references/data-quality.md) when trustworthiness is uncertain or the result will drive a decision. Check schema, grain, completeness, uniqueness, validity, consistency, referential integrity, timeliness, joins, and suspicious distribution shifts. Classify issues as blocking, material-but-bounded, or informational.

If a blocking issue makes the requested conclusion unsafe, stop that conclusion and explain the smallest remediation. Continue only with explicitly bounded analysis that remains defensible.

### 4. Analyze the question

Use a direct calculation for simple questions. For a changed or surprising metric, read [references/metric-diagnostics.md](references/metric-diagnostics.md) and decompose totals, mix, and within-segment effects before proposing a driver. Separate observation, inference, and causal claim.

Keep an audit trail of definitions, filters, denominators, assumptions, omitted rows/segments, and calculation logic. Cross-check important totals with an independent calculation where practical.

### 5. Choose evidence, not decoration

Read [references/visualization-and-reporting.md](references/visualization-and-reporting.md) before building charts or a durable report. Every visual needs a question, supported claim, honest scale, units, denominator, timeframe, readable labels, source identity, and adjacent interpretation. Prefer a table or prose when a chart adds no clarity.

### 6. Deliver answer-first

Lead with the decision-relevant result. Follow with the strongest evidence, interpretation, caveats that could change the conclusion, and a practical next step. A report must stand on its own; a chat summary is not a substitute for an explicitly requested report artifact or file.

### 7. Validate the rendered result

Reopen or render the actual deliverable. Confirm totals, labels, sorting, date/timezone handling, percent scales, missing-data treatment, source affordances, responsive layout, and that each recommendation is supported. Fix failures before handoff.

## Guardrails

- Do not silently coerce malformed values, drop outliers, fill missing data, or change definitions.
- Do not claim causality from correlation or a single before/after comparison.
- Do not use precision that the source quality cannot support.
- Do not expose credentials, private URLs, raw secrets, or unrelated personal data in outputs.
- Do not turn a report into a dashboard grid unless monitoring/exploration is the actual job.
