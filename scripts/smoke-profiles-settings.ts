import fs from "fs"
import os from "os"
import path from "path"

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-profiles-settings-"))
process.env.ORCHESTRATOR_STATE_DIR = stateDir

let failures = 0

function check(label: string, condition: unknown, detail?: unknown) {
  const ok = Boolean(condition)
  console.log(`${ok ? "ok" : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`)
  if (!ok) failures += 1
}

const { runWithProfileContext } = await import("@/lib/profiles/context")
const {
  createProfile,
  updateProfile,
  getProfile,
} = await import("@/lib/profiles/store")
const {
  ADMIN_PROFILE_ID,
} = await import("@/lib/profiles/constants")
const {
  defaultMemberPermissions,
} = await import("@/lib/profiles/types")
const {
  resolveAppOrigin,
  resolveOAuthRedirectUri,
} = await import("@/lib/app-origin")
const {
  getConfig,
  getEnvValue,
  getEffectiveBrowserAgentSettings,
  getEffectiveAgentSettings,
  setAgentOverride,
  setBrowserAgentModel,
  updateConfig,
} = await import("@/lib/config")
const { runtimePathsForProfile } = await import("@/lib/runtime-paths")
const {
  closeDatabaseForProfile,
  getDatabaseForProfile,
} = await import("@/lib/db")
const {
  getWorkspaceFile,
  listWorkspaceFiles,
  revealWorkspaceEnvValue,
  writeWorkspaceFile,
} = await import("@/lib/settings/workspace-files")
const { executeSetEnv } = await import("@/lib/ai/tools/set-env")
const { saveGmailOAuthConfig } = await import("@/lib/integrations/gmail")

const defaultPermissions = defaultMemberPermissions()
check("member Settings surface defaults on", defaultPermissions.surfaces.settings === true)
check("member model self-service defaults off", defaultPermissions.tools.models === false)
check("member settings files default off", defaultPermissions.tools.settings_files === false)
for (const integration of [
  "gmail",
  "google_calendar",
  "google_drive",
  "whatsapp",
  "home_assistant",
  "maps",
] as const) {
  check(
    `member ${integration} integration setup defaults on`,
    defaultPermissions.integrations[integration] === "setup",
    defaultPermissions.integrations[integration]
  )
}
check("member weather integration read default stays on", defaultPermissions.integrations.weather === "read")

const normalMember = createProfile({
  name: "Normal Member",
  permissions: defaultPermissions,
})

const inheritedEnvMember = createProfile({
  name: "Inherited Env",
  permissions: defaultMemberPermissions(),
})

const isolatedEnvPermissions = defaultMemberPermissions()
isolatedEnvPermissions.inheritAdminApiKeys = false
const isolatedEnvMember = createProfile({
  name: "Isolated Env",
  permissions: isolatedEnvPermissions,
})

const selfServicePermissions = defaultMemberPermissions()
selfServicePermissions.tools.models = true
const selfServiceMember = createProfile({
  name: "Self Service",
  permissions: selfServicePermissions,
})

getDatabaseForProfile(normalMember.id)
check(
  "profile database connection closes before state deletion",
  closeDatabaseForProfile(normalMember.id) === true
)
check(
  "closed profile database connection is forgotten",
  closeDatabaseForProfile(normalMember.id) === false
)

await runWithProfileContext(
  { profileId: selfServiceMember.id, role: "member" },
  () => {
    setAgentOverride("orchestrator", {
      provider: "google",
      model: "gemini-3.1-pro-preview",
      thinkingLevel: "high",
    })
    setAgentOverride("researcher", {
      provider: "google",
      model: "gemini-3.1-pro-preview",
      thinkingLevel: "high",
    })
    setBrowserAgentModel("light", {
      provider: "google",
      model: "gemini-3.1-pro-preview",
      thinkingLevel: "high",
    })
  }
)

await runWithProfileContext(
  { profileId: normalMember.id, role: "member" },
  () => {
    const current = getConfig()
    updateConfig({
      agentOverrides: {
        orchestrator: {
          provider: "google",
          model: "gemini-3.1-pro-preview",
          thinkingLevel: "high",
        },
        researcher: {
          provider: "google",
          model: "gemini-3.1-pro-preview",
          thinkingLevel: "high",
        },
      },
      browserAgent: {
        ...current.browserAgent,
        light: {
          provider: "google",
          model: "gemini-3.1-pro-preview",
          thinkingLevel: "high",
        },
      },
    })
  }
)

