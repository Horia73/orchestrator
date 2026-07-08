# Energie & stocare (BESS) — RO + EU

For energy-storage projects (`legal-compliance-check`, `legal-risk-assessment`, `legal-review-contract` on EPC/O&M/PPA). Cadru: **Legea 123/2012** (energie electrică) + Directiva (UE) 2019/944 + Reg. 2019/943. **Reverifică pragurile/tarifele/granturile la runtime** — se schimbă des.

> Context uzual al utilizatorului: BESS **merchant** (arbitraj + servicii de echilibrare) la scară de rețea, în dezvoltare. Vezi și `investitori-finantare.md` pt structura de capital (partea cu cel mai mare risc de reglementare — ASF) și `regulatori.md` (ANRE, ANAF).

## Licențiere ANRE (Legea 123/2012 + Reg. licențe din 12.03.2025, Ordin ANRE 65/2021 Cod RET)
- Stocare **> 1 MW**: necesită **licență** ANRE (dacă e atașată unei capacități de producție → modificarea licenței de exploatare comercială să includă stocarea) SAU **autorizație de înființare** pt exploatarea comercială a instalației de stocare de sine stătătoare. Licența de "producător de energie electrică" e necesară pt participare pe piețe. Durată 5 ani.
- Stocare **≤ 1 MW** (prag extins la **400 kW** pt persoane juridice/instituții/ONG): **fără licență** ANRE.
- ⚠️ Atenție distincție: **atestatele ANRE de proiectare/execuție (C1A/C1B/C2A/C2B)** sunt pt *lucrări electrice*, **NU** licență de furnizare/trading/stocare. Modelul merchant/arbitraj cere fie **licență de furnizare** proprie, fie operare printr-un **trader/agregator licențiat** (ruta uzuală).

## Autorizare / permitting — secvența (≈7-12 luni, ~150-260k€ pt 15MW/30MWh, ~2-3% din CAPEX)
1. **Aviz de oportunitate** (primărie).
2. **ATR — Aviz Tehnic de Racordare** (Transelectrica/RET sau DSO/RED) — documentul CRITIC; legal **90 zile lucrătoare**, practic 4-6 luni; **80-150k€**; poate impune contribuții de întărire rețea **50-300k€** în zone congestionate. Necesită **act de proprietate/concesiune teren**, plan topo, date tehnice, studiu pre-fezabilitate.
3. **Acord de mediu** (APM) + **ISU** (incendiu — critic la BESS) + **DSP** (sănătate). De regulă **fără EIM completă** (notificare simplificată).
4. **Certificat de urbanism** (primărie, valabil 12 luni; verifică PUG/PUZ).
5. **Proiect Tehnic (PT)** + verificare tehnică.
6. **Autorizație de construire** (primărie, 30 zile — **Legea 50/1991**).
7. **Licență ANRE** (după ATR + AC + capital minim + garanții + asigurare RC).
8. **Certificat de racordare** — după realizarea instalației.

## Venituri (revenue stacking — piețe simultane)
- **aFRR** (rezervă secundară, activare automată): ~80-150 €/MW/zi + 100-200 €/MWh activat.
- **FCR** (primară): ~40-80 €/MW/zi. **mFRR** (terțiară): ~30-60 €/MW/zi + 150-300 €/MWh.
- **Arbitraj DAM/IDM** (OPCOM): ~10-60 €/MWh (cumpără ieftin la prânz din surplus solar, vinde la vârf de seară).
- Piața de echilibrare RO **nesaturată**: Transelectrica >250M€/an → >600M€ până în 2030; market coupling aFRR cu HU/BG/MD până 2026 (Reg. UE 2017/2195).
- Servicii tehnologice de sistem (STS) — contract cu Transelectrica; prekalificare tehnică necesară.

## Cadru EU — Directiva 2019/944 (avantaje pt stocare)
- Definiție largă a **stocării**; **fără dublă taxare** a energiei stocate (incl. tarife de rețea) pt clienții activi (energie rămasă în incintă sau flexibilitate); acces **nediscriminatoriu** la piețele de echilibrare; TSO/DSO pot deține stocare doar condiționat (regula generală: să nu o dețină, cu excepții).

## Finanțare & ajutor de stat
- **Fondul pentru Modernizare** — RO alocare majoră (~636,9M€ pt stocare, Program cheie 1). Ministerul Energiei.
- **PNRR sub-măsura 4.3** (baterii). **Schema de ajutor de stat: Ordinul 1355/2024** (FpM, baza **art. 41 GBER / Reg. 651/2014**): intensitate **până la 100%** din costurile eligibile, **max 10M€/întreprindere**, valabilă până **31.12.2027**.
- **Ineligibile** (Ordin 1355/2024): proiecte RES+stocare *behind-the-meter* sau stocare neconectată la o instalație RES existentă; baterii Pb/NiCd/NiMH; înlocuirea de capacități vechi; stocare exclusiv din SEN; proiecte deja finanțate nerambursabil.
- **Cumul** ajutor: permis dacă nu depășește intensitatea/plafonul GBER pe aceleași costuri eligibile. Notă: granturile de stat pot fi incompatibile cu modelul „merchant + investitori privați" — vezi `investitori-finantare.md`.

## Contracte-cheie de review (via `contracte-civil.md`)
- **EPC** (proiectare-achiziție-construcție): garanții de performanță/capacitate, LD-uri (clauză penală art. 1538, reductibilă art. 1541), garanție de bună execuție, transferul riscului, teste de punere în funcțiune.
- **O&M** / contract cu trader-agregator: disponibilitate garantată, split de venituri, KPI, răspundere (plafon — art. 1355).
- **Contract de racordare** cu operatorul de rețea; **teren**: superficie/concesiune/arendă pe durata proiectului (min 15-20 ani), înscrisă în CF.
- **PPA** (dacă aplicabil) — nu în modelul merchant pur.
