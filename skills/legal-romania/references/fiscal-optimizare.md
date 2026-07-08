# Fiscal & corporate — optimizare legală (România, 2025–2026)

Legea 227/2015 (Codul Fiscal), amended by **OUG 156/2024** (for 2025), **Legea 141/2025** (Pachetul fiscal I, mostly from 2026), **OUG 89/2025** ("trenuleț" 2026). **Every number below is dated and MUST be re-verified with `web_search` before you present it** (see the SKILL.md currency rule). Official: `anaf.ro`, `static.anaf.ro`, `legislatie.just.ro`.

## Salariul minim brut (the anchor for all plafoane)
- 2024: 3.700 → **2025: 4.050 lei** (HG 1506/2024, from 1 Jan) → **2026: 4.050 lei H1, 4.325 lei from 1 Jul 2026**.
- ⚠️ **Trap:** the 2026 annual CAS/CASS plafoane are computed on the wage in force on **1 Jan 2026 = 4.050 lei**, NOT the July 4.325 figure. A calculator using 4.325 for 2026 D212 plafoane is wrong.

## Micro-întreprindere (art. 47, 51)
| | 2025 | 2026 |
|---|---|---|
| Plafon venituri | **250.000 €** (OUG 156/2024) | **100.000 €** (OUG 89/2025) — tested on revenue at 31.12.2025 |
| Cotă | **1%** (venit ≤ 60.000 € și fără CAEN listate) / **3%** (> 60.000 € sau consultanță/IT/HoReCa/avocatură/medical) | **cotă unică 1%**; the **3% bracket is eliminated** (OUG 89/2025) |
| Condiții | ≥1 salariat (or mandate ≥ salariu minim); capital ≠ stat/UAT; nu în dizolvare+lichidare; **o singură micro per acționar >25%** | same |
| Consultanță/management 80% rule | **abrogată** din 2025 (OUG 156/2024) — but pushes to 3% in 2025 | n/a (single 1%) |
- Exit: from the quarter it exceeds the cap / loses the 1-employee condition / files financials late → **impozit pe profit 16%**, no return to micro that year. The 100k cap ejects many SRLs into profit tax from 2026.

## Impozit pe profit — 16% (art. 17), unchanged.

## Impozit pe dividende (art. 43, 97(7)) — THE big 2026 change
- History: 5% (≤2022) → 8% (2023–24) → **10% from 1 Jan 2025** (OUG 156/2024) → **16% from 1 Jan 2026** (Legea 141/2025), enacted.
- **Rate follows the DISTRIBUTION date, not payment.** Distribution resolution adopted in 2025 → 10% even if paid in 2026. **Planning: adopt the AGA/interim distribution before 31.12.2025 to lock 10%.**
- Distributed-but-unpaid by year-end → tax due by **25 January**.

## CASS pe dividende (art. 170, 174) — capped, tiered on minimum wage
CASS 10% but on a **bracket floor**, not the whole dividend; base = cumulated **net** non-salary income (dividends after tax + rent + interest + gains, under ONE annual ceiling; salary/pension excluded):
| Venit anual non-salarial (2025, min. wage 4.050) | Bază CASS | CASS datorat |
|---|---|---|
| < 6 salarii (< 24.300 lei) | 0 | **0** |
| 6–12 (24.300–48.600) | 24.300 | **2.430** |
| 12–24 (48.600–97.200) | 48.600 | **4.860** |
| ≥ 24 (≥ 97.200) | 97.200 | **9.720 (cap)** |
- **Hard cap 9.720 lei/an (2025)** for dividends — negligible on large distributions. The 60→72-salarii ceiling that rose for 2026 is for **independent (PFA) income, NOT dividends** — don't conflate.

## PFA (persoană fizică autorizată)
- **Impozit 10%** pe venit net (sistem real: venit − cheltuieli − CAS − CASS, both deductible since 2024) OR pe **norma de venit** (art. 69; forced to sistem real if prior-year gross > 25.000 €).
- **CAS 25%** (art. 148) owed if net ≥ 12 salarii: 12-salarii base 48.600 → **12.150 lei**; ≥24 salarii base 97.200 → **24.300 lei (cap)**. Pensioners exempt. It's a flat *step*, not linear.
- **CASS 10%** (art. 174) linear on net income between floor **6 salarii (min 2.430 lei)** and cap **60 salarii = 24.300 lei (2025)** → **72 salarii = 29.160 lei (2026 income, Legea 141/2025)**. Even near-zero income owes the 2.430 lei floor.

## Salariu — wedge-ul (owner-manager pe payroll)
- Employee: **CAS 25% + CASS 10% + impozit 10%** (on gross − CAS − CASS − deducere) = employee keeps **~58–59%** of gross. Employer: **CAM 2.25%**. Total wedge employer-cost→net ≈ **43%**. Rates unchanged 2025/2026.

## Extraction routes — effective combined rates (per 100)
| Rută | 2025 | 2026 |
|---|---|---|
| **Micro-SRL 1% + dividend** | ~**10,9%** | ~16,8% |
| Micro-SRL 3% + dividend | ~12,7% | (3% eliminated) |
| **Profit-SRL 16% + dividend** | **24,4%** (16 + 10×0,84) | **29,44%** (16 + 16×0,84) |
| **Salariu** (marginal, incl. CAM) | ~**42–44%** | ~42–44% |
- **Dividends beat salary in every scenario**, but the gap narrows in 2026 (16% dividend). Add up to 9.720 lei/an CASS on dividends (2025) between the 6–24-salarii band.

## Why "salariu minim + dividende" is the standard structure
(1) micro needs ≥1 employee — owner on min wage / mandate ≥ min wage is cheapest; (2) buys CAS/CASS social cover dividends alone don't; (3) rest extracted as dividends at the lower combined rate. A salary does **not** reduce dividend CASS (separate obligations). Re-model every owner's split for 2026 (16% dividend + 100k micro cap).

## Compliance mandates (feed `legal-compliance-check`)
- **RO e-Factura:** B2B mandatory since 1 Jul 2024; **B2C reporting since 1 Jan 2025** (upload ≤5 days; 15%-of-invoice penalty for accepting invoices outside the system).
- **SAF-T (D406):** universal from 1 Jan 2025; no exemptions from 2026.
- **e-TVA:** ANAF pre-fills D300; reconcile discrepancies.

## Grey-zone tax tactics (lawful, with anti-abuse limits) — see `doctrina-grey-zone.md`
- **Multiple micro-SRLs to stay under the cap** → 🟠→🔴 "fragmentare artificială" caught by **Cod Fiscal art. 11** (no economic substance). One micro per >25% shareholder anyway.
- **PFA instead of employment** → **art. 7 activitate dependentă** requalification (7 criteria) if it's disguised employment.
- **PFA sistem real at high income** — CAS/CASS capped, so marginal rate ≈ 10%: genuinely efficient, low challenge risk.
- **Dividend timing to lock 10% (2025)** — legitimate; rate follows distribution date.
- **Holding / cross-border dividend routing** — lawful within participation exemption, but **DAC6 (OG 5/2020)** may require reporting the arrangement; **art. 11** substance test.
- **Hard stop:** facturi fictive, muncă la negru, ascunderea veniturilor = **evaziune, Legea 241/2005 art. 9** (criminal). Never.
