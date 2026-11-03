# last-fm-new-music-finder

Finds new music using the Last.fm API for the user's Last.fm account.

## Stack & Deployment

Scala.js (Scala 3, sbt) frontend using [Laminar](https://github.com/raquo/Laminar). Just a static website; no game or Java/TeaVM tooling.

- Source: `src/main/scala/com/pluto/box/Main.scala`; static page: `web/index.html` (uses relative `./main.js`).
- Build: `sbt fullLinkJS` → `target/scala-*/*-opt/main.js`. Dev: `sbt fastLinkJS`.
- `.github/workflows/ci.yml` runs on every push, builds, and commits `index.html` + `main.js` to the `gh-pages` branch under a folder named after the pushed branch (branch is created if missing).
- Live at `https://plutobox.github.io/last-fm-new-music-finder/<branch>/` (e.g. `/main/`). GitHub Pages must be set to serve from the `gh-pages` branch.
- The frontend is public static JS: never bake `LAST_FM_SHARED_SECRET` into it. Signed calls need a backend or CI step.

## Configuration & Secrets

**Never hardcode, print, log, or commit credential values.** Read them from environment variables only.

| Variable | Kind | Where it lives |
|---|---|---|
| `LAST_FM_APPLICATION_NAME` | Env variable (not secret) | Windows user env vars (`last-fm-new-music-finder`); GitHub repo variable |
| `LAST_FM_API_KEY` | Secret | Windows user env vars; GitHub repo secret |
| `LAST_FM_SHARED_SECRET` | Secret | Windows user env vars; GitHub repo secret |
| `LAST_FM_USERNAME` | Secret | Windows user env vars; GitHub repo secret (`TheBowser`) |
| `LAST_FM_AGE_IDENTITY` | Secret (age X25519 private key) | GitHub repo secret; local copy in `$HOME\.last-fm-new-music-finder.age.key` (made with `scripts/gen-age-key.mjs`). `scripts/crawl-friends.mjs` uses it to read and write encrypted `.age` output. |

### Getting the values

- **Locally (Windows):** they are set as User-level environment variables, so they are already available to any new shell/process. Read them with `$env:LAST_FM_API_KEY` (PowerShell), `sys.env("LAST_FM_API_KEY")` (sbt/Scala), etc. If a variable is missing, restart the terminal/Claude Code session so it picks up the User env.
- **To (re)set them** (user runs this, since it prompts for the secret):
  ```powershell
  [Environment]::SetEnvironmentVariable("LAST_FM_API_KEY", (Read-Host "LAST_FM_API_KEY" -MaskInput), "User")
  [Environment]::SetEnvironmentVariable("LAST_FM_SHARED_SECRET", (Read-Host "LAST_FM_SHARED_SECRET" -MaskInput), "User")
  [Environment]::SetEnvironmentVariable("LAST_FM_USERNAME", "TheBowser", "User")
  [Environment]::SetEnvironmentVariable("LAST_FM_APPLICATION_NAME", "last-fm-new-music-finder", "User")
  ```
- **In CI (GitHub Actions):** `LAST_FM_API_KEY`, `LAST_FM_SHARED_SECRET`, `LAST_FM_USERNAME`, and `LAST_FM_AGE_IDENTITY` are repo **secrets** (`${{ secrets.NAME }}`). `LAST_FM_APPLICATION_NAME` is a plain env/variable (`${{ vars.LAST_FM_APPLICATION_NAME }}`). Manage with `gh secret set <NAME>` / `gh variable set <NAME>`.
- Don't create `.env` files with real values; `.env` is gitignored.

## Last.fm Authentication

Docs: https://www.last.fm/api/webauth

Read-only calls (e.g. `user.getTopArtists`, `user.getRecentTracks`, `artist.getSimilar`) only need `api_key` and don't require auth. Calls that act on behalf of a user (scrobbling, loving tracks, etc.) require a session key (`sk`) from the web auth flow:

1. **Send the user to the auth URL:**
   `https://www.last.fm/api/auth/?api_key=$LAST_FM_API_KEY&cb=<callback_url>`
   After approving, Last.fm redirects to the callback with `?token=<token>` (token is valid 60 minutes, single use).
2. **Exchange the token for a session key** with `auth.getSession`. The request must be signed (`api_sig`).
3. **Store the session key** (`sk`) — it does not expire. Treat it as a secret.

### Signing requests (`api_sig`)

1. Take all params (except `format` and `callback`), sort alphabetically by name.
2. Concatenate as `name1value1name2value2...` (no separators).
3. Append `LAST_FM_SHARED_SECRET`.
4. MD5 hash the string (UTF-8) → hex digest is `api_sig`.

### Example (Node.js, for reference; signing must happen server-side/CI, not in the browser)

```js
import crypto from "node:crypto";

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
const { LAST_FM_API_KEY, LAST_FM_SHARED_SECRET } = process.env;

function sign(params) {
  const str = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback")
    .sort()
    .map((k) => k + params[k])
    .join("");
  return crypto.createHash("md5").update(str + LAST_FM_SHARED_SECRET, "utf8").digest("hex");
}

// Step 1: URL to send the user to
export const authUrl = (cb) =>
  `https://www.last.fm/api/auth/?api_key=${LAST_FM_API_KEY}&cb=${encodeURIComponent(cb)}`;

// Step 2: exchange the ?token= from the callback for a session key
export async function getSession(token) {
  const params = { method: "auth.getSession", api_key: LAST_FM_API_KEY, token };
  const url = new URL(API_ROOT);
  url.search = new URLSearchParams({ ...params, api_sig: sign(params), format: "json" });
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Last.fm ${data.error}: ${data.message}`);
  return data.session; // { name, key, subscriber }
}
```

Unauthenticated example (no signing needed):

```js
const url = new URL(API_ROOT);
url.search = new URLSearchParams({
  method: "user.getTopArtists",
  user: process.env.LAST_FM_USERNAME,
  api_key: process.env.LAST_FM_API_KEY,
  format: "json",
});
```

Send a descriptive `User-Agent` using `LAST_FM_APPLICATION_NAME`.
