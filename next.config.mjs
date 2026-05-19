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
}

export default nextConfig
