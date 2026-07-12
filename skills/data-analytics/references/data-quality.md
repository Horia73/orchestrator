# Data-quality assessment

Load this reference when the user asks whether data is trustworthy, when sources conflict, or before a consequential analysis whose input quality is not already established.

## Establish the contract

Define:

- intended use and consequence of a wrong answer;
- expected row grain and unique key;
- authoritative source and refresh cadence;
- required fields, valid ranges/enums, and cross-field rules;
- expected date/timezone semantics and coverage window.

## Profile the evidence

Measure, as applicable:

- row/column counts, types, distinct values, nulls, blanks, and placeholder values;
- duplicate keys and records at an unexpected grain;
- invalid categories, impossible dates/ranges, malformed identifiers, and unit mismatches;
- orphaned foreign keys, join multiplication/dropout, and totals before versus after joins;
- freshness, late-arriving data, missing periods, volume breaks, and partial current periods;
- distribution changes, extreme values, structural zeros, and abrupt discontinuities;
- reconciliation against an independent control total or trusted report.

Do not auto-fix during assessment. Quantify the impact first and preserve the original data.

## Classify findings

- **Blocking:** the intended decision cannot be supported safely, such as unknown grain, broken join, missing denominator, stale period, or unreconciled material totals.
- **Material but bounded:** analysis can continue for a stated subset/range or with a sensitivity bound.
- **Informational:** small issues unlikely to change the conclusion but worth recording.

For each issue include evidence, affected scope, likely consequence, and the smallest remediation. Distinguish verified defects from suspicious patterns that still need owner/context confirmation.

## Output shape

Lead with a readiness verdict: ready, ready with caveats, or not ready. Then provide critical findings, quantified impact, safe-use boundaries, remediation order, and the checks/calculations used. Save reproducible profiling code or a workbook/notebook companion for substantial reviews.
