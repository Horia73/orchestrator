# Semnătura electronică (România + eIDAS)

For `legal-signature-request`. ⚠️ **STATUS CRITIC: Legea 455/2001 este ABROGATĂ.** Guvernează **Legea 214/2024** (în vigoare din **8 oct 2024**) + **eIDAS (Reg. UE 910/2014)**, direct aplicabil. Nu cita 455/2001 ca lege în vigoare.

## eIDAS — cele 3 niveluri
- **Simplă (SES)** (art. 3(10)): orice marcă electronică (scan, nume tastat, click-accept). Admisibilă, dar valoare probatorie mică.
- **Avansată (AES)** (art. 3(11) + art. 26): 4 cerințe — legată unic de semnatar, îl identifică, sub controlul său exclusiv, orice modificare ulterioară detectabilă (tamper-evidence).
- **Calificată (QES)** (art. 3(12)): AES creată cu un **dispozitiv calificat (QSCD)** + **certificat calificat** (de la un QTSP din Trusted List UE). **Singurul nivel cu echivalență automată cu semnătura olografă** (art. 25(2)).
- **Art. 25(1):** o semnătură electronică nu poate fi respinsă ca probă doar pentru că e electronică. **Art. 25(3):** QES recunoscută cross-border în toate SM.
- **eIDAS 2.0 (Reg. 2024/1183):** EUDI Wallet (portofel de identitate; QES de pe smartphone) — rollout până ~dec 2026, verifică disponibilitatea RO.

## Legea 214/2024 — efecte pe tip (art. 4) — mai granular decât eIDAS
- **QES (art. 4(1)):** asimilată **înscrisului sub semnătură privată**; semnată de o autoritate publică cu semnătură/sigiliu calificat → **act autentic** (art. 4(2)). **Universal sigură — default-ul.**
- **AES (art. 4(3),(5)):** efect de semnătură olografă DOAR alternativ: (i) certificat de la o autoritate publică RO / QTSP, SAU (ii) contrapartea o recunoaște, SAU (iii) acord scris prealabil (nu e cerut între doi profesioniști). **NU e automat echivalentă cu olograful.**
- **Simplă (art. 4(4),(9)):** valabilă ad probationem; efect olograf doar pentru **acte de mică valoare** (< ½ salariu minim la data semnării), SAU recunoaștere, SAU între profesioniști cu acord scris.
- **Act autentic (art. 4(11)):** dacă legea cere formă autentică → autentificare + **doar QES** poate atinge echivalența (niciodată AES/simplă).
- A abrogat și Legea 451/2004 (marca temporală, acum în 214/2024) și OUG 38/2020. Supervizor: **ADR (Autoritatea pentru Digitalizarea României)**, ține Trusted List RO.

## Când e obligatorie QES vs suficient AES/simplă
| Scenariu | Cerință |
|---|---|
| Acte în **formă autentică** (imobile, donații, testament, convenție matrimonială) | **QES** + autentificare notarială |
| Relația cu autorități (SPV/ANAF) | certificat calificat în practică |
| Documente de muncă (CIM) | **Codul Muncii art. 16(12):** angajatorul poate opta simplă/AES/QES; QES nu e obligatorie (best practice AES/QES pt CIM) |
| Contracte comerciale B2B | simplă/AES suficient, mai ales între profesioniști |
| Contracte materiale cu consumatori | AES/QES recomandat |

## Acte care NU pot fi semnate electronic (formă autentică notarială)
Guvernate de **Cod Civil**; lipsa formei → **nulitate absolută**; doar QES via notar atinge autenticul:
- Transfer/constituire drepturi reale imobiliare (**art. 1244**); ipotecă imobiliară (art. 2378).
- **Donații** (art. 1011).
- **Testamente** — olograf (art. 1041) scris/datat/semnat de mână; autentic (art. 1043) notarial.
- **Convenție matrimonială** (art. 330).
- Orice act pe care legea îl cere în formă autentică (art. 1242).

## QTSP calificați în RO (verifică EU Trusted List / ADR — status live)
certSIGN, DigiSign, Trans Sped, AlfaTrust (AlfaSign), Centrul de Calcul. Sursa autoritativă: **EU Trusted List Browser** (filtru România).
