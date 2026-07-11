import { LruCache } from "@/lib/cache/lru-cache"

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

/** Process-local sliding-window limiter with bounded client-key retention. */
export class SlidingWindowRateLimiter {
  private readonly buckets: LruCache<string, number[]>

  constructor(
    private readonly windowMs: number,
    maxTrackedKeys: number
  ) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("Rate-limit window must be positive")
    }
    this.buckets = new LruCache({ maxEntries: maxTrackedKeys })
  }

  check(key: string, limit: number, now = Date.now()): RateLimitResult {
    if (!Number.isFinite(limit) || limit <= 0) {
      return { allowed: true, retryAfterSeconds: 0 }
    }

    const recent = (this.buckets.get(key) ?? []).filter(
      (timestamp) => now - timestamp < this.windowMs
    )
    if (recent.length >= limit) {
      this.buckets.set(key, recent)
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((recent[0] + this.windowMs - now) / 1000)
        ),
      }
    }

    recent.push(now)
    this.buckets.set(key, recent)
    return { allowed: true, retryAfterSeconds: 0 }
  }
}