await runWithProfileContext(
  { profileId: ADMIN_PROFILE_ID, role: "admin" },
  () => {
    setAgentOverride("orchestrator", {
      provider: "google",
      model: "gemini-3-flash-preview",
      thinkingLevel: "low",
    })
    setAgentOverride("researcher", {
      provider: "google",
      model: "gemini-3-flash-preview",
      thinkingLevel: "low",
    })
    setBrowserAgentModel("light", {
      provider: "google",
      model: "gemini-3-flash-preview",
      thinkingLevel: "low",
    })
  }
)

const adminConfig = await runWithProfileContext(
  { profileId: ADMIN_PROFILE_ID, role: "admin" },
  () => getConfig()
)
const normalConfig = await runWithProfileContext(
  { profileId: normalMember.id, role: "member" },
  () => getConfig()
)
const selfServiceConfig = await runWithProfileContext(
  { profileId: selfServiceMember.id, role: "member" },
  () => getConfig()
)

check(
  "admin orchestrator override persisted",
  adminConfig.agentOverrides.orchestrator?.model === "gemini-3-flash-preview"
)
check(
  "admin propagates orchestrator override to non-self-service member",
  normalConfig.agentOverrides.orchestrator?.model === "gemini-3-flash-preview",
  normalConfig.agentOverrides.orchestrator
)
check(
  "admin propagates non-orchestrator override to non-self-service member",
  normalConfig.agentOverrides.researcher?.model === "gemini-3-flash-preview",
  normalConfig.agentOverrides.researcher
)
check(
  "admin propagates browser agent model to non-self-service member",
  normalConfig.browserAgent.light.model === "gemini-3-flash-preview",
  normalConfig.browserAgent.light
)
check(
  "admin does not overwrite self-service member orchestrator override",
  selfServiceConfig.agentOverrides.orchestrator?.model === "gemini-3.1-pro-preview",
  selfServiceConfig.agentOverrides.orchestrator
)
check(
  "admin does not overwrite self-service member non-orchestrator override",
  selfServiceConfig.agentOverrides.researcher?.model === "gemini-3.1-pro-preview",
  selfServiceConfig.agentOverrides.researcher
)
check(
  "admin does not overwrite self-service member browser agent model",
  selfServiceConfig.browserAgent.light.model === "gemini-3.1-pro-preview",
  selfServiceConfig.browserAgent.light
)

