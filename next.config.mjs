import os from "node:os"

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

const previewBasePath = normalizePreviewBasePath(process.env.ORCHESTRATOR_PREVIEW_BASE_PATH)

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(previewBasePath ? { basePath: previewBasePath, assetPrefix: previewBasePath } : {}),
  // Lets other devices on the network (phone/tablet) load Next's dev resources
  // when `next dev -H 0.0.0.0` is reachable over LAN. Without this Next blocks
  // cross-origin dev requests and the app silently fails to boot on the phone.
  // Auto-probed each dev start (survives DHCP changes) — no hardcoded IPs.
  allowedDevOrigins: devLanOrigins(),
  devIndicators: {
    position: "bottom-right",
  },
  env: {
    NEXT_PUBLIC_ORCHESTRATOR_PREVIEW_BASE_PATH: previewBasePath || "",
  },
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

// Hosts allowed to load Next dev resources from another device on the LAN.
// Probed live so it tracks the current IP/Wi-Fi instead of a pinned value.
function devLanOrigins() {
  if (process.env.NODE_ENV === "production") return []
  const hosts = new Set()

  // Every non-internal IPv4 this machine currently holds (e.g. 192.168.x.y).
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === "IPv4" && !iface.internal) hosts.add(iface.address)
    }
  }

  // Bonjour name — a phone can reach the Mac as `<name>.local`.
  const hostname = os.hostname()
  if (hostname) {
    hosts.add(hostname)
    hosts.add(`${hostname.replace(/\.local\.?$/i, "")}.local`)
  }

  // Explicitly configured LAN IP / public URL host, when present.
  const lanIp = process.env.ORCHESTRATOR_HOST_LAN_IP?.trim()
  if (lanIp) hosts.add(lanIp)
  const publicUrl = process.env.ORCHESTRATOR_PUBLIC_URL?.trim()
  if (publicUrl) {
    try {
      hosts.add(new URL(publicUrl).hostname)
    } catch {
      // Ignore a malformed ORCHESTRATOR_PUBLIC_URL — the rest still applies.
    }
  }

  return [...hosts].filter(Boolean)
}

function normalizePreviewBasePath(value) {
  if (!value) return null
  const clean = String(value).trim().replace(/\/+$/, '')
  if (!clean) return null
  if (!/^\/dev-preview\/[A-Za-z0-9._~-]+$/.test(clean)) {
    throw new Error(`Invalid ORCHESTRATOR_PREVIEW_BASE_PATH: ${value}`)
  }
  return clean
}
