# Protecția datelor — GDPR + Legea 190/2018 (România)

For `legal-compliance-check` and `legal-response` (DSR, breach). GDPR (Reg. 2016/679) applies directly; **Legea 190/2018** only exercises national opening clauses — read it ON TOP of GDPR, never instead. Authority: **ANSPDCP** (dataprotection.ro).

## Legea 190/2018 — national add-ons that matter
- **Art. 4 — CNP / național ID** (CNP, serie+nr CI, pașaport, permis, nr. asigurat sănătate): prelucrabil pe orice temei art. 6(1) GDPR, DAR dacă temeiul e **interesul legitim (6(1)(f))** → 4 garanții cumulative incl. **DPO OBLIGATORIU** (add-on național emblematic, chiar dacă art. 37 GDPR nu l-ar cere). *Tip: preferă un temei non-(f) — obligație legală/contract/consimțământ — ca să eviți trigger-ul de DPO.*
- **Art. 5 — monitorizarea angajaților** (comunicații electronice / supraveghere video, pe interes legitim) permisă doar dacă TOATE 5: (a) interesul legitim prevalează, documentat; (b) informare prealabilă completă și explicită; (c) **consultarea sindicatului/reprezentanților** înainte; (d) alternative mai puțin intruzive au fost încercate și au eșuat (subsidiaritate); (e) stocare proporțională, **max 30 zile** (excepții: lege / caz justificat). Consimțământul NU e temeiul. (Bărbulescu c. României, CEDO.)
- **Art. 3** — date genetice/biometrice/sănătate pentru decizii automate/profilare → consimțământ explicit sau lege expresă.
- Cookies / marketing electronic → **Legea 506/2004** (comunicații electronice) + ePrivacy.

## Drepturile persoanei vizate (DSR) — pentru `legal-response`
- GDPR art. 15–22: acces, rectificare, ștergere, restricționare, portabilitate, opoziție.
- Termen: **1 lună** de la cerere, extensibil cu **+2 luni** pentru complexitate (cu informarea persoanei). Verifică identitatea solicitantului. De regulă gratuit; cerere vădit nefondată/excesivă → taxă rezonabilă sau refuz motivat.

## Breach — notificare (pentru `legal-response` litigation/incident)
- **Art. 33 GDPR:** notifică ANSPDCP **fără întârziere nejustificată, ≤72h** de la luarea la cunoștință, **dacă e probabil un risc**; peste 72h → cu justificarea întârzierii. Conținut: natura, categorii+număr aprox. persoane/înregistrări, DPO, consecințe probabile, măsuri.
- **Art. 33(5):** documentează **ORICE** breach (registru intern), inclusiv cele nenotificate.
- **Art. 34:** comunică **persoanelor vizate** dacă **risc ridicat** (excepții: date criptate/neinteligibile; măsuri ulterioare; efort disproporționat → comunicare publică).
- Canal RO: formular online pe **dataprotection.ro** (Decizia 128/2018).
- ⚠️ Tier trap: eșecul de notificare (art. 33/34) și securitate (art. 32) sunt în tier-ul **inferior** de amendă (art. 83(4) — €10M/2%), NU tier-ul superior.

## Amenzi (art. 83 GDPR + Legea 190/2018)
- **Privat:** tot regimul GDPR — **€10M/2%** (art. 83(4): art. 8, 11, 25–39, 42, 43 — incl. securitate + breach) și **€20M/4%** (art. 83(5): principii/consimțământ art. 5–9, drepturi art. 12–22, transferuri art. 44–49). Fără plafon, fără plan de remediere prealabil.
- **Autorități/organisme publice** (+ asimilate: unități de cult, asociații/fundații de utilitate publică): regim **mult mai blând** — întâi **avertisment + plan de remediere ≤90 zile**, amendă doar dacă nu remediază, plafonată la **10.000–100.000 lei** (tier inferior) / **10.000–200.000 lei** (tier superior) (Legea 190/2018 art. 13–14).
- Nicio infracțiune GDPR nouă; penalul trece prin Codul penal (art. 302, 360–366). Despăgubiri civile: art. 82 GDPR, direct în instanță (material + moral; nu simpla încălcare — CJUE C-300/21).

## Practică
- Enforcement RO: prima amendă WTC București (2019, ~71.028 lei, art. 32); UniCredit €130.000 (art. 25); ~83 amenzi / ~1,86 mil lei în 2024 (indicativ).
- DPIA (art. 35) frecvent necesar pentru monitorizare sistematică / date sensibile la scară; consultare prealabilă ANSPDCP (art. 36) dacă risc rezidual ridicat.
