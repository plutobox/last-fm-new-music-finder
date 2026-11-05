// Prints the errors a script handles and carries on from, so they can be read in the Actions log. That log is public, so
// callers pass only what's safe to show: never a username or a key. scrub() removes values that a message might echo.
// Prints the first MAX_PER_KIND of each kind, then only counts them, and ends with a total per kind.
const MAX_PER_KIND = 20;
const counts = new Map();

export function logError(kind, detail = "") {
  const n = (counts.get(kind) ?? 0) + 1;
  counts.set(kind, n);
  if (n <= MAX_PER_KIND) console.log(`[error] ${kind}${detail ? `: ${detail}` : ""}`);
  if (n === MAX_PER_KIND) console.log(`[error] ${kind}: not printing more of these, only counting them`);
}

// Blanks out each of the given values in a message.
export function scrub(text, values) {
  let out = String(text);
  for (const value of values) {
    if (value) out = out.split(String(value)).join("<hidden>");
  }
  return out;
}

process.on("exit", () => {
  if (!counts.size) return;
  const list = [...counts].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} x ${kind}`);
  console.log(`Errors this run: ${list.join("; ")}`);
});
