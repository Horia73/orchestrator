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
    ".orchestrator/private/**",
    // Bundled third-party worker file (minified vendor asset).
    "public/pdf.worker.min.mjs",
    // Vendored agent skills (earthtojake/text-to-cad) — not app code; the
    // snapshot runtime ships a minified three.js bundle.
    "skills/**",
  ]),
]);

export default eslintConfig;
