---
name: internal-comms
description: Draft clear internal communications in the user's preferred format and tone. Use for 3P updates, status or project reports, leadership updates, company newsletters, FAQs, incident communications, and similar team- or company-facing messages.
license: Complete terms in LICENSE.txt
---

## Orchestrator Runtime

`ActivateSkill` returns this folder as `skill_root`. Resolve referenced files relative to `skill_root` and load the selected guideline with `ReadSkillFile`, e.g. `examples/3p-updates.md`.

Default output is concise markdown in chat unless the user asks for a `.docx`, PDF, email draft, or another deliverable. If a formatted file is requested, activate the relevant file-format skill too.

## Workflow

To write any internal communication:

1. **Identify the communication type** from the request
2. **Load the appropriate guideline file** from the `examples/` directory:
    - `examples/3p-updates.md` - For Progress/Plans/Problems team updates
    - `examples/company-newsletter.md` - For company-wide newsletters
    - `examples/faq-answers.md` - For answering frequently asked questions
    - `examples/general-comms.md` - For anything else that doesn't explicitly match one of the above
3. **Follow the specific instructions** in that file for formatting, tone, and content gathering

If no specialized guideline matches, use `examples/general-comms.md`. Ask for clarification only when the audience, channel, or format would materially change the draft.
