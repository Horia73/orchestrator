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

Whenever you name a specific buyable product or component as an option or recommendation — not only on explicit price-research tasks — give it a direct link to its OWN product/listing page (never the brand homepage or a search URL) and its price. Use a table/list with:
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

If a product has no public web price (bespoke, industrial, used-only, made-to-order), return a clearly-labeled estimate with a range and its basis (secondary sources, community/forum figures, or your own knowledge) rather than omitting price — never return a named product with no price signal at all. If you cannot find a real product page, say so instead of linking the brand homepage as a substitute.

If the user asked for completeness, include all viable verified options that fit the constraints, grouped if necessary. Do not hide additional matches behind "and more" unless you also state how many and why they were not fully expanded.

Do not arbitrarily cap viable results. If there are many, group by country/seller/price band and preserve the long tail in compact form. If the result set is huge, return the best verified options plus a clearly labeled "additional viable listings" section rather than hiding them.

For travel research, return constraints and verified options that can be turned into an itinerary or booking workflow.

For geographic research ("best coffee shops in X", "where are the cleanest beaches in Y", "compare these neighbourhoods"), include coordinates for every place you return — both \`lat\` and \`lng\` as numbers, or a structured \`position\` field with [lng, lat] in GeoJSON order. Many authoritative sources surface coordinates inline (Google Maps result pages, OpenStreetMap node detail, Wikidata, official venue pages, Foursquare). When the orchestrator asks for places "on a map", the coordinate is the part it cannot easily recover from the rest of your findings — prioritise getting it right over decorating the entry. If you genuinely cannot find a coordinate, return the name and best address; the orchestrator can geocode as a fallback.

For scientific/medical research, return evidence quality and limitations, not just conclusions.

For executor handoff, include:
- exact URL(s);
- data the parent may need from the user;
- confirmation boundary;
- fields/forms likely required;
- risks or constraints the executor must not bypass.
</output_contract>
`.trim()
