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
    ensureWhatsAppConnectionForProfile,
    grantIntegrationConnection,
    getPreferredIntegrationConnectionId,
    listIntegrationConnections,
    listAccessibleIntegrationConnections,
    resolveIntegrationConnectionForProfile,
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
    const grant = grantIntegrationConnection({
      connectionId: migrated.connection?.id ?? "",
      profileId: member.id,
      access: "read",
      actorProfileId: ADMIN_PROFILE_ID,
    })
    check(
      "Gmail connections can be granted across profiles",
      grant.connectionId === migrated.connection?.id && grant.profileId === member.id,
      grant
    )
    const accessible = listAccessibleIntegrationConnections(member.id, "gmail")
    check(
      "member sees granted admin Gmail account as shared",
      accessible.length === 1 &&
        accessible[0]?.source === "shared" &&
        accessible[0]?.access === "read",
      accessible
    )
    check(
      "shared Gmail grant is not selected by default",
      resolveIntegrationConnectionForProfile(member.id, "gmail") === null
    )
    setPreferredIntegrationConnection({
      profileId: member.id,
      provider: "gmail",
      connectionId: migrated.connection?.id ?? "",
      actorProfileId: ADMIN_PROFILE_ID,
    })
    const memberResolved = await runWithProfileContext(
      { profileId: member.id, role: "member" },
      () =>
        resolveGoogleAccountToken({
          provider: "gmail",
          tokenProvider: "gmail",
          legacyTokenPath: path.join(
            runtimePathsForProfile(member.id).privateStateDir,
            "auth",
            "gmail.json"
          ),
        })
    )
    check(
      "member resolver uses shared Gmail token without copying it",
      memberResolved.token?.accountEmail === "alpha@example.com" &&
        memberResolved.connection?.source === "shared" &&
        memberResolved.tokenPath.includes(runtimePathsForProfile(ADMIN_PROFILE_ID).privateStateDir),
      memberResolved
    )
    const whatsAppConnection = ensureWhatsAppConnectionForProfile(
      ADMIN_PROFILE_ID,
      "Admin WhatsApp"
    )
    const whatsAppGrant = grantIntegrationConnection({
      connectionId: whatsAppConnection.id,
      profileId: member.id,
      access: "write",
      actorProfileId: ADMIN_PROFILE_ID,
    })
    check(
      "WhatsApp connections can be granted across profiles",
      whatsAppGrant.connectionId === whatsAppConnection.id &&
        listAccessibleIntegrationConnections(member.id, "whatsapp")[0]?.source === "shared",
      {
        whatsAppGrant,
        accessible: listAccessibleIntegrationConnections(member.id, "whatsapp"),
      }
    )
    check(
      "shared WhatsApp grant is not selected by default",
      resolveIntegrationConnectionForProfile(member.id, "whatsapp") === null
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
