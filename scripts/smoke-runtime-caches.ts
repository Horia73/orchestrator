import { SlidingWindowRateLimiter } from "@/lib/api/sliding-window-rate-limit"
import { LruCache } from "@/lib/cache/lru-cache"

let failures = 0

function check(label: string, condition: unknown) {
  const ok = Boolean(condition)
  console.log(`${ok ? "✓" : "✗"} ${label}`)
  if (!ok) failures += 1
}

const entries = new LruCache<string, string>({ maxEntries: 2 })
entries.set("a", "A").set("b", "B")
check("LRU returns cached values", entries.get("a") === "A")
entries.set("c", "C")
check("LRU touch protects the recent entry", entries.has("a"))
check("LRU evicts the oldest entry", !entries.has("b"))
check("LRU enforces its entry cap", entries.size === 2)

const weighted = new LruCache<string, string>({
  maxEntries: 10,
  maxWeight: 5,
  weightOf: (value) => value.length,
})
weighted.set("small", "123").set("next", "456")
check("weighted LRU evicts to its budget", !weighted.has("small"))
check("weighted LRU tracks retained weight", weighted.weight === 3)
weighted.set("oversized", "123456")
check("oversized cache values are not retained", !weighted.has("oversized"))
check("weighted cache returns to zero after eviction", weighted.weight === 0)

const limiter = new SlidingWindowRateLimiter(1_000, 2)
check(
  "rate limiter admits first request",
  limiter.check("client", 2, 0).allowed
)
check(
  "rate limiter admits request up to limit",
  limiter.check("client", 2, 100).allowed
)
const blocked = limiter.check("client", 2, 200)
check("rate limiter blocks over limit", !blocked.allowed)
check("rate limiter reports retry delay", blocked.retryAfterSeconds === 1)
check(
  "rate limiter releases expired window",
  limiter.check("client", 2, 1_001).allowed
)

console.log(
  `\n${failures === 0 ? "runtime cache smoke passed" : `${failures} runtime cache failure(s)`}`
)
process.exit(failures === 0 ? 0 : 1)
