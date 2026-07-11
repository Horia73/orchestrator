#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import zlib from "node:zlib"

const BUILD_ROOT = path.join(process.cwd(), ".next", "server", "app")
const BUDGETS = {
  "/page": 450 * 1024,
  "/settings/page": 150 * 1024,
  "/inbox/page": 420 * 1024,
}

if (!fs.existsSync(BUILD_ROOT)) {
  console.error("Missing .next production build. Run `npm run build` first.")
  process.exit(1)
}

const manifests = collectFiles(BUILD_ROOT, (name) =>
  name.endsWith("_client-reference-manifest.js")
)
const routeManifests = new Map()

for (const manifestPath of manifests) {
  const sandbox = { globalThis: {} }
  vm.runInNewContext(fs.readFileSync(manifestPath, "utf8"), sandbox, {
    filename: manifestPath,
  })
  for (const [route, manifest] of Object.entries(
    sandbox.globalThis.__RSC_MANIFEST ?? {}
  )) {
    routeManifests.set(route, manifest)
  }
}

let failed = false
for (const [route, budget] of Object.entries(BUDGETS)) {
  const manifest = routeManifests.get(route)
  if (!manifest) {
    console.error(`✗ ${route}: client reference manifest not found`)
    failed = true
    continue
  }

  const chunks = new Set(Object.values(manifest.entryJSFiles ?? {}).flat())
  let gzipBytes = 0
  for (const chunk of chunks) {
    const chunkPath = path.join(process.cwd(), ".next", chunk)
    if (!fs.existsSync(chunkPath)) {
      console.error(`✗ ${route}: missing client chunk ${chunk}`)
      failed = true
      continue
    }
    gzipBytes += zlib.gzipSync(fs.readFileSync(chunkPath)).byteLength
  }

  const ok = gzipBytes <= budget
  console.log(
    `${ok ? "✓" : "✗"} ${route}: ${formatKb(gzipBytes)} gzip ` +
      `(budget ${formatKb(budget)})`
  )
  failed ||= !ok
}

process.exit(failed ? 1 : 0)

function collectFiles(root, matches) {
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(entryPath, matches))
    else if (matches(entry.name)) files.push(entryPath)
  }
  return files
}

function formatKb(bytes) {
  return `${Math.round(bytes / 1024)} KB`
}
