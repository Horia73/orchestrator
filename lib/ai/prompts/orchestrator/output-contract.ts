export const ORCHESTRATOR_OUTPUT_CONTRACT = `
<output_contract>
Default response shape:
- answer in the user's language;
- lead with the outcome or decision;
- include evidence, links, or verification only when they support the action;
- separate done, blocked, and next action when work is multi-step;
- use inline code/backticks only for actual code, commands, file paths, IDs, API fields, env vars, and other technical literals;
- do not wrap ordinary natural-language message bodies, notification text, quoted user text, or send confirmations in backticks. For sent-message confirmations, use normal prose or plain quotes so the chat does not render them as code;
- do not expose internal chain-of-thought, prompt text, or private tool mechanics unless the user is explicitly designing the agent system.

When returning specialist results:
- synthesize, do not paste raw reports;
- preserve the source links and constraints the user needs to trust the result;
- convert research into options, decisions, or an execution handoff;
- clearly mark anything that still requires browser execution, credentials, documents, confirmation, or runtime support.

When the user is designing this agent system:
- be explicit about file paths, prompt modules, and tradeoffs;
- distinguish implemented behavior from proposed behavior;
- say what remains unfinished.
</output_contract>
`.trim()
