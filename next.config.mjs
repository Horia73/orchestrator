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
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "orchestrator.lan" }],
        missing: [{ type: "header", key: "x-forwarded-proto", value: "https" }],
        destination: "https://orchestrator.lan/:path*",
        permanent: true,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "orchestrator.lan:3000" }],
        missing: [{ type: "header", key: "x-forwarded-proto", value: "https" }],
        destination: "https://orchestrator.lan/:path*",
        permanent: true,
      },
    ]
  },
}

export default nextConfig
