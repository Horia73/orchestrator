# Agenție web & platformă AI — drept aplicabil (RO + EU)

For `legal-review-contract` (contracte clienți), `legal-compliance-check` (GDPR/AI Act/accesibilitate), `legal-risk-assessment`. Cross-ref `contracte-civil.md`, `protectia-datelor.md`, `consumator.md`, `fiscal-optimizare.md`.

> Profil uzual: SaaS + agenție care construiește/găzduiește site-uri pt IMM-uri românești, cu agenți AI care editează codul site-urilor și un chatbot; **processor** pt datele end-userilor clienților. Clienți = **B2B** (art. 1203 Cod Civil, nu drept consumator), exceptând PFA/persoane fizice.

## 1. IP-ul codului & conținutului — Legea 8/1996 (Cap. IX, art. 73-82)
- **TRAP major:** pt **opere comandate / viitoare**, în lipsa unei **clauze contrare exprese**, **AUTORUL (dezvoltatorul) păstrează drepturile patrimoniale** — clientul **NU** deține automat codul site-ului. → Contractul cu clientul TREBUIE să conțină o **clauză de cesiune expresă** ca IP-ul să treacă la client (sau, dacă vrei să reții IP-ul platformei, o **licență** clară).
- Cesiunea = **formă scrisă** (probată doar prin scris). Trebuie să specifice: **modalitățile de utilizare, durata, teritoriul, remunerația**. Cesiunea **tuturor operelor viitoare** ale autorului = **nulitate absolută** (nu ceda „tot ce voi crea vreodată").
- Protejat: cod sursă + obiect, material de proiectare, manuale. NEprotejat: idei, algoritmi, metode, concepte de interfață.

## 2. Cod/conținut generat de AI — cine e autorul?
- Legea 8/1996: autor = **persoană fizică**. **Output pur AI (fără contribuție umană creativă semnificativă) probabil NU e protejat** de dreptul de autor → nu poți cesiona clientului ce nu e protejabil, iar terții l-ar putea copia liber. Unde un om **dirijează/selectează/editează semnificativ**, protecția se atașează contribuției umane.
- Practic în contract: **gestionează așteptările de exclusivitate** (nu garanta că site-ul generat e „protejat prin drept de autor" dacă e output AI pur); reține un **om în buclă** (aprobare/editare) și documentează contribuția umană; warrant că livrabilul nu încalcă IP terț și respectă licențele **open-source** folosite.
- Termenii providerilor AI (Anthropic/OpenAI etc.): de regulă **outputul e al clientului/utilizatorului**, dar verifică licența și **NU folosi abonamente personale (consumer) pt a servi clienți plătitori** — încalcă ToS; folosește tier **business/API**.

## 3. GDPR — ești CONTROLLER și PROCESSOR simultan
- **Controller** pt datele proprii (lead-uri site marketing, cont utilizatori-clienți). **Processor (persoană împuternicită)** pt **datele end-userilor clienților** (lead-uri, transcript chat, rezervări, review-uri) pe care le stochezi în numele clientului.
- Ca processor îți trebuie un **DPA (GDPR art. 28)** cu **fiecare client**, care acoperă: obiect/durată/scop, categorii de date, instrucțiuni, confidențialitate, securitate (art. 32), **subprocesatori** (autorizare + notificare), asistență la DSR/breach, ștergere/returnare la final, audit. **GAP tipic: nu există template DPA** — de creat.
- **Lanț de subprocesatori** back-to-back: **Vercel** (hosting), **Resend** (email), **Anthropic** (AI) — fiecare cu DPA propriu + **SCC 2021 Modul 2/3** pt transfer extra-UE. Pt **rezidență UE** la AI: Anthropic via **Bedrock Frankfurt** (elimină transferul). Enumeră subprocesatorii în DPA + politica de confidențialitate.
- **Analytics cookieless** (hash HMAC zilnic, fără stocare IP) → apărabil **fără banner de consimțământ** (Legea 506/2004 / ePrivacy). Dacă adaugi cookies non-esențiale → consimțământ necesar.
- Vezi `protectia-datelor.md` pt DSR (1 lună), breach (72h), amenzi.

## 4. EU AI Act (Reg. UE 2024/1689)
- **Chatbot** = sistem AI cu **obligații de transparență (art. 50)**: utilizatorul trebuie **informat că interacționează cu un AI**; **conținutul generat de AI** (text/imagini) trebuie **marcat** ca atare (machine-readable). Aplicabil **din 2 aug 2026** (regulile GPAI din 2 aug 2025).
- Editorul AI care scrie cod = de regulă risc **limitat/minim** (nu „high-risk" per Anexa III), dar păstrează transparența + human-in-the-loop.
- Amenzi: **€35M/7%** (practici interzise), **€15M/3%** (alte obligații), **€7,5M/1%** (info incorecte). Se aplică și firmelor din RO.

## 5. Accesibilitate — EAA / Legea 232/2022 (transpune Dir. UE 2019/882)
- Din **28 iunie 2025**: site-urile și **serviciile online** (mai ales **e-commerce**, bancar, transport, telecom) trebuie să respecte **EN 301 549 / WCAG 2.1 nivel AA**.
- **Scutire microîntreprindere** (< 10 angajați **ȘI** < 2M€ cifră/bilanț) pt SERVICII. Amenzi **2.500–15.000 lei** + măsuri complementare (suspendare activitate).
- Relevant dublu: (a) **răspundere/argument de vânzare** — tu construiești site-urile, deci conformitatea WCAG e o obligație de calitate față de clienți peste prag (mai ales magazine online); (b) declarație de accesibilitate pe site.

## 6. Contractul cu clientul (B2B) — clauze esențiale
- **Obiect** (dezvoltare + abonament SaaS + module), **acceptanță** (modelul „preview înainte de plată" = condiție de acceptare; documentează), **cesiune IP** (§1) sau licență, **SLA/uptime** + mentenanță, **răspundere plafonată** (art. 1355 — nu pt culpă gravă/vătămare), **date/DPA** (§3), **reziliere** (fără lock-in, migrare gratuită — respectă ce promiți în ToS), **prețuri/facturare** (e-Factura + Oblio — vezi `fiscal-optimizare.md`), **clauză penală** pt neplată (art. 1538, reductibilă 1541).
- **ToS & Politica de confidențialitate publice:** completează **placeholder-ele de entitate** (denumire legală, **CUI**, sediu) — un contract cu partea în alb e risc de neexecutare/inducere în eroare. Aliniază promisiunile (as-is, drepturi consumator, subprocesatori) cu realitatea.
- End-userii clienților pot fi **consumatori** → clientul e controller/comerciant acolo (drept consumator, `consumator.md`); tu rămâi processor.
