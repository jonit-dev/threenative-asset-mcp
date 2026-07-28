const MAX_CACHE_ENTRIES = 500;

interface CacheEntry<Value> {
  value: Value;
  expiresAt: number;
}

export interface TtlLruCacheOptions {
  maxEntries?: number;
  now?: () => number;
}

/**
 * Process-local TTL/LRU cache. Map insertion order is used as the LRU list,
 * so reads move an entry to the newest position and eviction remains O(1).
 */
export class TtlLruCache<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TtlLruCacheOptions = {}) {
    this.maxEntries = Math.min(
      MAX_CACHE_ENTRIES,
      Math.max(1, Math.trunc(options.maxEntries ?? MAX_CACHE_ENTRIES)),
    );
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns an entry even after TTL expiry, without changing LRU order. */
  peek(key: string): Value | undefined {
    return this.entries.get(key)?.value;
  }

  get(key: string): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Value, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: this.now() + ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
