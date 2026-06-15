# Identity verification — deciding *which* person a datum belongs to

The job of this protocol is to stop you from handing the user the **wrong person's** contact. A name is not an identity. Resolve the person, then attach contacts to the resolved person.

## 1. Build a candidate set, not an assumption
When you start, assume **N candidates**, not one. Every person matching the name is a candidate until evidence separates them. Tag every datum you collect with the candidate it belongs to. Never let data from two candidates merge into one card.

> Worked example: a search for "Horia Gug" surfaces a backend developer at Capalo **and** a different "Horia Aurelian Gug" from Oradea. These are two candidates. A phone number found on the Oradea person's page is **not** a Confirmed contact for the Capalo developer — it's a *different candidate's* datum, and presenting it as the target's is the exact error to avoid.

## 2. Match on anchors
Score each candidate against the anchors the user gave (Rung 0). Strong anchors carry weight; weak anchors only corroborate.

**Strong anchors** (each meaningfully ties a candidate to the target):
- Face — the same person across a known photo and a profile photo.
- Employer + role — and the *timeline* lining up (was at company Y in the right years).
- Username reuse — the same handle across GitHub / Instagram / X / LinkedIn.
- A unique link — a personal site that the company page and the social profile both point to.

**Weak anchors** (corroborate, never decide alone):
- City/region, school, rough age, language, generic bio phrasing, mutual connections.

A single weak anchor (just a shared city, just a shared name) is **not** identification.

## 3. Photo / face comparison
When a reference photo exists (user-provided, WhatsApp avatar, or one strong profile photo), use it to link profiles:
- Have `browser_agent` open the candidate profiles and **describe and compare** the faces: same person, plausibly the same, or clearly different — plus corroborating visual context (same setting, same other people, same posted timeframe).
- Treat the result as a **confidence signal, not proof**. People look alike; photos are dated and reused. Never report a face match as certainty. Phrase it: "profile photo appears to match the reference (Probable)," not "confirmed same person."
- A face match **plus** one independent strong anchor (employer, username) is what lifts a candidate to Confirmed.

## 4. Cross-linking handles
Reuse of an identifier is strong glue:
- The same username across platforms, the same linked website, an Instagram bio linking the LinkedIn, a GitHub commit email matching a personal domain.
- Chain these: company page → named LinkedIn → linked personal site → GitHub → commit email. A chain of corroborating links is far stronger than any single page.

## 5. Confidence labels (what each level requires)
- **Confirmed** — ≥2 independent strong anchors tie this datum to the resolved target (e.g. the work email is on the company staff page **and** on the LinkedIn whose photo + role + timeline match the target).
- **Probable** — one strong anchor plus consistent weak ones, no contradicting evidence.
- **Possible** — matches some anchors but rests on a single weak/low-trust source (e.g. an aggregator hit, an inferred email pattern not yet verified).
- **Unverified / different person** — surfaced *separately* and explicitly, never folded into the target's card. Tell the user it exists and why you excluded it.

Do not round up. A "Possible" reported as if Confirmed is the failure this whole protocol prevents.

## 6. Handle conflicts honestly
- Two candidates both plausible → present **both** as candidates and ask the user to disambiguate (one anchor from them usually resolves it instantly).
- Contradicting data (a number on one source, a different number on another) → show both with their sources; don't silently pick one.
- Nothing reliable → say so, name the most likely candidate if there is one (labelled Possible), and propose the next rung. An honest "not found, here's the next thing to try" beats a confident wrong answer every time.

## 7. What gets attached to the resolved identity
Only once a candidate is the resolved target do you attach its channels to the person card — each still carrying its own per-datum confidence and source. Identity confidence and per-datum confidence are separate: you can be Confirmed on *who* they are and only Possible on a specific phone number. Say both.
