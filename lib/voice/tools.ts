// The live voice agent's tool surface. Deliberately small — every extra tool
// adds latency to the first spoken token — and guarded: Home Assistant calls
// go through the voice allowlist, and anything complex is delegated to a
// background agent that announces back when it finishes.

import { randomUUID } from "crypto"

import type { FunctionDeclaration } from "@google/genai"

import { executeDelegateTo } from "@/lib/ai/tools/delegate-to"
import { getConfig } from "@/lib/config"
import { addMessage } from "@/lib/db"
import {
  homeAssistantCallService,
  homeAssistantGetState,
  homeAssistantSearchEntities,
} from "@/lib/integrations/home-assistant"
import { sendChatCompletionPushNotification } from "@/lib/push-notifications"
import {
  evaluateVoiceHaCall,
  defaultVoiceSettings,
  type VoiceSettings,
} from "@/lib/voice/schema"

const MAX_TOOL_RESULT_CHARS = 4_000
const DELEGATED_TASK_AGENT_ID = "worker"

export interface VoiceToolContext {
  conversationId: string
  settings: VoiceSettings
  /** Speak a background update into the live session, if it is still open. */
  injectAnnouncement: (text: string) => void
  /** Ask the gateway to end the session gracefully after the current turn. */
  requestEnd: () => void
}

export function buildVoiceFunctionDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: "home_assistant_find_entities",
      description:
        "Search Home Assistant entities by free-text query (name, room, device). Use before controlling something when you do not know the exact entity id.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search, e.g. 'living room lights'." },
        },
        required: ["query"],
      },
    },
    {
      name: "home_assistant_get_state",
      description: "Read the current state and attributes of one Home Assistant entity.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          entity_id: { type: "string", description: "Entity id, e.g. light.living_room." },
        },
        required: ["entity_id"],
      },
    },
    {
      name: "home_assistant_control",
      description:
        "Execute a Home Assistant service call, e.g. domain 'light' service 'turn_on' with entity_ids ['light.living_room'] and optional data like {brightness_pct: 40}. Only home-control domains are allowed from voice; security domains are refused.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Service domain, e.g. light, switch, climate." },
          service: { type: "string", description: "Service name, e.g. turn_on, set_temperature." },
          entity_ids: {
            type: "array",
            items: { type: "string" },
            description: "Target entity ids.",
          },
          data: {
            type: "object",
            description: "Optional service data (brightness_pct, temperature, ...).",
          },
        },
        required: ["domain", "service", "entity_ids"],
      },
    },
    {
      name: "delegate_to_orchestrator",
      description:
        "Hand a complex or slow task (research, multi-step work, anything needing more tools than you have) to the Orchestrator's background agents. Returns immediately — tell the user you'll get back to them; the result is announced when ready.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Self-contained task description with all context the agent needs.",
          },
        },
        required: ["task"],
      },
    },
    {
      name: "end_conversation",
      description:
        "End the voice session. Call when the user says they are done (e.g. 'gata', 'mulțumesc, pa', 'that's all').",
      parametersJsonSchema: { type: "object", properties: {} },
    },
  ]
}

