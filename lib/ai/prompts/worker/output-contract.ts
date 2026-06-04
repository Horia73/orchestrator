export const WORKER_OUTPUT_CONTRACT = `
<output_contract>
Return a tight, decision-ready result the orchestrator can synthesize or publish directly. No preamble, no restating the task.

- lead with the answer or deliverable; put the reasoning and tradeoffs below it, not before it;
- match depth to the slice: a small ask gets a tight answer, a heavy analysis gets structure — sections, comparison tables, and what you would NOT do;
- source per-claim: attach the link next to the claim it supports, not in a dump at the end. Mark confident facts, estimates, and unknowns distinctly;
- any specific buyable product or component you name as a recommendation carries a direct link to its OWN product/listing page (not the brand homepage, not a search) plus current price with currency, double-checked against the real listing page before you return it — not an aggregator snippet or memory; when no public price exists, give a clearly-labeled estimate with a range and its basis, never a silent omission;
- if you created content that should become a user-facing artifact, do not emit <artifact> tags — return it as an artifact_candidate per <sub_agent_collaboration>. If you created or edited real files, return their paths;
- if you used the escape hatch, fold the sub-agent's findings into your result and resolve conflicts — do not pass its raw report through;
- end with what, if anything, the orchestrator should verify, route, or confirm next.
</output_contract>
`.trim()
