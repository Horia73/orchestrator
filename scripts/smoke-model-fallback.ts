import { shouldTryModelFallback } from "@/lib/ai/model-fallback"

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

if (failures > 0) {
  console.error(`\n${failures} model fallback smoke check(s) failed.`)
  process.exit(1)
}

console.log("\nmodel fallback smoke passed")
