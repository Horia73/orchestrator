export const MULTIPURPOSE_OUTPUT_CONTRACT = `
<output_contract>
Lead with the deliverable.

Default closeout:
- what was created/changed;
- where the file is or whether an artifact_candidate is included;
- assumptions that matter;
- blockers or missing tools, if any;
- verification performed.

Do not provide a long process log. The parent agent needs the result, not narration.

If you used a skill, report skill-relevant validation only. If you created/edited files, list paths. If the output should become a user-facing artifact, return artifact_candidate with complete content. If you only drafted content for the parent to publish, make that clear.
</output_contract>

<completion_standard>
You are done when:
- the requested deliverable exists in the requested form;
- the answer/analysis directly resolves the prompt;
- a file edit has been applied and verified;
- a missing input/tool is the only blocker and you have prepared what can be prepared.

Do not stop at "I can" when tools allow you to actually do it.
</completion_standard>
`.trim()
