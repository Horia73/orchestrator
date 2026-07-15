---
name: legal-workflow-core
description: Apply the shared evidence, jurisdiction, connector, authorization, privacy, and counsel-review contract for bundled legal workflows. Use before substantive work with any legal-brief, legal-compliance-check, legal-meeting-briefing, legal-response, legal-review-contract, legal-risk-assessment, legal-signature-request, legal-triage-nda, or legal-vendor-check skill.
---

# Legal workflow core

## Goal

Produce a source-grounded legal workflow deliverable that is useful for a qualified reviewer without overstating authority, access, or certainty.

## Success criteria

- Identify governing jurisdiction, document/version, parties, dates, requested decision, and the user's role or authorization.
- Separate source text, current law/policy, organizational playbook, inference, negotiation judgment, and unknowns.
- Cite exact clauses and authoritative legal sources for material findings; attach current verification dates to volatile rules or figures.
- Complete the selected legal skill's deliverable and identify the smallest review, approval, filing, or execution step still required.

## Orchestrator Runtime

Work from the user's upload, pasted text, or Library/uploads reference. If a file must be parsed, use `copy_upload_to_workspace`, activate the matching PDF/DOCX skill, and preserve the original.

Orchestrator has no CLM, DocuSign, Box, Slack, or Atlassian connector. Gmail, web research, and delegated research may be available after capability activation. If a workflow names an unavailable system, request the document or produce a ready-to-route draft; never imply an unavailable read, filing, signature, message, or status check occurred.

## Workflow

1. Confirm the matter, governing law, relevant date, source documents, requested output, and decision owner. Ask only for a missing item that would materially change the analysis.
2. If Romania is implicated by governing law, entity, language, or subject matter, activate `legal-romania` and load only the relevant references. Reason in Romanian civil law and cite exact articles rather than importing common-law defaults.
3. Retrieve current primary law, regulator guidance, or official policy when the rule may have changed. Re-verify tax rates, thresholds, fines, deadlines, regulator status, and similar volatile values before relying on them.
4. Use the organization's supplied playbook or durable context when available. If none exists, apply labeled market-standard assumptions and keep them easy to replace.
5. Run the selected domain workflow. Preserve adverse facts and uncertainty; do not make the document sound safer or more complete than the evidence supports.
6. Validate clause/article citations, calculations, dates, names, internal consistency, escalation tier, and requested output structure.

## Constraints

- Assist with legal workflows; do not present the output as legal advice or a substitute for qualified counsel.
- Request and expose only the personal, confidential, or privileged information needed for the active task.
- Do not file, sign, send, upload, accept terms, make declarations, or create external legal effect without exact user authorization and an available tool path.
- Do not invent missing clauses, approvals, precedent, regulator positions, connected-system state, or current law.
- For aggressive-but-lawful options, load `legal-romania/references/doctrina-grey-zone.md` when Romania applies, label the risk spectrum, and stop at illegality, deception, evasion, false documents, or rights violations.

## Output

Lead with the legal-workflow result, then the supporting clause/article evidence, assumptions and uncertainties, practical risk or business impact, and exact next review/action. Preserve the domain skill's required format when it is more specific.

## Stop rules

Stop when the requested deliverable is complete, citations and volatile facts are checked, and the review/execution boundary is explicit. If a required document, jurisdiction, authorization, or current source is missing, complete only the defensible portion and name the smallest missing input; do not convert uncertainty into a definitive conclusion.
