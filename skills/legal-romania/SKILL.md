---
name: legal-romania
description: Romanian-law knowledge base and strategic doctrine for the legal-* skills. Grounds contract review, NDA triage, compliance, risk, drafting and briefings in actual Romanian law (Codul Civil, Codul Muncii, Codul Fiscal, GDPR + Legea 190/2018, consumer, e-signature, the regulator map) instead of US/common-law defaults. Activate whenever the jurisdiction is Romania / România, a party is a Romanian entity (SRL, PFA, microîntreprindere), the document is in Romanian, or the user wants aggressive-but-lawful ("grey-zone") options under Romanian law. Also triggers on "legislatia romana", "drept romanesc", "optimizare fiscala", "clauza de neconcurenta", "GDPR Romania", "ANAF", "micro-SRL", and on business-vertical matters: energy storage / "BESS" / "baterii" / "stocare energie" / "ANRE" / "racordare" / "aFRR", raising capital / "investitori" / "ofertă publică" / "ASF" / "SPV" / "pact acționari" / "crowdfunding", and web-agency / AI-platform work / "site clienți" / "AI Act" / "accesibilitate" / DPA / "drept de autor cod".
license: Vendored-support reference for the Apache-2.0 legal skills (anthropics/knowledge-work-plugins). Reference material, NOT legal advice.
---

# Legal — Romania (jurisdiction knowledge base + strategic doctrine)

## Orchestrator Runtime

`ActivateSkill` returns this folder as `skill_root`. This skill is **methodology + reference**, not a tool. It is the Romanian-law layer for the nine `legal-*` skills: when the jurisdiction is Romania, activate the relevant `legal-*` workflow **and** this skill together, then load the reference file(s) you need with `ReadSkillFile`.

**Reference files** (load lazily — only the ones the task needs):
- `references/contracte-civil.md` — Codul Civil: formation, buna-credință, vicii de consimțământ, clauza penală (art. 1538–1541), pact comisoriu, clauze abuzive B2B (art. 1203) vs B2C, limitarea răspunderii (art. 1355), garanții, Roma I, arbitraj, prescripție. **For `legal-review-contract`.**
- `references/munca-nda.md` — Codul Muncii: clauza de neconcurență (art. 21–24), confidențialitate (art. 26), formare (art. 194–198), fidelitate; NDA as civil contract (art. 1184), trade secrets (OUG 25/2019 + Legea 11/1991). **For `legal-triage-nda`, `legal-review-contract`.**
- `references/protectia-datelor.md` — GDPR + Legea 190/2018: CNP/DPO trigger (art. 4), employee monitoring (art. 5, 30-day cap), DSR timelines, breach 72h (art. 33/34), fine tiers, cookies. **For `legal-compliance-check`, `legal-response`.**
- `references/consumator.md` — OG 21/1992, OUG 140/2021 (garanție 2 ani), OUG 34/2014 (retragere 14 zile), Legea 193/2000 (clauze abuzive), ANPC, SAL. **For `legal-review-contract`, `legal-compliance-check`.**
- `references/fiscal-optimizare.md` — Codul Fiscal: micro-SRL 2025/2026, dividende 10%→16%, profit 16%, PFA, CAS/CASS, salariu vs dividende, e-Factura/SAF-T. **For `legal-vendor-check`, `legal-compliance-check`, and all grey-zone tax work.**
- `references/semnatura-electronica.md` — eIDAS + Legea 214/2024 (Legea 455/2001 abrogată): tiers, efecte pe tip (art. 4), acte care cer formă autentică. **For `legal-signature-request`.**
- `references/regulatori.md` — the 9-regulator map (ANPC, ANSPDCP, Consiliul Concurenței, ASF, ANCOM, BNR, ANAF, ITM, ANRE) with triggers + fines. **For `legal-compliance-check`.**
- `references/procedura-executare.md` — ordonanța de plată (art. 1014+), poprire, sechestru, conservarea probelor (litigation-hold echivalent), prescripție, mediere/arbitraj. **For `legal-response`, `legal-risk-assessment`.**

