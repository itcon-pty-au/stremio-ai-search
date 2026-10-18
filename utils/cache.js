/**
 * A small LRU cache with a per-entry TTL that can be persisted to disk.
 *
 * One Map holds everything: Map iteration order is insertion order, so the
 * first key is always the least recently used one once `get` re-inserts a key
 * on every hit.
 *
 * The serialized shape ({ max, ttl, entries: [{ key, value, timestamp,
 * expiration }] }) is what earlier versions wrote to cache_data/, so existing
 * cache files keep loading.
 */
class SimpleLRUCache {
  constructor({ max = 1000, ttl = Infinity } = {}) {
    this.max = max;
    this.ttl = ttl;
    this.entries = new Map();
  }

  _live(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiration && Date.now() > entry.expiration) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key, value) {
    this.entries.delete(key);
    if (this.entries.size >= this.max) {
      this.entries.delete(this.entries.keys().next().value);
    }
    const now = Date.now();
    this.entries.set(key, {
      value,
      timestamp: now,
      expiration: this.ttl === Infinity ? undefined : now + this.ttl,
    });
    return this;
  }

  get(key) {
    const entry = this._live(key);
    if (!entry) return undefined;
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key) {
    return this._live(key) !== undefined;
  }

  delete(key) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }

  keys() {
    return Array.from(this.entries.keys());
  }

  serialize() {
    const entries = [];
    for (const [key, { value, timestamp, expiration }] of this.entries) {
      entries.push({ key, value, timestamp, expiration });
    }
    return { max: this.max, ttl: this.ttl, entries };
  }

  // max/ttl come from the code, not the file, so a changed limit takes effect
  // on the next start instead of being overwritten by the saved one.
  deserialize(data) {
    if (!data || !Array.isArray(data.entries)) return false;
    this.clear();
    const now = Date.now();
    for (const { key, value, timestamp, expiration } of data.entries) {
      if (expiration && now > expiration) continue;
      this.entries.set(key, { value, timestamp, expiration });
    }
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return true;
  }

  stats() {
    return {
      size: this.size,
      maxSize: this.max,
      usagePercentage: ((this.size / this.max) * 100).toFixed(2) + "%",
    };
  }
}

module.exports = { SimpleLRUCache };
