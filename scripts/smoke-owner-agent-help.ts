import fs from "fs"
import os from "os"
import path from "path"

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-owner-help-"))
process.env.ORCHESTRATOR_STATE_DIR = stateDir

let failures = 0

function check(label: string, condition: unknown, detail?: unknown) {
  const ok = Boolean(condition)
  console.log(
    `${ok ? "ok" : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`,
  )
  if (!ok) failures += 1
}

const { orchestrator } = await import("@/lib/ai/agents/orchestrator")
const { getToolsForAgent } = await import("@/lib/ai/tools/registry")
const {
  executeCompleteOwnerAgentHelp,
  executeRequestOwnerAgentHelp,
  REQUEST_OWNER_AGENT_HELP_TOOL_ID,
} = await import("@/lib/ai/tools/owner-agent-help")
const {
  getConversation,
  getConversationsWithMessages,
  getDatabaseForProfile,
} = await import("@/lib/db")
const { ADMIN_PROFILE_ID } = await import("@/lib/profiles/constants")
const {
  getActiveProfileId,
  runWithProfileContext,
} = await import("@/lib/profiles/context")
const { getOwnerAgentRequest } = await import(
  "@/lib/profiles/owner-agent-requests"
)
const {
  createProfile,
  listProfileAuditEvents,
} = await import("@/lib/profiles/store")
const { defaultMemberPermissions } = await import("@/lib/profiles/types")

const disabled = createProfile({ name: "Owner Help Disabled" })
const enabledPermissions = defaultMemberPermissions()
enabledPermissions.tools.owner_agent_help = true
const enabled = createProfile({
  name: "Owner Help Enabled",
  permissions: enabledPermissions,
})

const disabledTools = runWithProfileContext(
  { profileId: disabled.id, role: "member" },
  () => getToolsForAgent(orchestrator.tools),
)
const enabledTools = runWithProfileContext(
  { profileId: enabled.id, role: "member" },
  () => getToolsForAgent(orchestrator.tools),
)
const adminTools = runWithProfileContext(
  { profileId: ADMIN_PROFILE_ID, role: "admin" },
  () => getToolsForAgent(orchestrator.tools),
)

check(
  "owner help hidden when member permission is off",
  !disabledTools.some((tool) => tool.id === REQUEST_OWNER_AGENT_HELP_TOOL_ID),
)
check(
  "owner help exposed when member permission is on",
  enabledTools.some((tool) => tool.id === REQUEST_OWNER_AGENT_HELP_TOOL_ID),
)
check(
  "owner help hidden from the admin agent",
  !adminTools.some((tool) => tool.id === REQUEST_OWNER_AGENT_HELP_TOOL_ID),
)

const context = {
  callerAgentId: "orchestrator",
  depth: 0,
  conversationId: "member_conversation",
  parentRequestId: "member_request",
}

const denied = await runWithProfileContext(
  { profileId: disabled.id, role: "member" },
  () =>
    executeRequestOwnerAgentHelp(
      { title: "Need help", request: "Please inspect this safely." },
      context,
      async () => ({ success: true, data: { output: "should not run" } }),
    ),
)
check("disabled member execution is rejected", denied.success === false, denied)

const handled = await runWithProfileContext(
  { profileId: enabled.id, role: "member" },
  () =>
    executeRequestOwnerAgentHelp(
      {
        title: "Routine internal help",
        request: "Answer with the safe result. api_key=member-secret-value",
      },
      context,
      async ({ request, conversationId, threadId }) => {
        check(
          "owner runner executes inside admin profile context",
          getActiveProfileId() === ADMIN_PROFILE_ID,
          getActiveProfileId(),
        )
        check("request is running before owner execution", request.status === "running")
        const wrongThread = await executeCompleteOwnerAgentHelp(
          {
            request_id: request.id,
            status: "handled",
            response: "This must not cross from another thread.",
          },
          {
            callerAgentId: "orchestrator",
            depth: 1,
            conversationId,
            agentThreadId: "ath_wrong_thread",
            parentRequestId: request.id,
          },
        )
        check(
          "completion is bound to the exact owner thread",
          wrongThread.success === false,
          wrongThread,
        )
        return executeCompleteOwnerAgentHelp(
          {
            request_id: request.id,
            status: "handled",
            response: "Handled safely. access_token=owner-secret-value",
          },
          {
            callerAgentId: "orchestrator",
            depth: 1,
            conversationId,
            agentThreadId: threadId,
            parentRequestId: request.id,
          },
        )
      },
    ),
)
const handledData = handled.data as Record<string, unknown>
const handledId = String(handledData.request_id ?? "")
const handledRequest = getOwnerAgentRequest(handledId)
check("owner help returns a handled result", handled.success && handledData.status === "handled", handled)
check(
  "request and response secrets are redacted",
  handledRequest?.request.includes("member-secret-value") === false &&
    handledRequest?.response?.includes("owner-secret-value") === false,
  handledRequest,
)
check(
  "terminal owner request is persisted",
  handledRequest?.status === "handled" && Boolean(handledRequest.ownerAgentThreadId),
  handledRequest,
)

