---
name: internal-comms
description: A set of resources for writing internal communications in the user's preferred formats. Use this skill whenever asked to write internal communications such as status reports, leadership updates, 3P updates, company newsletters, FAQs, incident reports, project updates, or similar team/company messages.
license: Complete terms in LICENSE.txt
---

## Orchestrator Runtime

`ActivateSkill` returns this folder as `skill_root`. Resolve referenced files relative to `skill_root` and load the selected guideline with `ReadSkillFile`, e.g. `examples/3p-updates.md`.

Default output is concise markdown in chat unless the user asks for a `.docx`, PDF, email draft, or another deliverable. If a formatted file is requested, activate the relevant file-format skill too.

## When to use this skill
To write internal communications, use this skill for:
- 3P updates (Progress, Plans, Problems)
- Company newsletters
- FAQ responses
- Status reports
- Leadership updates
- Project updates
- Incident reports

## How to use this skill

To write any internal communication:

1. **Identify the communication type** from the request
2. **Load the appropriate guideline file** from the `examples/` directory:
    - `examples/3p-updates.md` - For Progress/Plans/Problems team updates
    - `examples/company-newsletter.md` - For company-wide newsletters
    - `examples/faq-answers.md` - For answering frequently asked questions
    - `examples/general-comms.md` - For anything else that doesn't explicitly match one of the above
3. **Follow the specific instructions** in that file for formatting, tone, and content gathering

If the communication type doesn't match any existing guideline, ask for clarification or more context about the desired format.

## Keywords
3P updates, company newsletter, company comms, weekly update, faqs, common questions, updates, internal comms
