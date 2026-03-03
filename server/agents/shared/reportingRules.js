export const WEB_RESULT_PRESENTATION_PROMPT = `
<web_result_presentation>
When your answer contains findings from the web or from external URLs:
- Put the exact URL inline beside the specific item or finding you mention. Do not leave important links only in a final sources block.
- For products, flights, hotels, stores, listings, papers, articles, documentation pages, or events, link the exact page for that exact item whenever possible.
- If you use a table or ranked list, include the direct URL in that same row or item.
- Preserve the user's requested order. If no explicit order was requested, preserve the discovery or ranking order from the research or delegated agent output.
- Keep each meaningful finding as its own bullet, row, or item. Do not collapse multiple findings into a vague summary.
- If multiple agents or subagents contributed findings, do not summarize away one agent's work inside another agent's prose. Return each finding and link distinctly.
- A final "Sources" section may be included as a supplement, but it never replaces inline links.
</web_result_presentation>
`.trim();

export const VISUAL_WEB_RESULT_PRESENTATION_PROMPT = `
<visual_web_result_presentation>
When the answer would benefit from a real image from the cited web result, especially for recipes, dishes, products, hotels, destinations, venues, or listings:
- Prefer the exact image from the exact cited page, not a generated substitute.
- Use \`read_url_content\` on the chosen page and use \`featured_image_url\` or another exact-page image candidate when available.
- Place the image inline near the relevant item using markdown image syntax: \`![short alt text](exact_image_url)\`.
- Keep images in the same order as the findings they belong to.
- Prefer one strong image per concrete item unless the user explicitly asks for more.
- For recipes, products, hotels, destinations, venues, listings, and similar concrete options, include one inline image per returned item whenever the cited page exposes one. If an item truly has no retrievable page image, say that briefly instead of silently omitting it.
</visual_web_result_presentation>
`.trim();

export const ARTIFACT_RESULT_PRESENTATION_PROMPT = `
<artifact_result_presentation>
When you created or updated a concrete artifact, app, document, bundle, or local output file:
- Tell the user exactly what was produced and name it explicitly.
- Tell the user exactly where to open it or view it. Include the exact artifact title and/or absolute file path when relevant.
- Give one direct next-action sentence before asking for feedback.
- Do not end with only a vague question like "What do you think?" without first giving that action.
- If a local bundle or file was created for viewing, mention the exact file path in the response.
</artifact_result_presentation>
`.trim();

export const WEB_RESEARCH_EXECUTION_PROMPT = `
<web_research_execution>
When using web research tools:
- Prefer parallel tool calls over sequential ones whenever the searches or URL reads are independent.
- Emit multiple \`search_web\` or \`read_url_content\` calls in the same tool round when you can compare or verify several options at once.
- Do not spend extra \`search_web\` calls just to fetch the exact link or image for an item you already found.
- \`search_web\` already returns exact citation URLs and may include exact-page image metadata for cited results; reuse that first.
- Use \`read_url_content\` on the chosen exact page when you need the full page text, stronger verification, or a better exact-page image candidate.
- When delegating open-web research to another agent or subagent, pass the goal, constraints, locale, and requested ordering. Do not prescribe specific websites or domains unless the user explicitly asked for them or only official/primary sources are acceptable.
</web_research_execution>
`.trim();

export const DELEGATION_RESULT_PROCESSING_PROMPT = `
<delegation_result_processing>
When you delegate to child agents or subagents:
- You must read and process the child outputs before responding upward.
- Do not omit concrete findings returned by children. Preserve them in your own answer in the requested order.
- Produce a clean parent-level answer, not a raw dump of child execution context.
- Do not forward raw nested tool traces, nested \`parts\`, or nested \`steps\` from grandchildren upward unless the user explicitly asked for raw traces.
- Subagent -> parent subagent: process child results and keep all findings.
- Agent -> orchestrator or parent agent: process child results and keep all findings.
- Orchestrator -> user: process delegated agent results and keep all findings.
</delegation_result_processing>
`.trim();

export const DELEGATED_WEB_RESULT_POLICY = [
    '[Result presentation policy]',
    '- For any web-found product, flight, hotel, store, paper, article, or concrete option, put the exact URL inline next to that specific mention.',
    '- Do not place important links only at the end.',
    '- Preserve each meaningful finding as a separate item in the user-requested order; if no order was requested, preserve discovery or ranking order.',
    '- Do not summarize away other agents or subagents. Return each finding and link distinctly.',
    '- For recipes, products, hotels, destinations, or other visual findings, use the exact cited page image when available and place it inline near that item with markdown image syntax.',
    '- Prefer parallel web tool calls over sequential ones whenever the searches or URL reads are independent.',
    '- Reuse exact citation URLs and any exact-page image metadata already returned by search_web before doing extra searches.',
    '- Do not do another search_web call only to fetch an exact link or image for an item you already found.',
    '- For concrete visual items like products or recipes, include one inline image per item when the cited page exposes one; if not available, say so briefly.',
    '- If you are delegating open-web research further, pass the goal and constraints, not a list of websites, unless the user explicitly requested those sites or official-only sourcing is required.',
    '- Process child agent or subagent results into your own answer, but do not forward raw nested execution context from grandchildren upward.',
].join('\n');

export function mergeContextWithReportingPolicy(context) {
    const normalizedContext = String(context ?? '').trim();
    if (normalizedContext.includes('[Result presentation policy]')) {
        return normalizedContext;
    }

    return [normalizedContext, DELEGATED_WEB_RESULT_POLICY].filter(Boolean).join('\n\n');
}
