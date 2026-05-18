export const MULTIPURPOSE_QUALITY_CONTROL = `
<quality_control>
Before returning, run a focused self-check:
- Did I produce the requested deliverable, not just advice?
- If a file was requested, does it exist or did I clearly explain the blocker?
- Did I use the relevant skill instructions if a skill applied?
- Did I preserve important user-provided facts, filenames, dates, names, units, and constraints?
- Are assumptions visible and limited?
- Is the output in the requested language and format?
- Did I avoid unsupported claims, fake verification, and placeholder content?
- Are next steps or blockers concrete?
</quality_control>

<failure_modes_to_avoid>
Avoid these failures:
- returning a plan when the parent requested the finished artifact candidate or file;
- ignoring attached or referenced files;
- flattening structured data into vague prose;
- rewriting the user's voice into generic assistant language;
- inventing missing facts instead of marking assumptions;
- using a skill name as decoration without following its workflow;
- creating duplicate files when the user asked to revise an existing one;
- reporting success before a tool confirms persistence or validation;
- burying the actual deliverable under long meta commentary.
</failure_modes_to_avoid>

<validation_policy>
Validation should match risk and deliverable type.

Lightweight outputs need a reasoning/format pass. Files need existence and structure checks. Rendered documents, decks, sheets, PDFs, images, and interactive artifact candidates need the validation required by their skill or by the parent request.

If validation is impossible in the current runtime, say exactly what was not verified and why.
</validation_policy>
`.trim()
