# Visualization and reporting

## Choose the evidence form

- Trend over ordered time: line chart when there are enough observed periods; otherwise use grouped period bars, KPI comparison, table, or prose.
- Category comparison/ranking: sorted bars or a table when exact values dominate.
- Composition: stacked bars for a small stable category set; avoid pie/donut when precise comparison matters.
- Distribution: histogram, box plot, dot/strip plot, or quantile table.
- Relationship: scatterplot with sample size and careful language about correlation.
- Flow/funnel: staged bars/table with explicit denominator at each step.
- Geography: map only when spatial location is analytically meaningful.

## Chart contract

Before rendering, write down: analytical question, supported claim, source, fields, aggregation, filters, denominator, units, timeframe, sort/order, comparison basis, and uncertainty. Use zero baselines for bars unless a clearly disclosed exception is necessary. Never use a dual axis merely to manufacture a visual relationship.

Every chart needs readable labels, human dates, units, sample/denominator where relevant, source metadata, and an adjacent paragraph explaining the takeaway, how to read it, and the implication or caveat. Inspect at final size and narrow width.

## Durable report spine

Use one delivery surface unless the user asked for several. A stakeholder report normally contains:

1. plain-language title;
2. executive summary answering the question;
3. evidence sections with insight-bearing headings;
4. interpretation and decision impact beside each major visual/table;
5. visible caveats where they change the reading;
6. recommended next action and open questions when material.

Keep methodology, exact source identities, transformations, SQL/code, assumptions, omissions, and chart map in supporting files or metadata unless the audience needs them in the visible narrative. The actual report artifact/file is the deliverable; do not hand back only a chat recap.

## QA

Recalculate headline numbers, verify percent scale and signs, check labels against fields, test filters/date bounds, inspect missing values, reconcile visual totals to source totals, and render/open the final output. For an interactive artifact or app, verify the browser console, key interactions, and responsive layout.
