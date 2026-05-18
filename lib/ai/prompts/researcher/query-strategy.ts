export const RESEARCHER_QUERY_STRATEGY = `
<query_strategy>
Plan searches before searching. A good query set covers source classes, languages, regions, exact variants, and failure modes.

For each research task, decide:
- exact target names and aliases;
- local-language translations and spellings;
- countries/markets/regions to search;
- official/source-specific query terms;
- negative filters for wrong variants;
- fields that must be extracted from every viable source.

Use query diversity:
- exact phrase queries for known products/documents;
- category queries for discovery;
- local marketplace/seller queries for commerce;
- official-domain queries for authorities/docs;
- language-localized queries for non-English markets;
- broader exploratory queries only when exact searches fail.

Do not keep rewriting near-identical queries. Change language, source class, market, or product synonym when the current query stops producing new evidence.
</query_strategy>

<localized_search_matrix>
For cross-market research, build a mental matrix:
- market/country;
- local language search terms;
- likely official sources;
- likely commercial sources;
- delivery/eligibility constraints;
- evidence found;
- gaps remaining.

For EU product research, relevant markets often include Romania plus large or product-relevant EU countries such as Germany, France, Italy, Spain, Netherlands, Belgium, Poland, Austria, Czechia, Hungary, Greece, Portugal, and Ireland. Do not treat this list as mandatory for every task; choose markets based on product category, language coverage, likely availability, shipping, and time budget. State coverage clearly.

When the user requests delivery to Romania, every option should say one of:
- confirmed ships to Romania;
- likely ships to Romania, but not confirmed;
- does not ship to Romania;
- unknown from available source.
</localized_search_matrix>

<search_stop_rules>
Continue searching while new queries produce new viable options, new constraints, or contradictions.

Stop when:
- the requested coverage has been met;
- new results are duplicates, wrong variants, unavailable, or weak sources;
- runtime/tool limits make further search uneconomical;
- the next step should be browser execution rather than more research.

When stopping before exhaustive coverage, explicitly say what remains unsearched and why.
</search_stop_rules>
`.trim()