const originalSharedProcessEnv = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ORCHESTRATOR_PUBLIC_URL: process.env.ORCHESTRATOR_PUBLIC_URL,
  GMAIL_OAUTH_REDIRECT_URI: process.env.GMAIL_OAUTH_REDIRECT_URI,
}
delete process.env.RESEND_API_KEY
delete process.env.ORCHESTRATOR_PUBLIC_URL
delete process.env.GMAIL_OAUTH_REDIRECT_URI
const adminEnvPath = runtimePathsForProfile(ADMIN_PROFILE_ID).workspaceEnvPath
const inheritedMemberEnvPath = runtimePathsForProfile(inheritedEnvMember.id).workspaceEnvPath
fs.mkdirSync(path.dirname(adminEnvPath), { recursive: true })
fs.writeFileSync(
  adminEnvPath,
  [
    "RESEND_API_KEY=admin-resend-smoke",
    "OPENAI_API_KEY=admin-openai-smoke",
    "ORCHESTRATOR_PUBLIC_URL=https://admin.example.com",
    "GMAIL_OAUTH_REDIRECT_URI=https://admin.example.com/api/integrations/gmail/oauth/callback",
    "",
  ].join("\n"),
  "utf-8"
)
fs.mkdirSync(path.dirname(inheritedMemberEnvPath), { recursive: true })
fs.writeFileSync(
  inheritedMemberEnvPath,
  [
    "RESEND_API_KEY=member-resend-must-be-ignored",
    "MEMBER_ONLY_ENV=must-not-be-visible-while-shared",
    "ORCHESTRATOR_PUBLIC_URL=http://member.lan",
    "GMAIL_OAUTH_REDIRECT_URI=http://localhost:3000/api/integrations/gmail/oauth/callback",
    "",
  ].join("\n"),
  "utf-8"
)
const inheritedEnvValue = await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => getEnvValue("RESEND_API_KEY")
)
const isolatedEnvValue = await runWithProfileContext(
  { profileId: isolatedEnvMember.id, role: "member" },
  () => getEnvValue("RESEND_API_KEY")
)
const inheritedEnvSummary = await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => listWorkspaceFiles().find((file) => file.id === "env-local")
)
const inheritedEnvFile = await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => getWorkspaceFile("env-local")
)
const inheritedAppOrigin = await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => resolveAppOrigin("http://member.lan")
)
const inheritedGmailRedirect = await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () =>
    resolveOAuthRedirectUri(
      getEnvValue("GMAIL_OAUTH_REDIRECT_URI"),
      inheritedAppOrigin,
      "/api/integrations/gmail/oauth/callback"
    )
)
const sharedSetEnvResult = await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => executeSetEnv({ key: "SHARED_WRITE_SMOKE", value: "blocked" })
)
let sharedGmailConfigBlocked = false
await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  async () => {
    try {
      await saveGmailOAuthConfig(inheritedAppOrigin, {
        clientId: "shared-write-smoke.apps.googleusercontent.com",
        clientSecret: "shared-write-smoke-secret",
      })
    } catch (error) {
      sharedGmailConfigBlocked =
        error instanceof Error && error.message.includes("uses the admin environment")
    }
  }
)
let sharedSettingsWriteBlocked = false
await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => {
    try {
      writeWorkspaceFile("env-local", "SHARED_WRITE_SMOKE=blocked\n")
    } catch {
      sharedSettingsWriteBlocked = true
    }
  }
)
delete process.env.ISOLATED_WRITE_SMOKE
const isolatedSetEnvResult = await runWithProfileContext(
  { profileId: isolatedEnvMember.id, role: "member" },
  () => executeSetEnv({ key: "ISOLATED_WRITE_SMOKE", value: "profile-only" })
)
const isolatedSetEnvValue = await runWithProfileContext(
  { profileId: isolatedEnvMember.id, role: "member" },
  () => getEnvValue("ISOLATED_WRITE_SMOKE")
)
const adminSawIsolatedSetEnv = await runWithProfileContext(
  { profileId: ADMIN_PROFILE_ID, role: "admin" },
  () => getEnvValue("ISOLATED_WRITE_SMOKE")
)
let sharedRevealBlocked = false
await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => {
    try {
      revealWorkspaceEnvValue("env-local", "RESEND_API_KEY")
    } catch {
      sharedRevealBlocked = true
    }
  }
)

check(
  "shared member ignores its own env and uses admin env",
  inheritedEnvValue === "admin-resend-smoke",
  inheritedEnvValue
)
check(
  "member without inherit does not read admin workspace env API keys",
  isolatedEnvValue === null,
  isolatedEnvValue
)
check(
  "inherited env file is visible read-only",
  inheritedEnvSummary?.exists === true &&
    inheritedEnvSummary.readOnly === true &&
    inheritedEnvSummary.inherited === true,
  inheritedEnvSummary
)
check(
  "inherited env file redacts inherited API keys",
  inheritedEnvFile?.content.includes("RESEND_API_KEY=__ORCHESTRATOR_SECRET_SET__") === true &&
    inheritedEnvFile.contentRedacted === true &&
    !inheritedEnvFile.content.includes("MEMBER_ONLY_ENV"),
  inheritedEnvFile
)
check(
  "shared member receives admin public URL",
  inheritedAppOrigin === "https://admin.example.com",
  inheritedAppOrigin
)
check(
  "shared member receives admin Gmail OAuth redirect URL",
  inheritedGmailRedirect ===
    "https://admin.example.com/api/integrations/gmail/oauth/callback",
  inheritedGmailRedirect
)
check(
  "SetEnv rejects writes while admin environment is shared",
  sharedSetEnvResult.success === false &&
    sharedSetEnvResult.error?.includes("uses the admin environment"),
  sharedSetEnvResult
)
check(
  "Settings rejects env writes while admin environment is shared",
  sharedSettingsWriteBlocked
)
check(
  "Gmail config rejects env writes while admin environment is shared",
  sharedGmailConfigBlocked
)
check(
  "member cannot reveal shared admin env values",
  sharedRevealBlocked
)
check(
  "isolated profile env writes stay profile-local",
  isolatedSetEnvResult.success === true &&
    isolatedSetEnvValue === "profile-only" &&
    process.env.ISOLATED_WRITE_SMOKE === undefined &&
    adminSawIsolatedSetEnv === null,
  { isolatedSetEnvResult, isolatedSetEnvValue, adminSawIsolatedSetEnv }
)

