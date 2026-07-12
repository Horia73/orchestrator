# Metric diagnostics

Load this reference when a metric changed, differs from expectation, or disagrees across sources.

## Diagnostic sequence

1. Lock the exact metric formula, numerator, denominator, unit, population, grain, timezone, period, and comparison baseline.
2. Validate freshness, source coverage, joins, deduplication, and whether the current period is complete.
3. Establish the pattern: magnitude, direction, onset, persistence, seasonality, and whether it is isolated or broad.
4. Choose a small set of decision-relevant cuts such as product, plan, geography, platform, channel, cohort, or customer type. Avoid indiscriminate slicing.
5. Reconcile segment totals to the overall metric.
6. Decompose the change into volume, rate, and mix where possible. Separate composition shifts from within-segment movement.
7. Test candidate drivers against timing and counterexamples. Use sensitivity checks for small samples, outliers, or definition choices.
8. Label the conclusion as observed, likely/inferred, or causally supported. State what evidence would change it.

## Useful decompositions

- Total = count × average value.
- Conversion = conversions / eligible opportunities; check both numerator and denominator.
- Weighted rate = sum(segment weight × segment rate); distinguish weight changes from rate changes.
- Revenue change = customer/transaction volume, mix, price, discount, churn/retention, and FX where relevant.
- Funnel change = entry volume plus step-specific pass-through rates, with stable cohort windows.

## Report shape

Lead with what changed and the strongest supported explanation. Show the smallest number of cuts that prove the point, reconcile them to the total, state competing explanations and uncertainty, then recommend the next decision or measurement. Do not present an exhaustive slice dump as diagnosis.
