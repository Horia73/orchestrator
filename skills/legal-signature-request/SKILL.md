---
name: legal-signature-request
description: Prepare and route a document for e-signature — run a pre-signature checklist, configure signing order, and send for execution. Use when a contract is finalized and ready to sign, when verifying entity names, exhibits, and signature blocks before sending, or when setting up an envelope with sequential or parallel signers.
license: Apache-2.0 — vendored from anthropics/knowledge-work-plugins (© 2026 Anthropic PBC). Assists with legal workflows; not legal advice.
---

# E-Signature Routing

## Orchestrator Runtime

`ActivateSkill` returns this folder as `skill_root`. This skill is **methodology**, not a tool — it orchestrates Orchestrator's existing capabilities; it adds no new tools.

**Providing the document.** Work on whatever the user gives you in the conversation: an uploaded file, pasted text, or a reference into the Library / uploads. If nothing is attached, ask for it before proceeding. Use `copy_upload_to_workspace` to bring an upload into the workspace when you need to parse a PDF/DOCX, then read the copy.

**Jurisdiction — Romania by default.** When the matter is Romanian (a Romanian party — SRL / PFA / microîntreprindere, a document in Romanian, RO governing law, or the user writes in Romanian), also `ActivateSkill("legal-romania")` and load the relevant reference(s). Reason in **Romanian civil law** and **cite the exact article** (Cod Civil / Codul Muncii / Cod Fiscal / GDPR + Legea 190/2018 / consumer / e-signature), never US/common-law defaults. Re-verify volatile figures (tax rates, plafoane, fine amounts) with `web_search` before presenting them — RO fiscal law changes yearly. For aggressive-but-lawful ("grey-zone") options the user may ask for, load `legal-romania`'s `references/doctrina-grey-zone.md`.

**Connectors — degrade gracefully.** The upstream plugin assumed CLM, e-signature, and chat/storage connectors (Slack, Box, Egnyte, Atlassian/Jira, DocuSign). Orchestrator does **not** wire those. Gmail *is* connected (behind `ActivateIntegrationTools`), alongside `web_search` / `WebFetch` and the `researcher` sub-agent for fan-out lookups. So: any step that says "pull the agreement from the CLM/Box", "post to Slack", or "send via DocuSign" — instead ask the user for the document, or produce the drafted output and hand it back for the user to route manually. Never claim an action on a system that isn't connected.

**Playbook.** Where a step looks for an org playbook (referenced upstream as `legal.local.md`), check the user's durable memory or a playbook file they have supplied. If none exists, apply standard market positions and **state the assumptions you made** so the user can correct them.

**Not legal advice.** You assist with legal workflows; you do not provide legal advice. Flag anything that needs a qualified lawyer's review.

Prepare a document for electronic signature — verify completeness, set signing order, and route for execution.

**Important**: This command assists with legal workflows but does not provide legal advice. Verify documents are in final form before sending for signature.

Prepare the document the user has provided (uploaded file, pasted text, or a Library/uploads reference) for electronic signature. If none is attached, ask for it.

## Workflow

### Step 1: Accept the Document

Accept the document in any format:
- **File upload**: PDF, DOCX
- **URL**: Link to a document in ~~cloud storage or ~~CLM
- **Reference**: "The Acme Corp MSA we finalized yesterday"

### Step 2: Pre-Signature Checklist

Before routing for signature, verify:

```markdown
## Pre-Signature Checklist

- [ ] Document is in final, agreed form (no open redlines)
- [ ] All exhibits and schedules are attached
- [ ] Correct legal entity names on signature blocks
- [ ] Dates are correct or left blank for execution date
- [ ] Signature blocks match the authorized signers
- [ ] Any required internal approvals have been obtained
- [ ] Document has been reviewed by appropriate counsel
```

### Step 3: Configure Signing

Gather signing details:
- **Signers**: Who needs to sign? (names, emails, titles)
- **Signing order**: Sequential or parallel?
- **Internal approval**: Does anyone need to approve before the counterparty signs?
- **CC recipients**: Who should receive a copy of the executed document?

### Step 4: Route for Signature

**If ~~e-signature is connected:**
- Create the signature envelope/request
- Set signing fields and order
- Add any required initials or date fields
- Send for signature

**If not connected:**
- Generate a signing instruction document
- Provide the document formatted for wet signature or manual e-sign
- List all signers with contact information

## Output

```markdown
## Signature Request: [Document Title]

### Document Details
- **Type**: [MSA / NDA / SOW / Amendment / etc.]
- **Parties**: [Party A] and [Party B]
- **Pages**: [X]

### Pre-Signature Check: [PASS / ISSUES FOUND]
[List any issues that need attention before sending]

### Signing Configuration
| Order | Signer | Email | Role |
|-------|--------|-------|------|
| 1 | [Name] | [email] | [Party A Authorized Signatory] |
| 2 | [Name] | [email] | [Party B Authorized Signatory] |

### CC Recipients
- [Name] — [email]

### Status
[Sent for signature / Ready to send / Issues to resolve first]

### Next Steps
- [What to expect after sending]
- [Expected turnaround time]
- [Follow-up if not signed within X days]
```

## Tips

1. **Check entity names carefully** — The most common signing error is incorrect legal entity names.
2. **Verify authority** — Make sure each signer is authorized to bind their organization.
3. **Keep a copy** — Executed copies should be filed in ~~cloud storage or ~~CLM immediately after execution.
