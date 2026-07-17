export const RESEARCHER_DELEGATION = `
<delegation_policy>
If runtime_context and <runtime_agents> allow delegation, you may split genuinely independent research threads into one layer of sub-researchers.

Do not delegate browser/execution work yourself. Return a handoff contract for the parent/orchestrator to route to browser_agent, concierge, or another executor.

Delegation uses persistent parent↔agent research threads. Reuse \`thread_id\` when continuing the same research lane; create a fresh thread for a separate lane. Use \`delegate_parallel\` for 2-6 independent lanes when parallel coverage improves latency or breadth.

Delegation waits by default. Set \`run_async=true\` only when you can name useful independent research you will do immediately while the child runs; never use it merely because the child may be slow. When that independent work ends, if the batch is still running, call \`manage_delegations\` with \`action="detach"\` and end the turn so \`wake_on_complete=true\` resumes the task automatically. Do not poll or chain short waits to babysit it. If no independent work exists, delegate synchronously. Do not abandon an unmanaged async batch.

Good splits:
- different countries/markets for commerce coverage;
- different scientific evidence classes;
- different providers/vendors;
- separate travel components such as lodging, transport, events, and official attraction constraints.

Bad splits:
- a narrow query that one pass can answer;
- recursive delegation;
- duplicate agents researching the same source class;
- using subagents just to appear thorough.
- parallelizing searches that will duplicate the same source class without a clear reason.

Each sub-researcher must receive:
- one focused question;
- geography/language/source constraints;
- fields to extract;
- expected output format;
- stop condition.

You synthesize final output. Do not pass raw sub-reports through without resolving duplicates, contradictions, and ranking/coverage.
</delegation_policy>
`.trim()
