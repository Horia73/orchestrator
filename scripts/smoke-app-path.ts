import assert from "node:assert/strict"

import {
  appApiPath,
  appPath,
  currentPreviewBasePath,
  prefixWithPreviewBasePath,
} from "@/lib/app-path"
import { normalizeWorkspacePath } from "@/lib/workspace-files-resolve"
import {
  isWorkspaceRuntimePath,
  workspaceRelativePathFromRuntimePath,
} from "@/lib/workspace-runtime-path"

const originalPreviewBasePath = process.env.ORCHESTRATOR_PREVIEW_BASE_PATH
const globals = globalThis as Record<string, unknown>
const originalWindow = globals.window

function setBrowserPath(pathname: string, globalBasePath?: string): void {
  globals.window = {
    location: { pathname },
    ...(globalBasePath
      ? { __orchestratorPreviewBasePathPatched: globalBasePath }
      : {}),
  }
}

function clearBrowserPath(): void {
  if (originalWindow === undefined) delete globals.window
  else globals.window = originalWindow
}

try {
  delete process.env.ORCHESTRATOR_PREVIEW_BASE_PATH
  clearBrowserPath()

  assert.equal(appPath("/api/workspace/files?path=a.png"), "/api/workspace/files?path=a.png")
  assert.equal(appPath("//cdn.example.com/a.png"), "//cdn.example.com/a.png")
  assert.equal(appPath("workspace/file.png"), "workspace/file.png")
  assert.equal(appPath("https://example.com/a.png"), "https://example.com/a.png")

  const legacyWorkspacePath =
    "/app/.orchestrator/workspace/files/reports/summary.docx"
  const profileWorkspacePath =
    "/app/.orchestrator/profiles/iulius/workspace/files/migrare_oblio/Lista_fisiere_WinMentor_pentru_test_Oblio.docx"
  assert.equal(isWorkspaceRuntimePath(legacyWorkspacePath), true)
  assert.equal(isWorkspaceRuntimePath(profileWorkspacePath), true)
  assert.equal(
    workspaceRelativePathFromRuntimePath(profileWorkspacePath),
    "files/migrare_oblio/Lista_fisiere_WinMentor_pentru_test_Oblio.docx"
  )
  assert.equal(
    workspaceRelativePathFromRuntimePath(
      "C:\\app\\.orchestrator\\profiles\\iulius\\workspace\\files\\report.pdf"
    ),
    "files/report.pdf"
  )
  assert.equal(
    isWorkspaceRuntimePath(
      "/app/.orchestrator/profiles/iulius/not-workspace/files/report.pdf"
    ),
    false
  )
  assert.equal(
    normalizeWorkspacePath(profileWorkspacePath),
    "files/migrare_oblio/Lista_fisiere_WinMentor_pentru_test_Oblio.docx"
  )

  process.env.ORCHESTRATOR_PREVIEW_BASE_PATH = "/dev-preview/self-123/"
  assert.equal(currentPreviewBasePath(), "/dev-preview/self-123")
  assert.equal(
    appPath("/api/workspace/files?path=a.png"),
    "/dev-preview/self-123/api/workspace/files?path=a.png"
  )
  assert.equal(
    appPath("/dev-preview/self-123/api/workspace/files?path=a.png"),
    "/dev-preview/self-123/api/workspace/files?path=a.png"
  )
  assert.equal(
    appApiPath("/api/workspace/files", { path: "tarom boarding pass.png" }),
    "/dev-preview/self-123/api/workspace/files?path=tarom+boarding+pass.png"
  )
  assert.equal(
    appPath("/files/email%20previews/variant-1.html"),
    "/dev-preview/self-123/files/email%20previews/variant-1.html"
  )

  assert.equal(
    prefixWithPreviewBasePath("/api/uploads/file.png", "/dev-preview/manual/"),
    "/dev-preview/manual/api/uploads/file.png"
  )

  setBrowserPath("/dev-preview/browser-run/monitor")
  process.env.ORCHESTRATOR_PREVIEW_BASE_PATH = "/dev-preview/env-run"
  assert.equal(currentPreviewBasePath(), "/dev-preview/browser-run")
  assert.equal(
    appPath("/api/uploads/file.png"),
    "/dev-preview/browser-run/api/uploads/file.png"
  )

  setBrowserPath("/monitor", "/dev-preview/global-run")
  assert.equal(currentPreviewBasePath(), "/dev-preview/global-run")
  assert.equal(
    appPath("/api/uploads/file.png"),
    "/dev-preview/global-run/api/uploads/file.png"
  )
  assert.equal(
    appPath("/files/nectaria-email-previews/variant-1.html"),
    "/dev-preview/global-run/files/nectaria-email-previews/variant-1.html"
  )

  console.log("app path smoke ok")
} finally {
  if (originalPreviewBasePath === undefined) {
    delete process.env.ORCHESTRATOR_PREVIEW_BASE_PATH
  } else {
    process.env.ORCHESTRATOR_PREVIEW_BASE_PATH = originalPreviewBasePath
  }
  clearBrowserPath()
}