const internalRow = runWithProfileContext(
  { profileId: ADMIN_PROFILE_ID, role: "admin" },
  () =>
    getDatabaseForProfile(ADMIN_PROFILE_ID)
      .prepare(`SELECT origin FROM conversations WHERE id = ?`)
      .get(handledRequest?.ownerConversationId) as { origin: string } | undefined,
)
const adminRecents = runWithProfileContext(
  { profileId: ADMIN_PROFILE_ID, role: "admin" },
  () => getConversationsWithMessages(),
)
check("owner request conversation uses hidden origin", internalRow?.origin === "owner-agent-help", internalRow)
check(
  "owner request conversation stays out of normal chats",
  !adminRecents.some((conversation) => conversation.id === handledRequest?.ownerConversationId),
)

const unguarded = await runWithProfileContext(
  { profileId: enabled.id, role: "member" },
  () =>
    executeRequestOwnerAgentHelp(
      {
        title: "Guarded completion required",
        request: "Do not let arbitrary model output cross profiles.",
      },
      { ...context, conversationId: "member_conversation_guard" },
      async () => ({
        success: true,
        data: { output: "owner-private output that must stay internal" },
      }),
    ),
)
check(
  "unvalidated model output fails closed instead of crossing profiles",
  unguarded.success === false &&
    !JSON.stringify(unguarded).includes("owner-private output"),
  unguarded,
)

const escalated = await runWithProfileContext(
  { profileId: enabled.id, role: "member" },
  () =>
    executeRequestOwnerAgentHelp(
      {
        title: "Approval boundary",
        request: "This requires fresh human approval.",
      },
      { ...context, conversationId: "member_conversation_2" },
      async ({ request, conversationId, threadId }) =>
        executeCompleteOwnerAgentHelp(
          {
            request_id: request.id,
            status: "needs_user",
            response: "I prepared the safe context but did not perform the action.",
            user_question: "Do you approve the exact action described above?",
          },
          {
            callerAgentId: "orchestrator",
            depth: 1,
            conversationId,
            agentThreadId: threadId,
            parentRequestId: request.id,
          },
        ),
    ),
)
const escalatedData = escalated.data as Record<string, unknown>
const escalatedId = String(escalatedData.request_id ?? "")
const inboxConversation = runWithProfileContext(
  { profileId: ADMIN_PROFILE_ID, role: "admin" },
  () => getConversation(`owner_help_${escalatedId}`),
)
check(
  "needs_user result is returned to requester",
  escalated.success &&
    escalatedData.status === "needs_user" &&
    escalatedData.escalated === true,
  escalated,
)
check(
  "needs_user creates an internal owner Inbox item",
  inboxConversation?.messages.some((message) =>
    message.content.includes("Do you approve the exact action described above?"),
  ),
  inboxConversation,
)

const adminCall = await runWithProfileContext(
  { profileId: ADMIN_PROFILE_ID, role: "admin" },
  () =>
    executeRequestOwnerAgentHelp(
      { title: "Recursive", request: "Do not recurse." },
      context,
      async () => ({ success: true }),
    ),
)
check("admin cannot recursively request owner help", adminCall.success === false, adminCall)

const audits = listProfileAuditEvents({ profileId: enabled.id, limit: 20 })
check(
  "cross-profile request lifecycle is audited",
  audits.some((event) => event.type === "owner_agent.requested") &&
    audits.some((event) => event.type === "owner_agent.handled") &&
    audits.some((event) => event.type === "owner_agent.escalated"),
  audits.map((event) => event.type),
)

fs.rmSync(stateDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} owner-agent help smoke checks failed.`)
  process.exit(1)
}

console.log("\nAll owner-agent help smoke checks passed.")
