// The one Last.fm API client: every script must make its requests through this, so they all obey the same limits.
//
// Rate limiting (error 29 or HTTP 429) can get the API key suspended, so it's treated as serious:
// - All requests through a client share one speed limit, which is halved each time we're rate limited.
// - Each rate-limit response pauses every request, for longer each time.
// - After MAX_RATE_LIMIT_HITS hits with no success in between, the client stops for good: no more requests are sent,
//   and every call returns kind "fatal", so the script saves its progress and ends.
// - If LAST_FM_RATE_LIMIT_FILE is set, stopping also creates that file, and a client that finds it sends nothing.
//   That carries the stop across the steps of a workflow run.
import fs from "node:fs";
import { logError, saveError, scrub } from "./error-log.mjs";

const PERMANENT_ERRORS = new Set([6, 17]); // not found / private: specific to this item, don't retry
const FATAL_ERRORS = new Set([10, 26]); // bad or suspended API key: nothing else will work either
// What the public log says about an error. Last.fm's own message could repeat a username, so it's never printed.
const ERROR_NAMES = {
  2: "invalid service", 3: "invalid method", 4: "authentication failed", 5: "invalid format", 6: "not found or invalid parameters",
  7: "invalid resource", 8: "operation failed", 9: "invalid session", 10: "invalid API key", 11: "service offline",
  13: "invalid signature", 16: "temporary error", 17: "private or login required", 26: "API key suspended", 29: "rate limited",
};
const errorName = (code) => `Last.fm error ${code} (${ERROR_NAMES[code] ?? "unknown"})`;
const MAX_INTERVAL_MS = 5000;
const MAX_RATE_LIMIT_HITS = 3;
const RATE_LIMIT_PAUSE_MS = Number(process.env.LAST_FM_RATE_LIMIT_PAUSE_MS ?? 30_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ apiKey, userAgent, maxPerSecond = 4 }) {
  const stopFile = process.env.LAST_FM_RATE_LIMIT_FILE;
  const minIntervalMs = 1000 / maxPerSecond;
  const stats = { requests: 0, rateLimited: 0 };
  let intervalMs = minIntervalMs, nextSlot = 0, hits = 0, pausedUntil = 0;
  let stoppedBecause = stopFile && fs.existsSync(stopFile) ? "rate limited earlier in this run" : null;

  async function waitForSlot() {
    // Re-reads the time after waiting: a rate-limit response can push nextSlot back in the meantime.
    for (;;) {
      const t = Date.now();
      if (nextSlot <= t) break;
      await sleep(nextSlot - t);
    }
    nextSlot = Date.now() + intervalMs;
  }

  function rateLimitHit() {
    stats.rateLimited++;
    // Parallel requests can all come back rate limited at once. That's one hit, not several.
    if (Date.now() < pausedUntil) return;
    hits++;
    if (hits >= MAX_RATE_LIMIT_HITS) {
      stoppedBecause = `rate limited ${hits} times in a row`;
      if (stopFile) fs.writeFileSync(stopFile, `${stoppedBecause}\n`);
      return;
    }
    intervalMs = Math.min(intervalMs * 2, MAX_INTERVAL_MS);
    pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS * hits;
    nextSlot = Math.max(nextSlot, pausedUntil);
    console.log(`::warning::Last.fm rate limited us (${hits} of ${MAX_RATE_LIMIT_HITS}). Pausing all requests and slowing down.`);
  }

  // Returns data[key], or { error, kind: "permanent" | "fatal" | "transient" }.
  async function apiGet(params, key) {
    // The log gets the method and a fixed description only, as params can hold a username.
    const report = (what, detail = "") => logError(`${params.method}: ${what}`, detail);
    // The encrypted database gets everything, for working out what happened later. params never holds the API key.
    const save = (outcome, message) =>
      saveError(`${JSON.stringify(params)} ${outcome}: ${scrub(message, [apiKey])}`);
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    url.search = new URLSearchParams({ ...params, api_key: apiKey, format: "json" });
    let last = "retries-exhausted", lastMessage = last;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (stoppedBecause) return { error: stoppedBecause, kind: "fatal" };
      if (attempt > 0) report(last, `will retry (attempt ${attempt})`);
      await waitForSlot();
      if (stoppedBecause) return { error: stoppedBecause, kind: "fatal" }; // may have happened during the wait
      stats.requests++;
      let res, data;
      try {
        res = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(30_000) });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        last = `network: ${e.name}${e.cause?.code ? ` ${e.cause.code}` : ""}`; // e.message could include the URL, which holds the API key
        lastMessage = last;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (data.error === 29 || res.status === 429) {
        rateLimitHit();
        last = "rate limited";
        lastMessage = last;
        continue; // waitForSlot holds the retry until the pause is over
      }
      if (data.error) {
        const message = `${data.error}: ${data.message ?? ""}`.trim();
        if (PERMANENT_ERRORS.has(data.error)) {
          report(errorName(data.error));
          save("permanent", message);
          return { error: message, kind: "permanent" };
        }
        if (FATAL_ERRORS.has(data.error)) {
          report(errorName(data.error));
          save("fatal", message);
          return { error: message, kind: "fatal" };
        }
        last = errorName(data.error);
        lastMessage = message;
      } else if (res.ok && data[key]) {
        hits = 0;
        intervalMs = Math.max(minIntervalMs, intervalMs * 0.99);
        return data[key];
      } else {
        last = `http ${res.status}`;
        lastMessage = last;
      }
      await sleep(2000 * (attempt + 1)); // temporary errors (8, 11, 16) or server trouble
    }
    report(last, "gave up after 4 tries");
    save("gave up after 4 tries", lastMessage);
    return { error: last, kind: "transient" };
  }

  return { apiGet, stats };
}
