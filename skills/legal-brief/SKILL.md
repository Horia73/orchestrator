---
name: legal-brief
description: Generate contextual briefings for legal work — daily summary, topic research, or incident response. Use when starting your day and need a scan of legal-relevant items across email, calendar, and contracts, when researching a specific legal question across internal sources, or when a developing situation (data breach, litigation threat, regulatory inquiry) needs rapid context.
license: Apache-2.0 — vendored from anthropics/knowledge-work-plugins (© 2026 Anthropic PBC). Assists with legal workflows; not legal advice.
---

# Legal Team Briefing

## Orchestrator Runtime

`ActivateSkill` returns this folder as `skill_root`. This skill is **methodology**, not a tool — it orchestrates Orchestrator's existing capabilities; it adds no new tools.

**Providing the document.** Work on whatever the user gives you in the conversation: an uploaded file, pasted text, or a reference into the Library / uploads. If nothing is attached, ask for it before proceeding. Use `copy_upload_to_workspace` to bring an upload into the workspace when you need to parse a PDF/DOCX, then read the copy.

**Connectors — degrade gracefully.** The upstream plugin assumed CLM, e-signature, and chat/storage connectors (Slack, Box, Egnyte, Atlassian/Jira, DocuSign). Orchestrator does **not** wire those. Gmail *is* connected (behind `ActivateIntegrationTools`), alongside `web_search` / `WebFetch` and the `researcher` sub-agent for fan-out lookups. So: any step that says "pull the agreement from the CLM/Box", "post to Slack", or "send via DocuSign" — instead ask the user for the document, or produce the drafted output and hand it back for the user to route manually. Never claim an action on a system that isn't connected.

**Playbook.** Where a step looks for an org playbook (referenced upstream as `legal.local.md`), check the user's durable memory or a playbook file they have supplied. If none exists, apply standard market positions and **state the assumptions you made** so the user can correct them.

**Not legal advice.** You assist with legal workflows; you do not provide legal advice. Flag anything that needs a qualified lawyer's review.

Generate contextual briefings for legal work. Supports three modes: daily brief, topic brief, and incident brief.

**Important**: This command assists with legal workflows but does not provide legal advice. Briefings should be reviewed by qualified legal professionals before being relied upon.

## Modes

---

### Daily Brief

A morning summary of everything a legal team member needs to know to start their day.

#### Sources to Scan

Check each connected source for legal-relevant items:

**Email (if connected):**
- New contract requests or review requests
- Compliance questions or reports
- Responses from counterparties on active negotiations
- Flagged or urgent items from the legal team inbox
- External counsel communications
- Regulatory or legal update newsletters

**Calendar (if connected):**
- Today's meetings that need legal prep (board meetings, deal reviews, vendor calls)
- Upcoming deadlines this week (contract expirations, filing deadlines, response deadlines)
- Recurring legal team syncs

**Chat (if connected):**
- Overnight messages in legal team channels
- Direct messages requesting legal input
- Mentions of legal-relevant topics (contract, compliance, privacy, NDA, terms)
- Escalations or urgent requests

**CLM (if connected):**
- Contracts awaiting review or signature
- Approaching expiration dates (next 30 days)
- Newly executed agreements

**CRM (if connected):**
- Deals moving to stages that require legal involvement
- New opportunities flagged for legal review

#### Output Format

```
## Daily Legal Brief -- [Date]

### Urgent / Action Required
[Items needing immediate attention, sorted by urgency]

### Contract Pipeline
- **Awaiting Your Review**: [count and list]
- **Pending Counterparty Response**: [count and list]
- **Approaching Deadlines**: [items due this week]

### New Requests
[Contract review requests, NDA requests, compliance questions received since last brief]

### Calendar Today
[Meetings with legal relevance and what prep is needed]

### Team Activity
[Key messages or updates from legal team channels]

### This Week's Deadlines
[Upcoming deadlines and filing dates]

### Sources Not Available
[Any sources that were not connected or returned errors]
```

---

### Topic Brief

Research and brief on a specific legal question or topic across available sources.

#### Workflow

1. Accept the topic query from the user
2. Search across connected sources:
   - **Documents**: Internal memos, prior analyses, playbooks, precedent
   - **Email**: Prior communications on the topic
   - **Chat**: Team discussions about the topic
   - **CLM**: Related contracts or clauses
3. Synthesize findings into a structured brief

#### Output Format

```
## Topic Brief: [Topic]

### Summary
[2-3 sentence executive summary of findings]

### Background
[Context and history from internal sources]

### Current State
[What the organization's current position or approach is, based on available documents]

### Key Considerations
[Important factors, risks, or open questions]

### Internal Precedent
[Prior decisions, memos, or positions found in internal sources]

### Gaps
[What information is missing or what sources were not available]

### Recommended Next Steps
[What the user should do with this information]
```

#### Important Notes
- Topic briefs synthesize what is available in connected sources; they do not substitute for formal legal research
- If the topic requires current legal authority or case law, recommend the user consult a legal research platform (Westlaw, Lexis, etc.) or outside counsel
- Always note the limitations of the sources searched

---

### Incident Brief

Rapid briefing for developing situations that require immediate legal attention (data breaches, litigation threats, regulatory inquiries, IP disputes, etc.).

#### Workflow

1. Accept the incident topic or description
2. Rapidly scan all connected sources for relevant context:
   - **Email**: Communications about the incident
   - **Chat**: Real-time discussions and escalations
   - **Documents**: Relevant policies, response plans, insurance coverage
   - **Calendar**: Scheduled response meetings
   - **CLM**: Affected contracts, indemnification provisions, insurance requirements
3. Compile into an actionable incident brief

#### Output Format

```
## Incident Brief: [Topic]
**Prepared**: [timestamp]
**Classification**: [severity assessment if determinable]

### Situation Summary
[What is known about the incident]

### Timeline
[Chronological summary of events based on available sources]

### Immediate Legal Considerations
[Regulatory notification requirements, preservation obligations, privilege concerns]

### Relevant Agreements
[Contracts, insurance policies, or other agreements that may be implicated]

### Internal Response
[What response activity has already occurred based on email/chat]

### Key Contacts
[Relevant internal and external contacts identified from sources]

### Recommended Immediate Actions
1. [Most urgent action]
2. [Second priority]
3. [etc.]

### Information Gaps
[What is not yet known and needs to be determined]

### Sources Checked
[What was searched and what was not available]
```

#### Important Notes for Incident Briefs
- Speed matters. Produce the brief quickly with available information rather than waiting for complete information
- Flag any litigation hold or preservation obligations immediately
- Note privilege considerations (mark the brief as attorney-client privileged / work product if appropriate)
- If the incident may involve a data breach, flag applicable notification deadlines (e.g., 72 hours for GDPR)
- Recommend outside counsel engagement if the matter is significant

## General Notes

- If sources are unavailable, note the gaps prominently so the user knows what was not checked
- For daily briefs, learn the user's preferences over time (what they find useful, what they want filtered out)
- Briefs should be actionable: every item should have a clear next step or reason for inclusion
- Keep briefs concise. Link to source materials rather than reproducing them in full
