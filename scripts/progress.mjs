// Prints a progress line on a timer, so a long step never looks stuck in the Actions log.
// Counts only, never names: Actions logs on a public repo are public.
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  return m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

// getCounts returns { done, errors, requests, rateLimited, extra? }. done counts every item finished, errors included.
export function startProgress({ label, total, deadline, getCounts, everySeconds = 30 }) {
  const start = Date.now();
  let lastDone = 0, lastAt = start;

  const line = () => {
    const t = Date.now();
    const c = getCounts();
    const recent = (c.done - lastDone) / Math.max(1, (t - lastAt) / 1000); // since the last line, so a stall shows up
    const fullInterval = t - lastAt >= everySeconds * 500; // the closing line can land right after a timed one
    lastDone = c.done;
    lastAt = t;
    const overall = c.done / Math.max(1, (t - start) / 1000);
    const percent = total ? Math.floor((c.done / total) * 100) : 100;
    const toFinish = overall > 0 ? ((total - c.done) / overall) * 1000 : Infinity;
    const toLimit = deadline - t;
    const outlook = c.done >= total
      ? "finished"
      : toLimit <= 0
        ? "time limit reached, finishing what's in progress"
        : toFinish <= toLimit
          ? `finishes in about ${clock(toFinish)}`
          : `stops at the time limit in ${clock(toLimit)}, at about ${Math.min(total, Math.round(c.done + overall * (toLimit / 1000)))}`;
    const stalled = fullInterval && c.done < total && recent === 0 ? " | NO PROGRESS since the last line" : "";
    console.log(
      `[${clock(t - start)}] ${label} ${c.done}/${total} (${percent}%), ${recent.toFixed(1)}/s now | ` +
      `${c.requests} requests, ${c.errors} errors, ${c.rateLimited} rate limited${c.extra ? `, ${c.extra}` : ""} | ${outlook}${stalled}`
    );
  };

  const timer = setInterval(line, everySeconds * 1000);
  return { stop() { clearInterval(timer); line(); } };
}
