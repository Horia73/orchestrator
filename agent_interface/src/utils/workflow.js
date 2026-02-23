const CODEBASE_PATTERN = /\b(codebase|repo|repository|lint|build|bug|architecture|refactor|test)\b/i;
const RESERVATION_PATTERN = /\b(rezerv|rezervare|restaurant|masa|booking|book|cimbru|cluj)\b/i;

export function detectWorkflowScenario(message) {
  const text = String(message || '').toLowerCase();
  if (RESERVATION_PATTERN.test(text)) return 'reservation';
  if (CODEBASE_PATTERN.test(text)) return 'codebase';
  return 'generic';
}

export function buildWorkflowPlan(message) {
  const scenario = detectWorkflowScenario(message);

  if (scenario === 'reservation') {
    return {
      runTitle: 'Reservation orchestration',
      thinkingSteps: [
        'Interpretez intentia: rezervare restaurant in Cluj.',
        'Prioritizez surse oficiale + canale directe de booking.',
        'Pregatesc fallback pe telefon in caz de indisponibilitate online.',
      ],
      intro: 'Super! Incep cu research rapid si apoi pregatesc pasii pentru rezervare.',
      todoItems: [
        'Extrage intentia si constrangerile (oras, local, interval).',
        'Identifica sursa oficiala pentru rezervare.',
        'Verifica program, contact si disponibilitate.',
        'Pregateste pasii de confirmare finala.',
      ],
      toolCalls: [
        {
          title: 'Terminal',
          command: 'web.search "cimbru cluj rezervare contact program"',
          outputLines: [
            '[info] Query started...',
            '[info] Official pages and booking channels detected.',
            '[ok] Contact details + reservation path extracted.',
          ],
          lineDelay: 320,
        },
        {
          title: 'Terminal',
          command: 'web.open "booking-channel"',
          outputLines: [
            '[info] Opening reservation endpoint...',
            '[info] Validating required fields (date, time, nr. persoane)...',
            '[ok] Reservation workflow ready for confirmation.',
          ],
          lineDelay: 280,
        },
      ],
      agents: [
        {
          name: 'Researcher',
          task: 'Collect reservation channels and constraints',
          steps: [
            { text: 'Scanning trusted sources for booking links...', state: 'thinking', delay: 520 },
            { text: 'Cross-checking phone, website and opening hours...', state: 'tool_calling', delay: 760 },
            { text: 'Compiling reservation options and risks...', state: 'working', delay: 680 },
          ],
          summary: 'Research package complete',
        },
        {
          name: 'Web Agent',
          task: 'Prepare reservation action sequence',
          steps: [
            { text: 'Loading booking flow and input schema...', state: 'thinking', delay: 600 },
            { text: 'Preparing submit action with fallback path...', state: 'working', delay: 700 },
            { text: 'Waiting for user confirmation before final submit...', state: 'waiting', delay: 620 },
          ],
          summary: 'Reservation flow staged',
        },
      ],
    };
  }

  if (scenario === 'codebase') {
    return {
      runTitle: 'Codebase analysis run',
      thinkingSteps: [
        'Stabilesc scope-ul: structura, build checks, zone de risc.',
        'Rulez semnale rapide pentru a identifica hotspots.',
        'Condensez rezultatele in recomandari actionabile.',
      ],
      intro: 'Stai sa arunc o privire in codebase.',
      todoItems: [
        'Inspecteaza structura proiectului.',
        'Ruleaza semnale de build/lint relevante.',
        'Identifica riscuri si regresii probabile.',
        'Formuleaza recomandari actionabile.',
      ],
      toolCalls: [
        {
          title: 'Terminal',
          command: 'rg --files src | wc -l',
          outputLines: [
            '[info] Listing source files...',
            '[ok] Source footprint estimated.',
          ],
          lineDelay: 260,
        },
        {
          title: 'Terminal',
          command: 'npm run build',
          outputLines: [
            '[info] Running production build...',
            '[info] Bundling modules and computing chunks...',
            '[ok] Build completed successfully.',
          ],
          lineDelay: 300,
        },
      ],
      agents: [
        {
          name: 'Repo Analyst',
          task: 'Assess code quality and architecture trade-offs',
          steps: [
            { text: 'Mapping module boundaries and ownership...', state: 'thinking', delay: 560 },
            { text: 'Evaluating complexity hotspots...', state: 'tool_calling', delay: 720 },
            { text: 'Drafting risk-ranked findings...', state: 'working', delay: 680 },
          ],
          summary: 'Architecture review completed',
        },
      ],
    };
  }

  return {
    runTitle: 'Workflow run',
    thinkingSteps: [
      'Clarific obiectivul cererii.',
      'Selectez instrumentele minime necesare.',
      'Compun raspunsul final cu next steps.',
    ],
    intro: 'Perfect, ma ocup acum.',
    todoItems: [
      'Clarifica intentia mesajului.',
      'Ruleaza instrumentele potrivite pentru context.',
      'Livreaza un raspuns concis cu urmatorii pasi.',
    ],
    toolCalls: [
      {
        title: 'Terminal',
        command: 'planner.run --mode quick',
        outputLines: [
          '[info] Building execution plan...',
          '[ok] Plan ready.',
        ],
        lineDelay: 280,
      },
    ],
    agents: [
      {
        name: 'Assistant Agent',
        task: 'Coordinate tools and produce final response',
        steps: [
          { text: 'Understanding request context...', state: 'thinking', delay: 520 },
          { text: 'Executing workflow plan...', state: 'working', delay: 700 },
          { text: 'Preparing final response...', state: 'working', delay: 640 },
        ],
        summary: 'Workflow complete',
      },
    ],
  };
}
