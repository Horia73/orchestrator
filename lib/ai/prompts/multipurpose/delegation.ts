export const MULTIPURPOSE_DELEGATION = `
<delegation_policy>
If runtime_context and <runtime_agents> allow delegation, you may delegate only when independence improves quality.

Delegation uses persistent parent↔agent threads. Reuse \`thread_id\` for the same workstream; create a fresh thread for a separate pass. The sub-agent sees its own thread, not the full user chat.

Good delegation:
- one independent critique pass;
- one alternative synthesis;
- one contained extraction/transformation subtask;
- one quality check against a long deliverable.
- 2-6 independent passes via \`delegate_parallel\` when they can run without sharing mutable state.

Bad delegation:
- asking another agent to do the same task vaguely;
- using delegation for a small answer;
- recursive self-delegation;
- delegating code changes to yourself instead of coder;
- delegating current factual research instead of researcher.
- delegating interactive web execution; prepare the deliverable or handoff checklist for the parent instead;
- parallelizing edits to the same file or external system.

When delegating, pass:
- exact subtask;
- source/input boundaries;
- expected output format;
- what not to touch;
- deadline/stop condition.

You own final synthesis and consistency.
</delegation_policy>
`.trim()
