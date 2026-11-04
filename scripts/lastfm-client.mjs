// Last.fm API client. All requests made through one client share one speed limit,
// which slows down if Last.fm reports rate limiting.
const PERMANENT_ERRORS = new Set([6, 17]); // not found / private: specific to this item, don't retry
const FATAL_ERRORS = new Set([10, 26]); // bad or suspended API key: nothing else will work either
const MAX_INTERVAL_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ apiKey, userAgent, maxPerSecond = 4 }) {
  const minIntervalMs = 1000 / maxPerSecond;
  const stats = { requests: 0, rateLimited: 0 };
  let intervalMs = minIntervalMs, nextSlot = 0;

  async function waitForSlot() {
    const t = Date.now();
    const at = Math.max(t, nextSlot);
    nextSlot = at + intervalMs;
    if (at > t) await sleep(at - t);
  }
  function slowDown() {
    stats.rateLimited++;
    intervalMs = Math.min(intervalMs * 2, MAX_INTERVAL_MS);
    nextSlot = Math.max(nextSlot, Date.now() + MAX_INTERVAL_MS); // everyone pauses, not just this request
  }

  // Returns data[key], or { error, kind: "permanent" | "fatal" | "transient" }.
  async function apiGet(params, key) {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    url.search = new URLSearchParams({ ...params, api_key: apiKey, format: "json" });
    let last = "retries-exhausted";
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitForSlot();
      stats.requests++;
      let res, data;
      try {
        res = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(30_000) });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        last = `network: ${e.name}`; // e.message could include the URL, which holds the API key
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (data.error === 29 || res.status === 429) slowDown();
      if (data.error) {
        const message = `${data.error}: ${data.message ?? ""}`.trim();
        if (PERMANENT_ERRORS.has(data.error)) return { error: message, kind: "permanent" };
        if (FATAL_ERRORS.has(data.error)) return { error: message, kind: "fatal" };
        last = `api error ${data.error}`;
      } else if (res.ok && data[key]) {
        intervalMs = Math.max(minIntervalMs, intervalMs * 0.99);
        return data[key];
      } else {
        last = `http ${res.status}`;
      }
      await sleep(2000 * (attempt + 1)); // rate limited (29), temporary (8, 11, 16) or server trouble
    }
    return { error: last, kind: "transient" };
  }

  return { apiGet, stats };
}
