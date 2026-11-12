/** In-memory TTL cache with in-flight de-dupe.
 *  The call log is not refetched on the 60-second board poll. */

export function createRcCache({ now = () => Date.now() } = {}) {
  const slots = new Map();
  const inflight = new Map();

  return async function load(key, ttlMs, fetchRecords) {
    const hit = slots.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.records;
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      try {
        const records = await fetchRecords();
        slots.set(key, { at: now(), records });
        return records;
      } catch (err) {
        if (hit) return hit.records;
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}
