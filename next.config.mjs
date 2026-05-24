const localTraceExcludes = [
  ".orchestrator/**",
  ".next/**",
  ".git/**",
  "data.db*",
  "docs/**",
  "scripts/**",
  "*.png",
  "*.tsbuildinfo",
  "next.config.mjs",
  "README.md",
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native modules that ship .node binaries — keep them out of the bundler so
  // the runtime loads them via require(), not via webpack/turbopack inlining.
  serverExternalPackages: [
    "better-sqlite3",
    "node-pty",
    "whatsapp-web.js",
    "puppeteer",
    "patchright",
    "patchright-core",
    "playwright-core",
  ],
  // Runtime state and local project files are not deployable server assets.
  // Some agent tools intentionally touch dynamic workspace paths at runtime;
  // without these excludes Turbopack's file tracer can conservatively pull the
  // whole checkout, including private `.orchestrator` browser profiles.
  outputFileTracingExcludes: {
    "/*": localTraceExcludes,
    instrumentation: localTraceExcludes,
    "next-server": localTraceExcludes,
  },
  turbopack: {
    ignoreIssue: [
      {
        path: "next.config.mjs",
        title: "Encountered unexpected file in NFT list",
      },
    ],
  },
}

export default nextConfig
