const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export class DeferredToolContextStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES, now = Date.now } = {}) {
    this.ttlMs = positiveInteger(ttlMs, 'ttlMs');
    this.maxEntries = positiveInteger(maxEntries, 'maxEntries');
    this.maxBytes = positiveInteger(maxBytes, 'maxBytes');
    this.now = now;
    this.entries = new Map();
    this.aliases = new Map();
    this.bytes = 0;
    this.nextId = 1;
  }

  remember(scope, toolCallIds, value) {
    const aliases = uniqueAliases(scope, toolCallIds);
    if (!aliases.length) return false;
    let size;
    try { size = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
    catch { return false; }
    if (size > this.maxBytes) return false;
    this.purgeExpired();
    for (const alias of aliases) {
      const existingId = this.aliases.get(alias);
      if (existingId !== undefined) this.remove(existingId);
    }
    while (this.entries.size >= this.maxEntries || this.bytes + size > this.maxBytes) {
      const oldestId = this.entries.keys().next().value;
      if (oldestId === undefined) break;
      this.remove(oldestId);
    }
    const id = this.nextId++;
    const entry = { aliases, value, size, expiresAt: this.now() + this.ttlMs };
    this.entries.set(id, entry);
    for (const alias of aliases) this.aliases.set(alias, id);
    this.bytes += size;
    return true;
  }

  find(scope, toolCallIds) {
    this.purgeExpired();
    for (const alias of uniqueAliases(scope, toolCallIds)) {
      const id = this.aliases.get(alias);
      if (id === undefined) continue;
      const entry = this.entries.get(id);
      if (entry) return { id, value: entry.value };
    }
    return null;
  }

  consume(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.remove(id);
    return true;
  }

  purgeExpired() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.remove(id);
    }
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const alias of entry.aliases) {
      if (this.aliases.get(alias) === id) this.aliases.delete(alias);
    }
    this.bytes = Math.max(0, this.bytes - entry.size);
  }
}

function uniqueAliases(scope, toolCallIds) {
  if (typeof scope !== 'string' || !scope || !Array.isArray(toolCallIds)) return [];
  const seen = new Set();
  const aliases = [];
  for (const toolCallId of toolCallIds) {
    if (typeof toolCallId !== 'string' || !toolCallId) continue;
    const alias = `${scope}\0${toolCallId}`;
    if (seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias);
  }
  return aliases;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} 必须是正整数`);
  return value;
}
