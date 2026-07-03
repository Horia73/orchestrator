import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local Orchestrator runtime state and self-dev worktrees are not app code.
    ".orchestrator/**",
    ".orchestrator/private/**",
    // Local agent state and checkout worktrees (each contains a full repo copy
    // with its own .next build output — linting them multiplies every problem).
    ".claude/**",
    // Local run artifacts (screenshots, traces) — not app code.
    "output/**",
    // Bundled third-party worker file (minified vendor asset).
    "public/pdf.worker.min.mjs",
    // Vendored agent skills (earthtojake/text-to-cad) — not app code; the
    // snapshot runtime ships a minified three.js bundle.
    "skills/**",
  ]),
  {
    rules: {
      // react-hooks v7 promotes this React Compiler rule to an error; the
      // codebase has ~160 pre-existing sync-setState-in-effect sites. Keep it
      // visible as a warning while they are burned down incrementally — new
      // compiler rules with zero violations (refs, preserve-manual-memoization)
      // stay at error severity.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
