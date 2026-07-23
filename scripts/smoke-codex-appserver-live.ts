import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

type JsonObject = Record<string, unknown>

const realCodex = process.env.CODEX_0144_BIN?.trim() || "codex"
const version = spawnSync(realCodex, ["--version"], { encoding: "utf8" })
assert.equal(version.status, 0, version.stderr || `Unable to run ${realCodex}`)
assert.match(
  `${version.stdout}\n${version.stderr}`,
  /codex-cli 0\.144\.4\b/,
  "This protocol smoke must run against Codex CLI 0.144.4"
)

const fixtureRoot = mkdtempSync(join(tmpdir(), "orchestrator-codex-0144-live-"))
process.env.ORCHESTRATOR_STATE_DIR = join(fixtureRoot, "state")
process.env.MOCK_API_KEY = "offline-smoke-key"

const requests: JsonObject[] = []
const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res)
  } catch (error) {
    res.statusCode = 500
    res.end(error instanceof Error ? error.message : String(error))
  }
})

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")

  const wrapper = join(fixtureRoot, "codex-0.144.4-offline")
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  writeFileSync(wrapper, [
    "#!/bin/sh",
    `exec ${shellQuote(realCodex)} \"$@\"` + " \\",
    "  -c 'model_provider=\"mock\"' \\",
    "  -c 'model_providers.mock.name=\"Orchestrator offline smoke\"' \\",
    `  -c 'model_providers.mock.base_url=${JSON.stringify(baseUrl)}'` + " \\",
    "  -c 'model_providers.mock.env_key=\"MOCK_API_KEY\"' \\",
    "  -c 'model_providers.mock.wire_api=\"responses\"' \\",
    "  -c 'model_providers.mock.request_max_retries=0' \\",
    "  -c 'model_providers.mock.stream_max_retries=0' \\",
    "  -c 'features.code_mode_only=true'",
    "",
  ].join("\n"))
  chmodSync(wrapper, 0o755)

  const [{ codexProviderTestHooks }, { delegateToTool }] = await Promise.all([
    import("@/lib/ai/providers/codex"),
    import("@/lib/ai/tools/delegate-to"),
  ])

  const errors: string[] = []
  const content: string[] = []
  const toolCalls: string[] = []
  const toolResults: string[] = []
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    await codexProviderTestHooks.runCodexAppServer({
      bin: wrapper,
      prompt: "Call the supplied delegation tool exactly once, then finish.",
      model: "gpt-5.6-sol",
      tools: [delegateToTool],
      builtins: [],
      nativeCoderRun: false,
      cwd: fixtureRoot,
      signal: controller.signal,
      spawnEnv: { MOCK_API_KEY: "offline-smoke-key" },
      callbacks: {
        onThinking() {},
        onThinkingDone() {},
        onContent(text) { content.push(text) },
        onToolCall(call) { toolCalls.push(call.name) },
        onToolResult(_id, name) { toolResults.push(name) },
        onError(error) { errors.push(error) },
        onDone() {},
      },
    })
  } finally {
    clearTimeout(timeout)
  }

  assert.deepEqual(errors, [], `Codex app-server errors: ${errors.join(" | ")}`)
  assert.equal(requests.length, 2, "The mocked model should receive one tool turn and one final turn")
  assert.deepEqual(toolCalls, ["delegate_to"], "The app-server must emit delegate_to directly")
  assert.deepEqual(toolResults, ["delegate_to"], "The direct delegation response must complete normally")
  assert.equal(content.join(""), "DONE")

  const first = requests[0]
  const inputItems = Array.isArray(first.input) ? first.input as JsonObject[] : []
  const additionalTools = inputItems.flatMap(item => (
    item.type === "additional_tools" && Array.isArray(item.tools)
      ? item.tools as JsonObject[]
      : []
  ))
  const firstTools = [
    ...(Array.isArray(first.tools) ? first.tools as JsonObject[] : []),
    ...additionalTools,
  ]
  const namespace = firstTools.find(tool => tool.type === "namespace" && tool.name === "orchestrator")
  assert.ok(namespace, `Missing direct Orchestrator namespace: ${JSON.stringify(firstTools)}`)
  const namespaceTools = Array.isArray(namespace.tools) ? namespace.tools as JsonObject[] : []
  assert.ok(
    namespaceTools.some(tool => tool.type === "function" && tool.name === "delegate_to"),
    `delegate_to is not inside the Orchestrator namespace: ${JSON.stringify(namespace)}`
  )
  assert.equal(
    firstTools.some(tool => tool.type === "function" && tool.name === "delegate_to"),
    false,
    "delegate_to must never fall back to a flat dynamic tool"
  )
  const visibleToolNames = new Set(firstTools.map(tool => tool.name).filter((name): name is string => typeof name === "string"))
  for (const forbidden of ["spawn_agent", "spawnAgent", "send_input", "sendInput", "resume_agent", "resumeAgent", "close_agent", "closeAgent"]) {
    assert.equal(
      visibleToolNames.has(forbidden),
      false,
      `Managed Codex request must not expose native collaboration tool ${forbidden}`
    )
  }
  assert.ok(visibleToolNames.has("exec"), "The fixture must actually exercise code_mode_only")
  assert.ok(visibleToolNames.has("wait"), "The fixture must actually exercise the code-mode host")

  const secondInput = JSON.stringify(requests[1].input)
  assert.match(secondInput, /function_call_output/)
  assert.match(secondInput, /offline-delegate-call/)

  console.log("Codex 0.144.4 live app-server direct-namespace smoke passed")
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(fixtureRoot, { recursive: true, force: true })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ object: "list", data: [] }))
    return
  }

  if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
    res.statusCode = 404
    res.end("not found")
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject
  requests.push(body)

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-request-id": `offline-${requests.length}`,
  })
  if (requests.length === 1) {
    res.end(sse([
      responseCreated("offline-response-1"),
      {
        type: "response.output_item.added",
        item: {
          type: "reasoning",
          id: "offline-pre-delegation-reasoning",
          summary: [],
        },
      },
      {
        type: "response.reasoning_summary_text.delta",
        delta: "Delegate synchronously.",
        summary_index: 0,
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "offline-delegate-call",
          namespace: "orchestrator",
          name: "delegate_to",
          arguments: JSON.stringify({ agent_id: "browser_agent", prompt: "offline protocol probe" }),
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          id: "offline-pre-delegation-reasoning",
          summary: [{ type: "summary_text", text: "Delegate synchronously." }],
          encrypted_content: Buffer.from("b".repeat(550)).toString("base64"),
        },
      },
      responseCompleted("offline-response-1"),
    ]))
    return
  }

  res.end(sse([
    responseCreated("offline-response-2"),
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "offline-final-message",
        content: [{ type: "output_text", text: "DONE" }],
      },
    },
    responseCompleted("offline-response-2"),
  ]))
}

function responseCreated(id: string): JsonObject {
  return { type: "response.created", response: { id } }
}

function responseCompleted(id: string): JsonObject {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function sse(events: JsonObject[]): string {
  return events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}