Vertical, business-specific references (load when the matter is one of these):
- `references/energie-bess.md` — energy-storage (BESS): ANRE licensing (>1 MW), permitting sequence (ATR/Transelectrica, autorizație de construire, acord de mediu, licență ANRE), revenue markets (aFRR/FCR/mFRR/arbitraj OPCOM), EU 2019/944, grants (Fondul pentru Modernizare, PNRR 4.3, GBER Ordin 1355/2024), EPC/O&M/teren contracts.
- `references/investitori-finantare.md` — raising capital: **the ASF public-offering / AIF (Legea 74/2015 + 243/2019) / crowdfunding (Reg. 2020/1503 + Legea 244) exposure** of pooled-investor / "buy-a-share-and-resell" models (substance over form — a disclaimer doesn't cure it), SPV structuring (SA vs SRL), shareholder agreements (drag/tag/preemption), term sheets, majorare de capital, due diligence. **Load whenever the user raises money from investors.**
- `references/web-ai-platforma.md` — web agency / AI SaaS: IP of code & AI-generated content (Legea 8/1996 — commissioned work stays with the dev absent express cesiune; pure-AI output may be unprotected), GDPR controller-vs-processor + DPA (art. 28) + sub-processors/SCC, EU AI Act art. 50 (chatbot transparency), EAA accessibility (Legea 232/2022, WCAG 2.1 AA), B2B client contracts, ToS/privacy entity gaps.
- `references/doctrina-grey-zone.md` — **the strategic doctrine**: the legal/illegal line, the risk spectrum (conservator → agresiv-apărabil → peste linie), the anti-abuz guardrails, a catalogue of lawful-but-edgy tactics, how to present aggressive options, and the hard stops. **Load this for ANY request that asks for optimization, workarounds, or "how far can we push it".**

## Two operating rules that govern everything

### 1. Reason in Romanian civil law, not common law — and cite the article

Romania is a **civil-law** system. The upstream (US/common-law) `legal-*` skills' instincts are often wrong here:
- There is no "consideration", no common-law "reasonableness" test for penalties, no discovery, no punitive damages.
- A signed contract is `putere de lege între părți` (Cod Civil art. 1270); good faith (art. 14, 1170) is **imperative and non-waivable**.
- "GREEN/YELLOW/RED", "playbook", severity×likelihood — keep the *structure* of the upstream skill, but populate it with **Romanian** positions.
- **Always cite the specific article** (e.g. "reductibilă de instanță — Cod Civil art. 1541", "indemnizație ≥50% — Codul Muncii art. 21(3)"). A finding without a citation is not production-grade.

### 2. Verify currency before you rely on a number — the law changes yearly

Romanian fiscal law is rewritten almost every year (OUG 156/2024, Legea 141/2025, OUG 89/2025 all changed rates for 2025–2026). **Every numeric threshold in the reference files carries an "as of" date and MUST be re-verified with `web_search` before you present it as current**, especially: micro plafon and rate, dividend tax %, salariul minim, CAS/CASS plafoane, IT exemption status, fine amounts. Prefer official sources (`legislatie.just.ro`, `anaf.ro`, `static.anaf.ro`, `dataprotection.ro`, `consiliulconcurentei.ro`) and a recent professional summary (PwC, KPMG, EY, avocatnet, universulfiscal). State the "as of" date in your answer. Do **not** hardcode a stale figure — the references give you the *framework* and last-known values; the live number is a runtime lookup.

## Connectors — degrade gracefully

Orchestrator has **no** CLM/DocuSign/Box/Slack/Atlassian connectors; Gmail is available, plus `web_search`/`WebFetch` and the `researcher` sub-agent. Work from documents the user provides. For anything that would go to a public authority (ANAF, ANSPDCP, instanță) or a notary, **produce the draft/analysis and hand it back for the user to file** — never claim to have filed or sent it.

## Not legal advice — and where the line is

You assist with Romanian legal workflows; you do **not** provide legal advice and you are not a substitute for an `avocat`/`consultant fiscal`. Flag anything that needs a professional's sign-off. For the grey-zone / aggressive-positions work the user may ask for, `references/doctrina-grey-zone.md` is binding: **surface lawful options across the full risk spectrum and label them honestly, but stop at the line of illegality** (evaziune fiscală, fraudarea legii, fals, spălare de bani) — those aren't "optimization", they're criminal exposure for the user, and refusing them is the useful answer, not censorship.
