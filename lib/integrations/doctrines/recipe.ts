// Recipe artifact JSON schema (application/vnd.ant.recipe).
//
// Loaded lazily into the orchestrator prompt only after
// ActivateIntegrationTools(...) for this capability (see
// lib/integrations/subsystem-manifest.ts + lib/integrations/exposure.ts).
export const RECIPE_DOCTRINE = `
<recipe_schema>
For \`application/vnd.ant.recipe\`, the artifact body is a JSON object with this shape (TypeScript notation for clarity — emit JSON, not TS):

\`\`\`
{
  title: string;                          // required, ≤160 chars
  subtitle?: string;                       // ≤280 chars
  servings: {
    default: number;                       // required integer ≥1, the starting value
    min?: number; max?: number;            // optional bounds
    unitLabel?: string;                    // default "porții"; e.g. "felii", "pahare"
  };
  prepMinutes?: number;                    // active prep before cooking
  cookMinutes?: number;                    // time food is being cooked
  totalMinutes?: number;                   // total elapsed incl. rests; falls back to prep+cook
  difficulty?: 'usor' | 'mediu' | 'greu';
  imageQuery?: string;                     // search string used to fetch web images
  ingredients: Array<{
    amount?: number;                       // omit for "sare după gust"-style items
    unit?: 'g'|'kg'|'ml'|'cl'|'l'|'tsp'|'tbsp'|'bucata'|'buc'|'catel'|'catei'|'felie'|'felii'|'priza'|'varf'|'cana'|'capac';
    name: string;                          // required
    note?: string;                         // rendered as muted "(…)" aside
    scaleable?: boolean;                   // default true; false for items that don't scale linearly (1 frunză dafin, 1 ou într-un aluat mic)
    group?: string;                        // consecutive items with the same group render under that subheading ("Pentru sos:")
  }>;                                       // 1..60 items
  steps: Array<{
    title?: string;                        // short bolded action header
    body: string;                          // plain text or light markdown (no headings/code blocks)
    timerSeconds?: number;                 // 1..86400 — renders a live countdown chip
  }>;                                       // 1..40 items
  notes?: Array<{ heading?: string; bullets: string[] }>;
  attribution?: string;                    // recipe source (cookbook, site, chef)
}
\`\`\`

Rules:
- Units are METRIC ONLY (and Romanian count units). Never emit "oz", "cup", "lb", "fl oz" — the parser rejects them.
- An \`amount\` always comes with a \`unit\`, and a \`unit\` always comes with an \`amount\`. Use neither for items like "sare după gust".
- \`scaleable: false\` for ingredients that don't double when servings double (single bay leaf, one egg in a small dough). Default \`true\`.
- \`timerSeconds\` ONLY for actual hands-off waits the user benefits from timing (sotat usturoi 2:30, fiert ou 8:00, dospit 60:00). Don't add a timer to "amestecă bine" or "serveşte cald".
- Scaleable quantities inside step \`title\` / \`body\` and inside note \`bullets\` MUST be wrapped in \`{{...}}\` so the renderer scales them with the servings stepper. Inside the braces write a single quantity in the form \`<number> <unit>\` or \`<low>-<high> <unit>\`, using the SAME metric units as the ingredient list. Examples:
    - "Păstrează {{120 ml}} din apa de fiert" → scales 120 ml × ratio
    - "Adaugă {{2-3 linguri}} de zahăr" → both ends scale
    - "Folosește {{0.5 catel}} usturoi" → scales fractional too
  Leave these as PLAIN TEXT (no braces) because they don't scale with portions:
    - times: "1 minut", "2-3 minute", "30 secunde"
    - oven temp: "180°C"
    - approximate / qualitative: "o priză de sare", "după gust", "câteva picături"
  When the body just refers to an ingredient already in the list, prefer naming it ("untul", "parmezanul") over restating the amount.
- \`imageQuery\` should be set for almost every recipe — it triggers the renderer to fetch attribution-clean photos from Wikimedia Commons and show them above the title. Use English search terms ("penne arrabbiata", "ciorbă de burtă", "ratatouille") rather than full sentences. Skip it only for very abstract dishes a search wouldn't find sensibly.
- NEVER hand-write the \`images\` array. You have no image-search tool, so any URL you put there is a guess that will 404 and render as a broken-image placeholder. Always rely on \`imageQuery\` and let the renderer fetch live, verified photos.
- Always include \`identifier\` and \`title\` attributes on the \`<artifact>\` tag. Use \`display="inline"\` unless the recipe is very long.
- Compose recipes as artifacts whenever the user asks for one — even simple ones. The card is the right surface; plain markdown is the fallback.
</recipe_schema>
`.trim()
