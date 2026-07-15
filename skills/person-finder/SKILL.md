---
name: person-finder
description: Find and verify a person's reachable contact details from a name plus known clues. Use to locate someone, confirm identity, reconnect, or find a phone number, email, professional/social profile, or other reliable contact channel, including Romanian requests such as „găsește numărul/contactul” and deeper follow-up after a light search fails.
license: Public-source person lookup for legitimate, user-directed outreach. Defers to <safety_core>.
---

## Orchestrator Runtime

`ActivateSkill` returns this folder as `skill_root`. Load the reference files with `ReadSkillFile` when you reach the rung that needs them:
- `references/source-catalog.md` — which source to use for which kind of person, and the Orchestrator tool that reaches it.
- `references/identity-verification.md` — the photo / namesake / confidence protocol used to decide *which* person a datum belongs to.

This skill is **methodology**, not a tool. It orchestrates Orchestrator's real capabilities: the user's own connected data (Contacts, Gmail, WhatsApp, Calendar — gated behind `ActivateIntegrationTools`), built-in `web_search` / `WebFetch`, the `researcher` sub-agent for fan-out discovery, and `browser_agent` for any source that needs a logged-in session or visual identity comparison (Apollo, LinkedIn, Facebook, Instagram, X, TikTok). It does not add new tools.

## What this skill is for

The user wants to **reach a specific person** and needs you to find a reliable channel (phone, email, social profile, DM route) or to confirm an identity. The deliverable is contact data the *user* will act on — not a message you send. You find and present; you never contact the target yourself (that crosses the `<safety_core>` consent boundary and is a separate, explicitly-confirmed action).

## Two rules that govern everything

These exist because the common failure mode is confidently handing over the **wrong person's** number, or **giving up** after one shallow pass.

1. **Identity before contact.** Resolve *which* person this is before you attach any contact detail to them. Treat candidates as a set, not a single assumption — two people share a name until you've disambiguated. A contact datum is only "theirs" once it's tied to the resolved identity by real evidence. Never present a namesake's number/email as the target's.

2. **Evidence + confidence, never a bare assertion.** Every datum you report carries: the source, *how* it was matched to the target, and a confidence label — **Confirmed / Probable / Possible / Unverified**. Never round "Possible" up to a confident answer. If all you have is weak, say so plainly and offer the next rung. "I couldn't find a verified number" is an honest, acceptable result; substituting a different person's number as a consolation is not.

## The escalation ladder

Work from least-invasive and most-precise outward. **At every rung boundary: report what you have with its confidence, then propose the next rung and let the user choose the depth.** Do not silently skip to giving up, and do not silently dive to the deepest rung without proposing it.

### Rung 0 — Frame & disambiguate (always)
- Confirm what "found" means here: a phone specifically? any reliable channel? just confirm it's the right person?
- Collect identity **anchors** — anything the user knows: full name (with native-language spelling / diacritics), employer + role, city/country, school, rough age, a photo, known handles or emails, and the user's **relationship to them and why they want to reach them**. Purpose decides which channel is appropriate (professional → work email/LinkedIn; old friend → social).
- Run the red-flag check below. If clear, proceed; you don't need an interrogation — a couple of anchors is enough to start.

### Rung 1 — The user's own orbit (free, precise, least invasive)
Search the user's **own** connected data first — people you want to reach are often already reachable through your own history, and this is zero-risk and high-precision:
- Contacts (incl. "other contacts"), Gmail (past threads, email signatures hold direct numbers and titles), WhatsApp chats, Calendar attendees, past uploads, durable memory.
- This rung alone frequently solves it. The shallow web search that skips it is the classic miss.

### Rung 2 — Light public web pass
`web_search` / `researcher` across: name + employer/role/city, the company site or staff page, public LinkedIn, GitHub, personal site, conference/press/byline mentions, public directories. Two jobs:
- **Pin the identity** (decide *which* person — see `identity-verification.md`).
- Harvest any **public professional contact**.
End this rung by either delivering verified info, or naming what's still missing and proposing Rung 3/4.

### Rung 3 — Targeted professional / B2B enrichment *(propose first)*
For people in the professional / "LinkedIn category", propose the B2B data sources that hold direct work email and mobile: Apollo.io, RocketReach, ZoomInfo, Hunter, Lusha, Clearbit/Common Room. Reached via `browser_agent` in a logged-in session (or a connected data tool if one exists). Note up front that some consume the user's account credits. See `source-catalog.md`.

### Rung 4 — Social graph + photo/identity verification *(propose first)*
Propose either: the user hands you known handles, **or** you search Facebook / Instagram / X / TikTok / LinkedIn for profiles matching the anchors. Then run the **identity-verification protocol** (`identity-verification.md`): compare profile photos against the known photo and across profiles (same face? consistent city/employer/timeline/mutuals?), cross-link usernames, and only then treat a profile's contact route (listed number, DM access) as the target's. `browser_agent` does the visual viewing and reports what it sees. A face match is a *confidence signal*, never asserted as certainty.

### Rung 5 — Aggregators & public records *(propose first; sensitivity-gated)*
People-search aggregators and public records (availability and legality vary by country; respect local norms — including Romanian — and never fabricate). High false-positive rate and often stale. Propose explicitly, label reliability as low, and gate behind a legitimate purpose.

## Output contract — the person card

Present a compact card, not a wall of links:
- **Resolved identity** — who this is, and the explicit disambiguation if namesakes exist ("This is X at Capalo, *not* the X from Oradea").
- **Channels found** — each as `value — Confirmed/Probable/Possible — source + one line on why it matches the target`.
- **Best way to reach them** — the recommendation aligned to the user's purpose.
- **Next options** — if the user wants more, the next rung's proposal. If nothing reliable was found, say that plainly and propose deeper rungs.

## Guardrails

Defers to `<safety_core>`; this section is the person-search-specific reading of it.
- **Public or user-authorized sources only.** Don't defeat logins, privacy settings, or anti-bot controls you aren't entitled to. Use the user's own accounts/sessions where relevant; don't impersonate.
- **Find and present — never contact.** Messaging, DMing, calling, or posting to the target is a separate action behind the `<safety_core>` consent boundary.
- **Sensitivity tiers.** Professional contact for legitimate outreach is normal. A private individual's home address, real-time location, financial data, data about minors, or anything that primarily enables harm is **gated**: confirm a legitimate purpose, and **decline** on stalking, harassment, monitoring-an-unwilling-person, or targeting-to-harm patterns (e.g. "find my ex's new address," locating someone who has asked not to be contacted). When in doubt, ask the user what the outreach is for.
- **Never fabricate.** No invented numbers, emails, or handles. Unknown is a valid result.
- **Don't dump the target's sensitive PII into durable memory** (`<safety_core>` credentials/PII rule). Keep findings in the working answer; persist only what the user asks to save and only non-sensitive contact basics.

## Keywords
find person, find number, find phone, find email, locate someone, contact details, reconnect, look up person, who is, find on LinkedIn, find on Facebook, find on Instagram, same person, identity verification, people search, lead enrichment, Apollo, gaseste numarul, gaseste contactul, cauta persoana, e aceeasi persoana
