# Source catalog — which source for which person, and how to reach it

Pick sources by **who the person is** and **what the user already knows**, not by habit. Each entry lists what it yields, the Orchestrator path to it, and its reliability. Stop escalating the moment you have a Confirmed/Probable channel that fits the user's purpose.

## How to read the "access" column
- **own data** — the user's connected accounts, gated behind `ActivateIntegrationTools` (Contacts, Gmail, WhatsApp, Calendar). Highest precision, zero external footprint. Always Rung 1.
- **web** — built-in `web_search` + `WebFetch`, or delegate fan-out to `researcher`. Public pages only.
- **browser** — `browser_agent` in a logged-in session. Use for anything behind auth, behind interaction, or needing visual judgement (photo comparison). Follow the browser_agent handoff rules: hand it the exact site + the single bounded goal, not open-ended discovery.

## Rung 1 — the user's own orbit
| Source | Yields | Access | Notes |
|---|---|---|---|
| Contacts (+ other contacts) | number, email, saved notes | own data | Search by name and by company. "Other contacts" holds people the user emailed but never saved. |
| Gmail | numbers/titles in **email signatures**, direct threads | own data | Signatures are a goldmine for direct mobile + role. Read the actual thread, don't just match the sender. |
| WhatsApp | number (if a chat exists), display name | own data | Confirms the user already has a channel; also a photo anchor for verification. |
| Calendar | attendee emails, org affiliation | own data | Past meetings reveal work email and the company they were at *then*. |

## Rung 2 — light public web (pin identity + public professional contact)
| Source | Yields | Access | Reliability |
|---|---|---|---|
| Company / staff / team page | role confirmation, sometimes work email pattern | web | High for identity; email often pattern-only |
| Public LinkedIn | role, employer, location, photo, career timeline | web (public) / browser (logged-in for detail) | High for identity & disambiguation; rarely shows number |
| GitHub / GitLab | username, sometimes email in commits, personal site link | web | High when the person is technical (commit emails are real) |
| Personal site / blog / portfolio | direct contact, the canonical "about" | web | High when it exists |
| Conference / press / bylines / talks | affiliation, bio, occasionally contact | web | Good corroboration anchor |
| Public directories, professional registries | role, org, sometimes phone | web | Varies; country-specific |
| Email-pattern inference | likely work email (`first.last@company`) | web (verify the pattern from a known address) | Probable at best until verified; never present an inferred email as Confirmed |

## Rung 3 — B2B enrichment (professional "LinkedIn category") — propose first
These exist to sell exactly this data; they often hold **direct work email and mobile**. Most need the user's account and may spend credits — say so before using.
| Source | Strength | Access |
|---|---|---|
| Apollo.io | direct dials + work email, strong B2B coverage | browser (logged-in) or connected tool if available |
| RocketReach | personal + work email, phone | browser (logged-in) |
| ZoomInfo | enterprise direct dials | browser (logged-in) |
| Hunter.io / Lusha / Clearbit / Common Room | email finder + verification, enrichment | browser (logged-in) |

Workflow: confirm the LinkedIn/company identity first (Rung 2), then look the *resolved* person up here so you enrich the right record, not a namesake.

## Rung 4 — social graph + photo verification — propose first
| Platform | Yields | Access | Use for |
|---|---|---|---|
| LinkedIn (logged-in) | full role/timeline, mutuals, sometimes contact info | browser | professionals; strongest disambiguation |
| Facebook | photos, city, friends, life events, sometimes phone/email in About | browser | personal/old-friend searches |
| Instagram | photos, bio links, tagged location, linked accounts | browser | photo identity anchor; cross-link to other handles |
| X / Twitter | bio, linked site, posting history | browser | public-facing people |
| TikTok / others | photos, linked accounts | browser | younger / creator profiles |

Always pair this rung with `identity-verification.md` — a found profile is only the target's once verified. `browser_agent` views the images and reports what it sees; it does not assert biometric identity.

## Rung 5 — aggregators & public records — propose first, low trust
- People-search aggregators (coverage, quality, and **legality vary by country**; many are unreliable or stale).
- Public records / official registries where lawful and locally appropriate.
- Treat everything here as **Possible** until corroborated by a higher rung. Respect local norms, including Romanian. Never fabricate or imply certainty.

## Romania / local note
Local-language spelling and diacritics matter for search recall (try with and without diacritics, and common nickname forms). Romanian public coverage on global aggregators is thin — Rung 1 (own data), the company/staff page, and logged-in LinkedIn usually outperform aggregators for RO professionals.