export async function executeVoiceTool(
  name: string,
  args: Record<string, unknown>,
  ctx: VoiceToolContext
): Promise<Record<string, unknown>> {
  switch (name) {
    case "home_assistant_find_entities":
      return truncated(
        await homeAssistantSearchEntities({
          query: typeof args.query === "string" ? args.query : "",
          maxResults: 20,
        })
      )
    case "home_assistant_get_state": {
      const entityId = typeof args.entity_id === "string" ? args.entity_id : ""
      if (!entityId) return { error: "entity_id is required" }
      return truncated(await homeAssistantGetState(entityId))
    }
    case "home_assistant_control":
      return executeHaControl(args, ctx)
    case "delegate_to_orchestrator":
      return startVoiceDelegation(args, ctx)
    case "end_conversation":
      ctx.requestEnd()
      return { ok: true, note: "Say a brief goodbye; the session closes after this turn." }
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

async function executeHaControl(
  args: Record<string, unknown>,
  ctx: VoiceToolContext
): Promise<Record<string, unknown>> {
  const domain = typeof args.domain === "string" ? args.domain : ""
  const service = typeof args.service === "string" ? args.service : ""
  const entityIds = Array.isArray(args.entity_ids)
    ? args.entity_ids.filter((id): id is string => typeof id === "string" && !!id.trim())
    : []
  if (!domain || !service || !entityIds.length) {
    return { error: "domain, service and entity_ids are required" }
  }
  const verdict = evaluateVoiceHaCall(ctx.settings.homeAssistant, domain, entityIds)
  if (!verdict.allowed) return { error: verdict.reason }
  const data =
    args.data && typeof args.data === "object" && !Array.isArray(args.data)
      ? (args.data as Record<string, unknown>)
      : undefined
  const result = await homeAssistantCallService({
    domain,
    service,
    target: { entity_id: entityIds },
    data,
    // The allowlist is the voice-mode confirmation boundary: only
    // direct-control domains ever reach this call, so the generic HA
    // confirmation escalation (built for the chat surface) is pre-satisfied.
    confirmed: true,
    reason: "voice command",
  })
  return truncated({
    service: result.service,
    changedEntityIds: result.changedEntityIds,
    after: result.after,
  })
}

function startVoiceDelegation(
  args: Record<string, unknown>,
  ctx: VoiceToolContext
): Record<string, unknown> {
  const task = typeof args.task === "string" ? args.task.trim() : ""
  if (!task) return { error: "task is required" }
  const config = getConfig()
  const conversationId = ctx.conversationId

  void executeDelegateTo(
    {
      agent_id: DELEGATED_TASK_AGENT_ID,
      prompt: [
        `Task delegated from a live voice conversation with ${config.userName || "the user"}.`,
        "Work autonomously; the user is not available for follow-up questions.",
        "Reply with a final answer that reads well when spoken aloud (short paragraphs, no tables).",
        "",
        task,
      ].join("\n"),
      thread_title: `Voice: ${task.slice(0, 60)}`,
    },
    {
      callerAgentId: "orchestrator",
      depth: 0,
      conversationId,
      parentRequestId: randomUUID(),
    }
  )
    .then(async (result) => {
      const output = result.success
        ? extractDelegationOutput(result.data)
        : `Task-ul de fundal a eșuat: ${result.error ?? "unknown error"}`
      const summary = output || "Task-ul de fundal s-a terminat fără output."
      addMessage(conversationId, {
        id: randomUUID(),
        role: "assistant",
        content: summary,
        status: "ok",
        timestamp: Date.now(),
      })
      ctx.injectAnnouncement(
        `Background task finished. Summarize this result for the user in one or two spoken sentences: ${summary.slice(0, 1500)}`
      )
      await sendChatCompletionPushNotification({
        conversationId,
        title: "Voice task finished",
        body: summary,
      })
    })
    .catch((err) => {
      console.error("[voice] delegated task failed", err)
      ctx.injectAnnouncement(
        "The background task failed with an internal error. Apologize briefly to the user."
      )
    })

  return {
    ok: true,
    note: "Delegation started in the background. Tell the user you'll announce the result when it's ready, then continue the conversation.",
  }
}

function extractDelegationOutput(data: unknown): string {
  if (!data || typeof data !== "object") return ""
  const record = data as Record<string, unknown>
  if (typeof record.output === "string") return record.output.trim()
  return ""
}

function truncated(value: unknown): Record<string, unknown> {
  const json = JSON.stringify(value)
  if (json.length <= MAX_TOOL_RESULT_CHARS) {
    return { result: value }
  }
  return {
    result: `${json.slice(0, MAX_TOOL_RESULT_CHARS)}…`,
    truncated: true,
  }
}

export function voiceSettingsFromConfig(): VoiceSettings {
  return getConfig().voice ?? defaultVoiceSettings()
}
