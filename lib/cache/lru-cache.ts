export interface LruCacheOptions<K, V> {
  maxEntries: number
  maxWeight?: number
  weightOf?: (value: V, key: K) => number
}

interface WeightedValue<V> {
  value: V
  weight: number
}

/**
 * Small process-local LRU cache with both entry and optional weight limits.
 *
 * A plain module-scoped Map never releases old keys and quietly becomes a
 * memory leak in long-lived browser tabs or Node processes. This cache keeps
 * the same synchronous API while refreshing hits and evicting oldest entries.
 */
export class LruCache<K, V> implements Iterable<[K, V]> {
  private readonly values = new Map<K, WeightedValue<V>>()
  private readonly maxEntries: number
  private readonly maxWeight: number
  private readonly weightOf: (value: V, key: K) => number
  private totalWeight = 0

  constructor(options: LruCacheOptions<K, V>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error("LruCache maxEntries must be a positive integer")
    }
    if (
      options.maxWeight !== undefined &&
      (!Number.isFinite(options.maxWeight) || options.maxWeight <= 0)
    ) {
      throw new Error("LruCache maxWeight must be a positive number")
    }
    this.maxEntries = options.maxEntries
    this.maxWeight = options.maxWeight ?? Number.POSITIVE_INFINITY
    this.weightOf = options.weightOf ?? (() => 1)
  }

  get size(): number {
    return this.values.size
  }

  get weight(): number {
    return this.totalWeight
  }

  has(key: K): boolean {
    return this.values.has(key)
  }

  get(key: K): V | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    this.values.delete(key)
    this.values.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): this {
    const existing = this.values.get(key)
    if (existing) {
      this.values.delete(key)
      this.totalWeight -= existing.weight
    }

    const measured = this.weightOf(value, key)
    const weight = Number.isFinite(measured) ? Math.max(0, measured) : 0
    this.values.set(key, { value, weight })
    this.totalWeight += weight
    this.evict()
    return this
  }

  delete(key: K): boolean {
    const existing = this.values.get(key)
    if (!existing) return false
    this.totalWeight -= existing.weight
    return this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
    this.totalWeight = 0
  }

  *entries(): IterableIterator<[K, V]> {
    for (const [key, entry] of this.values) yield [key, entry.value]
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  private evict(): void {
    while (
      this.values.size > this.maxEntries ||
      this.totalWeight > this.maxWeight
    ) {
      const oldest = this.values.keys().next()
      if (oldest.done) break
      this.delete(oldest.value)
    }
  }
}
