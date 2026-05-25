/**
 * Centralized glossary of workout / fitness jargon.
 *
 * Drives the `<GlossaryInfo term="…" />` component — a small (?) icon that
 * pops over with an explanation. Adding a new term once here makes it
 * available anywhere in the workout UI.
 *
 * Romanian-leaning explanations because that's the user's language; English
 * equivalents listed in `aka` for searchability and so the popover can show
 * "RPE (Rate of Perceived Exertion)" headers.
 *
 * Keep each `body` short (1-3 sentences). The popover is for "oh that's
 * what that means", not a textbook. If something needs paragraphs, link out.
 */

export interface GlossaryEntry {
    /** Display headline — usually the term itself, capitalised. */
    title: string
    /** Optional alternative names / acronym expansion shown next to title. */
    aka?: string
    /** 1-3 sentence explanation in Romanian. */
    body: string
    /** Optional example value the user can use as a mental anchor. */
    example?: string
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
    // --- intensity / fatigue metrics --------------------------------------

    rpe: {
        title: 'RPE',
        aka: 'Rate of Perceived Exertion',
        body: 'Cât de greu ți s-a părut setul, pe o scară 1–10. 10 = nu mai puteai face nici o repetare; 8 = mai aveai ~2 în rezervă; 6 = ușor, ca încălzirea.',
        example: 'RPE 8 înseamnă "puteam 2 reps în plus dacă insistam"',
    },
    rir: {
        title: 'RIR',
        aka: 'Reps in Reserve',
        body: 'Câte repetări mai aveai "în rezervă" la sfârșitul setului — invers față de RPE. RIR 0 = până la failure, RIR 2 = mai puteai 2.',
        example: 'RIR 2 ≈ RPE 8',
    },

    // --- one-rep max / PB -------------------------------------------------

    '1rm': {
        title: '1RM',
        aka: 'One Rep Max',
        body: 'Greutatea maximă pe care o poți ridica O SINGURĂ DATĂ. Mai mult un proxy estimat (din seturi multiple) decât testat real — testarea efectivă obosește prea tare ca să fie săptămânală.',
        example: '"est. 1RM 80kg" = pe baza unui set de 65×8, formula estimează că ai putea face 80kg×1',
    },
    pb: {
        title: 'PB',
        aka: 'Personal Best',
        body: 'Cea mai bună performanță proprie la un exercițiu — fie greutate × reps, fie hold maxim, fie distanță. Stocată în istoricul tău și folosită ca reper.',
    },
    tonnage: {
        title: 'Tonnage',
        aka: 'Volum total',
        body: 'Suma totală greutate × reps pe toată sesiunea. Un indicator brut al cantității de muncă făcute — util pentru a vedea progresul săptămână peste săptămână.',
        example: '4 seturi × 60kg × 8 reps = 1920 kg tonnage doar pe acel exercițiu',
    },

    // --- set kinds --------------------------------------------------------

    warmup: {
        title: 'Warmup',
        aka: 'Încălzire',
        body: 'Seturi ușoare înainte de cele de lucru. Pregătesc musculatura și sistemul nervos pentru greutățile grele, dar NU intră în calculul progresiei.',
    },
    working: {
        title: 'Working set',
        body: 'Setul "real" — cel care contează pentru progresie și recuperare. Greutate apropiată de target, RPE moderat-high.',
    },
    top_set: {
        title: 'Top set',
        body: 'Cel mai greu set al exercițiului — punctul maxim de stres al zilei. Folosit ca sursă pentru tracking progresie (de obicei un singur top set, urmat de back-off sets mai ușoare).',
    },
    back_off: {
        title: 'Back-off set',
        body: 'Set făcut după top set, la o greutate redusă (5-15%), pentru volum adițional fără epuizare totală.',
        example: 'Top set 100kg × 5 → Back-off 90kg × 8',
    },
    drop_set: {
        title: 'Drop set',
        body: 'Imediat după un set normal, scazi greutatea și continui fără rest. Tehnică de intensificare pentru hipertrofie.',
        example: '60kg până la failure → scoate plăcile → 45kg până la failure, fără pauză',
    },
    amrap: {
        title: 'AMRAP',
        aka: 'As Many Reps As Possible',
        body: 'Set în care faci câte repetări poți, până la failure tehnic. De obicei ultimul set al exercițiului — bun pentru tracking progresie și pentru a verifica RIR-ul tău.',
    },
    cluster: {
        title: 'Cluster set',
        body: 'Set spart în mini-bucăți cu mini-pauze (10-20s) în interior, ca să poți face MAI MULTE reps grele decât într-un set continuu. Ex: 5×3 cu 15s pauză = 15 reps grele.',
    },

    // --- group kinds ------------------------------------------------------

    straight: {
        title: 'Straight set',
        body: 'Forma standard — termini toate seturile unui exercițiu (cu pauze între ele) înainte să treci la următorul.',
    },
    superset: {
        title: 'Superset',
        body: 'Două exerciții făcute spate-în-spate fără rest, apoi rest după al doilea. Economisesc timp; bun pentru grupe musculare antagoniste (chest + back) sau pentru a stresa o grupă din mai multe unghiuri.',
    },
    circuit: {
        title: 'Circuit',
        body: 'Trei sau mai multe exerciții făcute consecutiv, rest doar după ce ai terminat tot circuitul. Bun pentru finishere de hipertrofie sau cardio metabolic.',
    },
    giant_set: {
        title: 'Giant set',
        body: 'Patru sau mai multe exerciții în secvență, fără rest. Versiunea extremă a circuitului — folosit pentru hipertrofie intensă pe o singură grupă musculară.',
    },

    // --- protocol types ---------------------------------------------------

    tabata: {
        title: 'Tabata',
        body: 'Protocol HIIT clasic: 20 secunde la maxim + 10 secunde rest, repetat de 8 ori (4 minute total). Cardio intens, economic în timp.',
    },
    emom: {
        title: 'EMOM',
        aka: 'Every Minute On the Minute',
        body: 'La fiecare minut nou, începi un nou set de reps — timpul rămas până la următorul minut e rest-ul tău. Ex: EMOM 10 min, 5 burpees: dacă faci în 30s, ai 30s rest; dacă faci în 50s, ai 10s.',
    },

    // --- other ------------------------------------------------------------

    tempo: {
        title: 'Tempo',
        body: 'Cadența mișcării: 4 cifre — eccentric / pause / concentric / pause. "3-1-1-0" = 3s coborâre, 1s pauză jos, 1s ridicare, fără pauză sus. Tempo lent crește time-under-tension.',
    },
    rest_pause: {
        title: 'Rest-pause',
        body: 'Set până aproape de failure → 10-15s pauză scurtă → câteva reps în plus → repetă. Tehnică de intensificare similar cu cluster set.',
    },
    deload: {
        title: 'Deload',
        body: 'Săptămână (sau câteva sesiuni) cu intensitate redusă (60-75% din normal) pentru recuperare. Previne supraantrenamentul și de obicei aduci de PR-uri săptămâna următoare.',
    },
    weighted_bw: {
        title: 'Weighted bodyweight',
        body: 'Exerciții cu greutatea proprie + greutate adăugată (centură cu plăci, vesta) — sau cu asistență (band, machine). Valori negative aici = asistență.',
    },
}

/** Get an entry by case-insensitive key, returning undefined if not found. */
export function getGlossary(term: string): GlossaryEntry | undefined {
    return GLOSSARY[term.toLowerCase().replace(/[\s-]/g, '_')]
}
