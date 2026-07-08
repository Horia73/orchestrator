# Investitori & finanțare — structurare capital (România)

For `legal-risk-assessment`, `legal-review-contract`, `legal-compliance-check` on raising money. Legea 31/1990 (societăți) + reglementare piețe de capital **ASF**. Cross-ref `energie-bess.md`, `contracte-civil.md`.

## ⚠️ PRIMA ÎNTREBARE: atragi bani de la MULȚI investitori / din public? Atenție ASF.
Substanță peste formă. Un model de tipul **„100+ investitori cumpără o cotă dintr-un activ (baterie/proiect) operat de altcineva pt profit, cu revânzare a cotei la o fază ulterioară"** — chiar dacă e „îmbrăcat" ca vânzare de bunuri și disclaimer „nu e ofertă publică / nu e consultanță financiară" — poate declanșa **trei regimuri reglementate ASF**. Un disclaimer NU vindecă substanța, iar activitatea financiară neautorizată = amenzi ASF + posibil penal. ASF publică liste de **entități neautorizate**.

1. **Ofertă publică de valori mobiliare** — Legea 24/2017 + Prospectus Reg. (UE) 2017/1129. Regula: **prospect aprobat de ASF**. **Scutiri** cheie: ofertă către **< 150 persoane/stat membru** (altele decât investitori calificați), sau total **< 1.000.000 €/12 luni**, sau doar către investitori calificați. → Un „private placement" curat sub 150 de persoane poate fi scutit de prospect, dar rămâne ofertă de instrumente.
2. **Fond de investiții alternativ (FIA)** — Legea 74/2015 (AFIA, transpune AIFMD) + **Legea 243/2019**. FIA = organism care **atrage capital de la un număr de investitori** spre a-l investi conform unei **politici definite** în beneficiul lor. Un pool de investitori care co-dețin active operate de un terț pt randament **se potrivește definiției FIA** → ar necesita **AFIA autorizat / autorizare ASF**. *Acesta e riscul cel mai mare pt modelul „comunitate de investitori".*
3. **Crowdfunding** — Reg. (UE) 2020/1503 (ECSP) + **Legea 244** (ASF = autoritate competentă). Atragerea de fonduri **de la public, online, pt un proiect** trebuie făcută printr-o **platformă de crowdfunding autorizată ASF**; plafon **5M€/12 luni/proiect**. „Cumpără online o cotă de proiect, 100+ investitori" = crowdfunding tipic.

### Structurare LEGALĂ (recomandările de dat)
- **Constituie un SPV dedicat** (scoate proiectul din SRL-ul operațional — evită comingling, izolează răspunderea, curăță due diligence).
- **SA vs SRL:** pt **mulți investitori** → **SA** (acțiuni liber transferabile, poate emite **acțiuni preferențiale** — dividend prioritar/fără vot, potrivite pt investitori pasivi). **SRL** = mai simplu dar transferul de părți sociale către terți cere **≥3/4** din capital (Legea 31/1990) → nepractic pt sindicalizare largă.
- **Ține-te în scutiri:** rundă privată **< 150 investitori** (necalificați) / doar investitori calificați / **< 1M€/12 luni**, cu documente clare (nu marketing „public").
- **SAU** folosește o **platformă de crowdfunding autorizată ASF** dacă vrei public larg.
- Validează structura cu **avocat de piețe de capital / ASF** înainte de a solicita bani. Aceasta NU e o zonă de „workaround" — vezi `doctrina-grey-zone.md`: disclaimer-ul e exact tipul de „îmbrăcăminte" care nu ține la ASF.

## Documentele rundei (equity privat — B2B, drept civil)
- **Term sheet** — neangajant, EXCEPTÂND clauzele de exclusivitate/confidențialitate/no-shop (angajante). Setează evaluarea, suma, instrumentul.
- **Instrument:** equity direct (majorare de capital + emisiune de părți/acțiuni noi), **convertibil / SAFE** (amânare a evaluării), sau împrumut cu opțiune.
- **Pact de acționari (SHA)** — Legea 31/1990 dă doar minimul; SHA-ul personalizează. **Forma scrisă e suficientă** (fără cerințe de validitate). Clauze uzuale: **drag-along / tag-along** (TREBUIE prevăzute expres — nu sunt implicite), preemțiune, anti-diluție, **lichidare preferențială**, vesting fondatori, board/observator, drepturi de veto pe decizii majore, information rights, non-compete fondatori (vezi `munca-nda.md`).
- **Majorare de capital:** hotărâre AGA (extraordinară pt SA) + act constitutiv actualizat + dovada aportului + **înregistrare la Registrul Comerțului** (ONRC).
- **Due diligence** (investitorul verifică): titlu asupra părților/acțiunilor, acte corporative + SHA existent, dosarele ONRC, litigii (portal instanțe), **permite/avize** (la BESS: ATR, AC, licență ANRE — vezi `energie-bess.md`), contracte-cheie (EPC/O&M/teren), datorii fiscale (certificat ANAF), IP.

## Ajutor de stat vs investitori privați
Dacă proiectul ia **grant** (FpM/PNRR — vezi `energie-bess.md`), verifică compatibilitatea cu structura de investitori privați și regulile de **cumul** (intensitate/plafon GBER pe aceleași costuri eligibile); dubla finanțare nerambursabilă e ineligibilă.

## Fiscal la exit/randament
Randamentul investitorilor (dividende/plusvaloare) — vezi `fiscal-optimizare.md` (impozit dividende **10%→16% din 2026**, plusvaloare din cesiune părți/acțiuni, CASS pe venituri din investiții).
