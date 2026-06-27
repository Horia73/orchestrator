import {
  buildModelRetryRecoveryContext,
  MAX_MODEL_RETRIES_BEFORE_FALLBACK,
  MAX_MODEL_RETRY_RECOVERY_TOOL_RESULTS,
  shouldTryModelFallback,
  type ModelRetryRecoveryAttempt,
} from "@/lib/ai/model-fallback"

let failures = 0

function check(label: string, condition: boolean) {
  if (!condition) {
    failures++
    console.error(`FAIL ${label}`)
  } else {
    console.log(`ok ${label}`)
  }
}

check(
  "capacity errors retry even after tool calls",
  shouldTryModelFallback("model is at capacity", { afterToolCall: true })
)
check(
  "429 errors retry after tool calls",
  shouldTryModelFallback("OpenAI API error 429: rate limit", {
    afterToolCall: true,
  })
)
check(
  "provider invalid argument errors recover after tool calls",
  shouldTryModelFallback("Request contains an invalid argument.", {
    afterToolCall: true,
  })
)
check(
  "invalid_request errors recover after tool calls",
  shouldTryModelFallback(
    "400 event: error data: {\"code\":\"invalid_request\"}",
    { afterToolCall: true }
  )
)
check(
  "model fallback retries same candidate three times before fallback",
  MAX_MODEL_RETRIES_BEFORE_FALLBACK === 3
)
check(
  "generic model errors retry only before tool calls",
  shouldTryModelFallback("model returned malformed output") &&
    !shouldTryModelFallback("model returned malformed output", {
      afterToolCall: true,
    })
)
check(
  "aborted turns never retry",
  !shouldTryModelFallback("Aborted", { afterToolCall: true })
)

check(
  "recovery context is empty without failed tool attempts",
  buildModelRetryRecoveryContext([]) === ""
)

const recoveryAttempt: ModelRetryRecoveryAttempt = {
  provider: "openrouter",
  model: "example/model",
  retry: 0,
  error: "OpenRouter API error 503: temporarily unavailable",
  toolCalls: [
    {
      toolName: "read_file",
      title: "Read lib/example.ts",
      args: { path: "lib/example.ts" },
      content: '{"ok":true,"value":"kept for retry"}',
      success: true,
      status: "ok",
    },
  ],
}
const recoveryContext = buildModelRetryRecoveryContext([recoveryAttempt])
check(
  "recovery context preserves prior tool results",
  recoveryContext.includes("kept for retry") &&
    recoveryContext.includes("Do not repeat successful tool calls") &&
    recoveryContext.includes("<model_retry_recovery_context>")
)

const manyToolAttempts: ModelRetryRecoveryAttempt[] = [
  {
    ...recoveryAttempt,
    toolCalls: Array.from(
      { length: MAX_MODEL_RETRY_RECOVERY_TOOL_RESULTS + 2 },
      (_, index) => ({
        toolName: "read_file",
        title: `Read file ${index}`,
        args: { path: `file-${index}.ts` },
        content: `result-${index}`,
        success: true,
        status: "ok" as const,
      })
    ),
  },
]
const boundedContext = buildModelRetryRecoveryContext(manyToolAttempts)
check(
  "recovery context is bounded to recent tool results",
  boundedContext.includes("Older tool calls omitted") &&
    !boundedContext.includes("result-0") &&
    boundedContext.includes(
      `result-${MAX_MODEL_RETRY_RECOVERY_TOOL_RESULTS + 1}`
    )
)

if (failures > 0) {
  console.error(`\n${failures} model fallback smoke check(s) failed.`)
  process.exit(1)
}

console.log("\nmodel fallback smoke passed")