const sharingDisabled = updateProfile(inheritedEnvMember.id, {
  permissions: {
    ...inheritedEnvMember.permissions,
    inheritAdminApiKeys: false,
  },
})
const ownEnvAfterDisable = await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => getEnvValue("RESEND_API_KEY")
)
const sharingEnabledAgain = updateProfile(inheritedEnvMember.id, {
  permissions: {
    ...(sharingDisabled?.permissions ?? inheritedEnvMember.permissions),
    inheritAdminApiKeys: true,
  },
})
const adminEnvAfterEnable = await runWithProfileContext(
  { profileId: inheritedEnvMember.id, role: "member" },
  () => getEnvValue("RESEND_API_KEY")
)
check(
  "turning sharing off immediately restores the profile env",
  ownEnvAfterDisable === "member-resend-must-be-ignored",
  ownEnvAfterDisable
)
check(
  "turning sharing on immediately restores the admin env",
  sharingEnabledAgain?.permissions.allowedProviderApiKeys.join(",") === "*" &&
    adminEnvAfterEnable === "admin-resend-smoke",
  { permissions: sharingEnabledAgain?.permissions, adminEnvAfterEnable }
)

for (const [key, value] of Object.entries(originalSharedProcessEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const normalEffective = await runWithProfileContext(
  { profileId: normalMember.id, role: "member" },
  () => getEffectiveAgentSettings("orchestrator")
)
const selfServiceEffective = await runWithProfileContext(
  { profileId: selfServiceMember.id, role: "member" },
  () => getEffectiveAgentSettings("orchestrator")
)
const normalResearcherEffective = await runWithProfileContext(
  { profileId: normalMember.id, role: "member" },
  () => getEffectiveAgentSettings("researcher")
)
const selfServiceResearcherEffective = await runWithProfileContext(
  { profileId: selfServiceMember.id, role: "member" },
  () => getEffectiveAgentSettings("researcher")
)
const normalBrowserEffective = await runWithProfileContext(
  { profileId: normalMember.id, role: "member" },
  () => getEffectiveBrowserAgentSettings()
)
const selfServiceBrowserEffective = await runWithProfileContext(
  { profileId: selfServiceMember.id, role: "member" },
  () => getEffectiveBrowserAgentSettings()
)

check(
  "member without model permission follows admin effective orchestrator model",
  normalEffective.model === "gemini-3-flash-preview",
  normalEffective
)
check(
  "member with model permission keeps own effective orchestrator model",
  selfServiceEffective.model === "gemini-3.1-pro-preview",
  selfServiceEffective
)
check(
  "member without model permission follows admin effective non-orchestrator model",
  normalResearcherEffective.model === "gemini-3-flash-preview",
  normalResearcherEffective
)
check(
  "member with model permission keeps own effective non-orchestrator model",
  selfServiceResearcherEffective.model === "gemini-3.1-pro-preview",
  selfServiceResearcherEffective
)
check(
  "member without model permission follows admin effective browser agent model",
  normalBrowserEffective.light.model === "gemini-3-flash-preview",
  normalBrowserEffective.light
)
check(
  "member with model permission keeps own effective browser agent model",
  selfServiceBrowserEffective.light.model === "gemini-3.1-pro-preview",
  selfServiceBrowserEffective.light
)

const restored = updateProfile(normalMember.id, {
  permissions: {
    ...normalMember.permissions,
    surfaces: { ...normalMember.permissions.surfaces, settings: false },
  },
})
check("settings surface can still be explicitly disabled", restored?.permissions.surfaces.settings === false)
check("profile lookup stays isolated", getProfile(selfServiceMember.id)?.id === selfServiceMember.id)

console.log(`\n${failures === 0 ? "profiles/settings smoke passed" : `${failures} profiles/settings smoke failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
