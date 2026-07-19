export function createTtlCache({ maxEntries = 256, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("maxEntries must be a positive integer");
  }

  const entries = new Map();
  const pendingLoads = new Map();

  function purgeExpired() {
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(key);
    }
  }

  function evictOldestEntry() {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) return false;
    entries.delete(oldestKey);
    return true;
  }

  function waitForPendingLoad() {
    return Promise.race(
      Array.from(pendingLoads.values(), (pending) => pending.then(
        () => undefined,
        () => undefined,
      )),
    );
  }

  return {
    async getOrLoad(key, ttlMs, loader) {
      while (true) {
        const cached = entries.get(key);
        if (cached?.expiresAt > now()) return cached.value;
        if (cached) entries.delete(key);

        const pending = pendingLoads.get(key);
        if (pending) return pending;

        purgeExpired();
        while (entries.size + pendingLoads.size >= maxEntries && entries.size > 0) {
          evictOldestEntry();
        }

        if (entries.size + pendingLoads.size < maxEntries) break;
        await waitForPendingLoad();
      }

      let load;
      load = Promise.resolve()
        .then(loader)
        .then(
          (value) => {
            if (pendingLoads.get(key) === load) pendingLoads.delete(key);
            purgeExpired();
            entries.set(key, { value, expiresAt: now() + ttlMs });
            while (entries.size + pendingLoads.size > maxEntries) {
              evictOldestEntry();
            }
            return value;
          },
          (error) => {
            if (pendingLoads.get(key) === load) pendingLoads.delete(key);
            throw error;
          }
        );

      pendingLoads.set(key, load);
      return load;
    },
  };
}
