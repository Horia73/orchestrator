import assert from "node:assert/strict"

import {
  appApiPath,
  appPath,
  currentPreviewBasePath,
  prefixWithPreviewBasePath,
} from "@/lib/app-path"
import {
  extractWorkspaceHtmlPreviewsFromMarkdown,
  workspaceHtmlPreviewFromHref,
} from "@/lib/workspace-html-preview"

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
  assert.deepEqual(
    workspaceHtmlPreviewFromHref("files/email previews/variant-1.html", "Variant 1"),
    {
      id: "files/email previews/variant-1.html",
      title: "Variant 1",
      filePath: "files/email previews/variant-1.html",
      src: "/dev-preview/self-123/files/email%20previews/variant-1.html",
    }
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
  assert.deepEqual(
    extractWorkspaceHtmlPreviewsFromMarkdown([
      "[variant-1.html](/files/nectaria-email-previews/variant-1.html)",
      "[variant-2.html](/api/workspace/files?path=files/nectaria-email-previews/variant-2.html)",
      "https://orchestrator-h7k2.duckdns.org/files/nectaria-email-previews/variant-3.html",
    ].join("\n")),
    [
      {
        id: "files/nectaria-email-previews/variant-1.html",
        title: "variant-1.html",
        filePath: "files/nectaria-email-previews/variant-1.html",
        src: "/dev-preview/global-run/files/nectaria-email-previews/variant-1.html",
      },
      {
        id: "files/nectaria-email-previews/variant-2.html",
        title: "variant-2.html",
        filePath: "files/nectaria-email-previews/variant-2.html",
        src: "/dev-preview/global-run/files/nectaria-email-previews/variant-2.html",
      },
      {
        id: "files/nectaria-email-previews/variant-3.html",
        title: "variant-3.html",
        filePath: "files/nectaria-email-previews/variant-3.html",
        src: "/dev-preview/global-run/files/nectaria-email-previews/variant-3.html",
      },
    ]
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
