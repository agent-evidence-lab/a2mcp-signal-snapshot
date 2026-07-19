export function createTtlCache({ maxEntries = 256, now = () => Date.now() } = {}) {
  const entries = new Map();
  const pendingLoads = new Map();

  return {
    async getOrLoad(key, ttlMs, loader) {
      const cached = entries.get(key);
      if (cached?.expiresAt > now()) return cached.value;
      if (cached) entries.delete(key);

      const pending = pendingLoads.get(key);
      if (pending) return pending;

      const load = Promise.resolve()
        .then(loader)
        .then((value) => {
          entries.set(key, { value, expiresAt: now() + ttlMs });
          while (entries.size > maxEntries) {
            entries.delete(entries.keys().next().value);
          }
          return value;
        })
        .finally(() => {
          if (pendingLoads.get(key) === load) pendingLoads.delete(key);
        });

      pendingLoads.set(key, load);
      return load;
    },
  };
}
