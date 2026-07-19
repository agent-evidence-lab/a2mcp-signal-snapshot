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
    const oldest = entries.entries().next();
    if (oldest.done) return null;
    entries.delete(oldest.value[0]);
    return oldest.value;
  }

  function restoreDisplacedEntries(displacedEntries) {
    purgeExpired();
    const availableEntries = maxEntries - pendingLoads.size - entries.size;
    if (availableEntries <= 0) return;

    const currentTime = now();
    const restored = displacedEntries
      .filter(([key, entry]) => (
        entry.expiresAt > currentTime
        && !entries.has(key)
        && !pendingLoads.has(key)
      ))
      .slice(0, availableEntries);
    if (restored.length === 0) return;

    const retained = [...entries];
    entries.clear();
    for (const [key, entry] of restored) entries.set(key, entry);
    for (const [key, entry] of retained) entries.set(key, entry);
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
      const displacedEntries = [];
      while (true) {
        const cached = entries.get(key);
        if (cached?.expiresAt > now()) return cached.value;
        if (cached) entries.delete(key);

        const pending = pendingLoads.get(key);
        if (pending) return pending;

        purgeExpired();
        while (entries.size + pendingLoads.size >= maxEntries && entries.size > 0) {
          displacedEntries.push(evictOldestEntry());
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
            restoreDisplacedEntries(displacedEntries);
            throw error;
          }
        );

      pendingLoads.set(key, load);
      return load;
    },
  };
}
