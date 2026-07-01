import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const originalStateDir = process.env.ORCHESTRATOR_STATE_DIR
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-upload-gc-"))

try {
  process.env.ORCHESTRATOR_STATE_DIR = stateDir

  const uploadsDir = path.join(stateDir, "uploads")
  fs.mkdirSync(uploadsDir, { recursive: true })

  const recentUpload = path.join(
    uploadsDir,
    "00000000-0000-4000-8000-000000000001.png"
  )
  const oldUpload = path.join(
    uploadsDir,
    "00000000-0000-4000-8000-000000000002.png"
  )
  fs.writeFileSync(recentUpload, "recent draft upload")
  fs.writeFileSync(oldUpload, "stale orphan upload")

  const now = Date.now()
  const recentTime = new Date(now - 60_000)
  const oldTime = new Date(now - 8 * 24 * 60 * 60 * 1000)
  fs.utimesSync(recentUpload, recentTime, recentTime)
  fs.utimesSync(oldUpload, oldTime, oldTime)

  await import("@/lib/db")

  assert.equal(
    fs.existsSync(recentUpload),
    true,
    "recent orphan upload should survive startup GC for browser drafts"
  )
  assert.equal(
    fs.existsSync(oldUpload),
    false,
    "old orphan upload should still be collected"
  )

  console.log("upload gc smoke ok")
} finally {
  if (originalStateDir === undefined) delete process.env.ORCHESTRATOR_STATE_DIR
  else process.env.ORCHESTRATOR_STATE_DIR = originalStateDir
  fs.rmSync(stateDir, { recursive: true, force: true })
}
