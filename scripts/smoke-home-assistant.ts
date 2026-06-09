/**
 * Smoke tests for Home Assistant integration edge cases.
 *
 * Run: npx tsx scripts/smoke-home-assistant.ts
 */
import fs from "fs"
import os from "os"
import path from "path"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "home-assistant-smoke-"))
const originalFetch = globalThis.fetch
const originalStateDir = process.env.ORCHESTRATOR_STATE_DIR
const originalUrl = process.env.HOME_ASSISTANT_URL
const originalToken = process.env.HOME_ASSISTANT_TOKEN

let failures = 0

function check(label: string, condition: unknown, detail?: unknown) {
  const ok = Boolean(condition)
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok ? "" : ` (${JSON.stringify(detail)})`}`
  )
  if (!ok) failures += 1
}

try {
  process.env.ORCHESTRATOR_STATE_DIR = tmpRoot
  process.env.HOME_ASSISTANT_URL = "http://homeassistant.local:8123"
  process.env.HOME_ASSISTANT_TOKEN = "smoke-token"

  const { homeAssistantErrorLog } =
    await import("@/lib/integrations/home-assistant")

  const requestedUrls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input))
    return new Response("first line\nsecond line\n", { status: 200 })
  }) as typeof fetch

  const ok = await homeAssistantErrorLog(10_000)
  check("error log success marks endpoint available", ok.available === true, ok)
  check("error log success returns text", ok.text.includes("second line"), ok)
  check(
    "error log uses documented endpoint",
    requestedUrls[0]?.endsWith("/api/error_log"),
    requestedUrls
  )

  globalThis.fetch = (async () =>
    new Response("404: Not Found", {
      status: 404,
      statusText: "Not Found",
    })) as typeof fetch

  const missing = await homeAssistantErrorLog()
  check(
    "error log 404 is non-throwing unavailable result",
    missing.available === false,
    missing
  )
  check(
    "error log 404 explains other HA tools can still work",
    missing.message?.includes("Other Home Assistant API tools can still work"),
    missing
  )
} finally {
  globalThis.fetch = originalFetch
  if (originalStateDir === undefined) delete process.env.ORCHESTRATOR_STATE_DIR
  else process.env.ORCHESTRATOR_STATE_DIR = originalStateDir
  if (originalUrl === undefined) delete process.env.HOME_ASSISTANT_URL
  else process.env.HOME_ASSISTANT_URL = originalUrl
  if (originalToken === undefined) delete process.env.HOME_ASSISTANT_TOKEN
  else process.env.HOME_ASSISTANT_TOKEN = originalToken
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

if (failures > 0) {
  process.exitCode = 1
}
