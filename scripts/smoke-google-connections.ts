import fs from "fs"
import os from "os"
import path from "path"

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-google-connections-"))
process.env.ORCHESTRATOR_STATE_DIR = stateDir

let failures = 0

function check(label: string, condition: unknown, detail?: unknown): void {
  const ok = Boolean(condition)
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` (${JSON.stringify(detail)})`}`)
  if (!ok) failures += 1
}

try {
  const { ADMIN_PROFILE_ID } = await import("@/lib/profiles/constants")
  const { runWithProfileContext } = await import("@/lib/profiles/context")
  const { runtimePathsForProfile } = await import("@/lib/runtime-paths")
  const {
    grantIntegrationConnection,
    getPreferredIntegrationConnectionId,
    listIntegrationConnections,
    listAccessibleIntegrationConnections,
    setPreferredIntegrationConnection,
  } = await import("@/lib/integrations/connection-store")
  const { createProfile } = await import("@/lib/profiles/store")
  const {
    resolveGoogleAccountToken,
    saveGoogleAccountTokenForActiveProfile,
  } = await import("@/lib/integrations/oauth-connections")
  const { writeGoogleOAuthToken } = await import("@/lib/integrations/google-oauth")

  await runWithProfileContext({ profileId: ADMIN_PROFILE_ID, role: "admin" }, async () => {
    const legacyTokenPath = path.join(
      runtimePathsForProfile(ADMIN_PROFILE_ID).privateStateDir,
      "auth",
      "gmail.json"
    )
    writeGoogleOAuthToken(legacyTokenPath, token("alpha@example.com"))

    const migrated = resolveGoogleAccountToken({
      provider: "gmail",
      tokenProvider: "gmail",
      legacyTokenPath,
    })
    check("legacy Gmail token resolves through a connection", migrated.connection?.accountEmail === "alpha@example.com", migrated)
    check("legacy Gmail token is copied to a per-connection path", migrated.tokenPath !== legacyTokenPath, migrated.tokenPath)
    check("legacy Gmail connection becomes preferred", getPreferredIntegrationConnectionId(ADMIN_PROFILE_ID, "gmail") === migrated.connection?.id)

    const second = saveGoogleAccountTokenForActiveProfile({
      provider: "gmail",
      tokenProvider: "gmail",
      legacyTokenPath,
      token: token("beta@example.com"),
    })
    const connections = listIntegrationConnections({ provider: "gmail", ownerProfileId: ADMIN_PROFILE_ID })
    check("second Gmail account creates a second connection", connections.length === 2, connections)
    check("newly connected Gmail account becomes preferred", getPreferredIntegrationConnectionId(ADMIN_PROFILE_ID, "gmail") === second.connectionId)

    const selectedBeta = resolveGoogleAccountToken({
      provider: "gmail",
      tokenProvider: "gmail",
      legacyTokenPath,
    })
    check("resolver uses preferred Gmail account", selectedBeta.token?.accountEmail === "beta@example.com", selectedBeta)

    setPreferredIntegrationConnection({
      profileId: ADMIN_PROFILE_ID,
      provider: "gmail",
      connectionId: migrated.connection?.id ?? "",
      actorProfileId: ADMIN_PROFILE_ID,
    })
    const selectedAlpha = resolveGoogleAccountToken({
      provider: "gmail",
      tokenProvider: "gmail",
      legacyTokenPath,
    })
    check("preference switch changes selected Gmail token", selectedAlpha.token?.accountEmail === "alpha@example.com", selectedAlpha)

    const member = createProfile({ name: "Member" }, ADMIN_PROFILE_ID)
    let grantError = ""
    try {
      grantIntegrationConnection({
        connectionId: migrated.connection?.id ?? "",
        profileId: member.id,
        access: "read",
        actorProfileId: ADMIN_PROFILE_ID,
      })
    } catch (error) {
      grantError = error instanceof Error ? error.message : String(error)
    }
    check(
      "Gmail connections cannot be granted across profiles",
      grantError.includes("cannot be shared across profiles"),
      grantError
    )
    check(
      "member does not see admin Gmail account as accessible",
      listAccessibleIntegrationConnections(member.id, "gmail").length === 0,
      listAccessibleIntegrationConnections(member.id, "gmail")
    )
  })
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`smoke-google-connections failed: ${failures} failure(s)`)
  process.exit(1)
}

console.log("✓ smoke-google-connections passed")

function token(accountEmail: string) {
  return {
    version: 1 as const,
    provider: "gmail",
    clientId: "client",
    accountEmail,
    accessToken: `access-${accountEmail}`,
    refreshToken: `refresh-${accountEmail}`,
    tokenType: "Bearer",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    scopesRequested: ["https://www.googleapis.com/auth/gmail.readonly"],
    expiresAt: Date.now() + 3_600_000,
    obtainedAt: Date.now(),
    updatedAt: Date.now(),
  }
}
