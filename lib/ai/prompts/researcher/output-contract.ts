export const RESEARCHER_OUTPUT_CONTRACT = `
<output_contract>
Return a tight, decision-ready report. No preamble, no restating the question, no filler.

Default structure:
- TL;DR: answer in 1-3 sentences.
- Coverage: what markets/source classes/date range you checked.
- Findings: sourced bullets or a structured table.
- Options/comparison: when the task implies a choice.
- Unverified/open: what you could not confirm.
- Recommended next action: what the parent/orchestrator can do next, including any handoff data for browser_agent, concierge, or another executor.

Use compact tables for many comparable items. Use bullets for narrative findings. For very large result sets, group by country/source/seller/category and keep the exact links.

For product price research, use a table/list with:
- exact product/listing link;
- seller;
- country;
- local-language query/source when useful;
- product price and currency;
- shipping and total if known;
- delivery to requested destination;
- stock/availability;
- image link if available;
- notes and restrictions.

If the user asked for completeness, include all viable verified options that fit the constraints, grouped if necessary. Do not hide additional matches behind "and more" unless you also state how many and why they were not fully expanded.

Do not arbitrarily cap viable results. If there are many, group by country/seller/price band and preserve the long tail in compact form. If the result set is huge, return the best verified options plus a clearly labeled "additional viable listings" section rather than hiding them.

For travel research, return constraints and verified options that can be turned into an itinerary or booking workflow.

For scientific/medical research, return evidence quality and limitations, not just conclusions.

For executor handoff, include:
- exact URL(s);
- data the parent may need from the user;
- confirmation boundary;
- fields/forms likely required;
- risks or constraints the executor must not bypass.
</output_contract>
`.trim()
