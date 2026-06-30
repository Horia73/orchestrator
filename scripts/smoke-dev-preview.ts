import assert from "node:assert/strict"

import { parseDevPreviewArtifact, devPreviewLocalSrc } from "@/lib/dev-preview/schema"
import { SELF_DEVELOPMENT_DOCTRINE } from "@/lib/integrations/doctrines/self-development"
import { PROJECT_DEVELOPMENT_DOCTRINE } from "@/lib/integrations/doctrines/project-development"
import { APP_GUIDE_DOCTRINE } from "@/lib/integrations/doctrines/app-guide"

// ── Parser: valid bodies ──────────────────────────────────────────────────
const valid = parseDevPreviewArtifact(
  JSON.stringify({
    runId: "new-demo-20260618",
    basePath: "/dev-preview/new-demo-20260618",
    token: "tok_abc",
    publicUrl: "https://host/dev-preview/new-demo-20260618/?preview_token=tok_abc",
    lanUrl: "http://192.168.1.10:3000/dev-preview/new-demo-20260618/?preview_token=tok_abc",
    title: "Demo site",
  })
)
assert.ok(valid.ok, "valid body should parse")
if (valid.ok) {
  assert.equal(valid.value.runId, "new-demo-20260618")
  assert.equal(valid.value.basePath, "/dev-preview/new-demo-20260618")
  assert.equal(valid.value.token, "tok_abc")
  assert.equal(valid.value.lanUrl, "http://192.168.1.10:3000/dev-preview/new-demo-20260618/?preview_token=tok_abc")
  assert.equal(valid.value.title, "Demo site")
}

// Trailing slash on basePath is normalized off.
const trailing = parseDevPreviewArtifact(
  JSON.stringify({ runId: "r1", basePath: "/dev-preview/r1/", token: "t" })
)
assert.ok(trailing.ok)
if (trailing.ok) assert.equal(trailing.value.basePath, "/dev-preview/r1")

// ── Parser: rejections ────────────────────────────────────────────────────
assert.equal(parseDevPreviewArtifact("not json").ok, false, "non-JSON rejected")
assert.equal(parseDevPreviewArtifact("[]").ok, false, "non-object rejected")
assert.equal(
  parseDevPreviewArtifact(JSON.stringify({ basePath: "/dev-preview/r1", token: "t" })).ok,
  false,
  "missing runId rejected"
)
assert.equal(
  parseDevPreviewArtifact(JSON.stringify({ runId: "r1", basePath: "/elsewhere/r1", token: "t" })).ok,
  false,
  "basePath outside /dev-preview rejected"
)
assert.equal(
  parseDevPreviewArtifact(JSON.stringify({ runId: "r1", basePath: "/dev-preview/r1" })).ok,
  false,
  "missing token rejected"
)

// ── Same-origin iframe URL ────────────────────────────────────────────────
assert.equal(
  devPreviewLocalSrc({ basePath: "/dev-preview/r1", token: "a b/c" }),
  "/dev-preview/r1/?preview_token=a%20b%2Fc",
  "iframe src encodes the token and serves under basePath"
)

// ── Prompt contract: doctrine + app-guide advertise the type ──────────────
for (const needle of [
  "application/vnd.ant.dev-preview",
  "lanUrl",
  "live_preview_policy",
]) {
  assert.ok(
    SELF_DEVELOPMENT_DOCTRINE.includes(needle),
    `self-dev doctrine should mention "${needle}"`
  )
}
for (const needle of [
  "project-run:prepare",
  "publish-static",
  "PUBLISHED_BASE_PATH",
  "/published-apps/<slug>",
  "lanUrl",
  "tailscaleFunnelUrl",
]) {
  assert.ok(
    PROJECT_DEVELOPMENT_DOCTRINE.includes(needle),
    `project-dev doctrine should mention "${needle}"`
  )
}
for (const needle of [
  "application/vnd.ant.dev-preview",
  "PREVIEW_BASE_PATH",
  "live_preview_policy",
]) {
  assert.equal(
    PROJECT_DEVELOPMENT_DOCTRINE.includes(needle),
    false,
    `project-dev doctrine should not mention "${needle}"`
  )
}
assert.ok(
  APP_GUIDE_DOCTRINE.includes("application/vnd.ant.dev-preview"),
  "app-guide should document the dev-preview artifact"
)
assert.ok(
  APP_GUIDE_DOCTRINE.includes("lanUrl"),
  "app-guide should document LAN preview links"
)
assert.ok(
  APP_GUIDE_DOCTRINE.includes("/published-apps/<slug>/"),
  "app-guide should document durable published app URLs"
)
assert.ok(
  APP_GUIDE_DOCTRINE.includes("tailscaleFunnelUrl"),
  "app-guide should document Tailscale Funnel published app links"
)

console.log("smoke-dev-preview: OK")
