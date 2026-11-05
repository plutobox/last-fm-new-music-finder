# last-fm-new-music-finder

Finds new music using the Last.fm API for the user's Last.fm account.

## Stack & Deployment

Scala.js (Scala 3, sbt) frontend using [Laminar](https://github.com/raquo/Laminar). Just a static website; no game or Java/TeaVM tooling.

- Source: `src/main/scala/com/pluto/box/Main.scala`; static page: `web/index.html` (uses relative `./main.js`).
- Build: `sbt fullLinkJS` → `target/scala-*/*-opt/main.js`. Dev: `sbt fastLinkJS`.
- `.github/workflows/ci.yml` runs on every push, builds, and commits `index.html` + `main.js` to the `gh-pages` branch under a folder named after the pushed branch (branch is created if missing).
- Live at `https://plutobox.github.io/last-fm-new-music-finder/<branch>/` (e.g. `/main/`). The site root redirects to `/main/` (`web/root-index.html`, published by CI). GitHub Pages must be set to serve from the `gh-pages` branch.
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

## Crawled users database

- `.github/workflows/crawl-users.yml` runs daily and on demand. To pause it, use `gh workflow disable crawl-users.yml`. It runs `scripts/crawl-friends.mjs`, which walks `user.getFriends` out from random not-yet-crawled users and stores the results in SQLite (`node:sqlite`, Node 24+).
- The database lives in the `database` GitHub Release, gzipped and age-encrypted (`scripts/db-store.mjs`), and is split only past 1.9 GB, under the 2 GB limit on Release files. Each workflow downloads it, updates it and uploads a new version (`scripts/release-store.mjs`). The newest version and one backup are kept, and a failed upload can't replace good data. It's not on `gh-pages`, so it adds nothing to Git history. Tables: `users` (profile fields from the friends payload, `depth`, `discovered_via`, `crawled_at`), `friendships` (user → friend edges), `runs` (per-run stats).
- Each user's friends are fetched once (`crawled_at`); later runs reuse the `friendships` table instead of calling the API.
- See "Querying the data" below for how to read it.
- `.github/workflows/fetch-top-tracks.yml` runs every 2 hours (and on demand). GitHub often delays or drops scheduled runs, so cron is only a backup: each successful run starts `.github/workflows/fetch-timer.yml`, which waits out the 2 hours and any running database workflow, then starts the next fetch. To pause the fetches, disable both workflows. It runs `scripts/fetch-top-tracks.mjs`, which makes two `user.getTopTracks` requests per user (`period=overall` and `period=12month`, `limit=50`, no pagination), starting with `LAST_FM_USERNAME`, then any users named in a manual run's `users` input (they count toward `max_users`), then most listens per day since the account was made, then most friends, then random. Likely bots (300+ listens a day, `scripts/user-activity.mjs`) and users with no listens go to the back of the queue, but are still fetched. Friend-hops (`depth`) play no part in the order. **It's a one-time pull: never refresh a user's data.** Anyone with `users.songs_fetched_at` set is never requested again.
- Total listens come from `scripts/fetch-user-info.mjs`, which runs first in that workflow (`user.getInfo`, one request per waiting user, once ever, most friends first; `users.total_plays`, `total_artists`, `total_tracks`, `total_albums`, tracked by `users.profile_fetched_at`). `users.playcount` is always 0, because `user.getFriends` doesn't really report it, so don't rank by it.
- The same workflow calls `user.getLovedTracks` for each user (every page, also a one-time pull, tracked by `users.loved_fetched_at`). Loved and top songs share the `songs` and `artists` tables. Table: `user_loved_songs`. Views: `user_loved_songs_named`, `user_merged_songs` (each user's top and loved songs merged, one row per user and song).
- Requests run in parallel inside one run (6 users at a time for top and loved songs, 3 for artist tags and song details, each sharing a limit of 4 per second that slows down if Last.fm reports rate limiting). Don't run these workflows in parallel with each other: each one rewrites the whole database, so the crawl, fetch and import workflows share the `database-write` `concurrency` group. GitHub keeps only one waiting run per group, so a new run can cancel one that's waiting, which is why their schedules are spaced apart.
- That workflow also runs `scripts/fetch-artist-tags.mjs` (`artist.getTopTags`, one request per artist with a song that has 2+ listeners, once ever, most-listened first; `tags`, `artist_tags`, `artist_tag_fetches`), `scripts/fetch-track-info.mjs` (`track.getInfo`, one request per song with 2+ listeners, once ever, most-listened first; adds global counts, URL and wiki date to `songs`, plus `albums` and `song_tags`; wiki text is deliberately not stored; tracked by `songs.info_fetched_at`) and then `scripts/export-songs.mjs`.
- A parallel `youtube` job in that workflow runs `scripts/fetch-youtube-ids.mjs`, which uses yt-dlp for metadata only, to find plain audio uploads, not music videos, for songs with 2+ listeners, unless already found through YouTube Music, each once (tracked by `songs.youtube_audio_searched_at`), most loved first, then most listeners, then most plays. It searches YouTube Music, then normal YouTube, and every result must pass a `videos.list` check, including coming from a "- Topic" channel or being titled "Official Audio". A result replaces any earlier `youtube_search_id`, but a search that finds nothing never clears it. The public data prefers `youtube_search_id` to the MusicBrainz `youtube_id`. It only reads the database and writes a results file, so it can't conflict with the Last.fm job. `scripts/apply-youtube-ids.mjs` then saves the results to `songs.youtube_search_id`, in a job that runs after both. If YouTube challenges it, it stops: never add cookies, sign-in or anything else to get past that. `YOUTUBE_API_KEY` is a Windows user env var and a GitHub repo secret; it has 100 searches a day and 10,000 units a day for `videos.list`, at about 1 unit per 50 videos. The script runs 4 searches at a time and stops at 800 units a run, which stays under the daily limit at 12 runs a day. On GitHub's runners, 8 got 403s from YouTube within minutes, so a local test doesn't predict the limit there. 4 showed no challenges, but those runs predate the error logging, so check the "Errors this run" line before going higher.
- `.github/workflows/import-musicbrainz.yml` runs monthly and on demand. It streams MusicBrainz's database dump and runs `scripts/import-musicbrainz.mjs`, which fills `songs.release_year`, `songs.youtube_id` and `songs.spotify_id` with no API calls. It only writes fields that are empty, so a saved value is never changed or cleared. Use the dump, not the MusicBrainz API, for bulk data: the API allows one request per second per IP.
- `.github/workflows/build-similar.yml` runs weekly and on demand (optional `songs` input, comma-separated `Artist - Song` or titles). It runs `scripts/export-similar.mjs`, which only reads the database, and `scripts/merge-similar.mjs`, for the site's "Like this song?" button. For each song with 3+ listeners, it finds the songs its listeners also listen to or love, with at least 3 listeners in common and at most 3 per artist, and writes the top 20 to `gh-pages:data/similar/` (`NNN.json` files, split by song ID, plus `manifest.json`). They hold song IDs and counts of shared listeners only. Results are calculated ahead of time because the browser can't read the database.
- **The only unencrypted data is `gh-pages:data/songs/` and `gh-pages:data/similar/`.** `data/songs/` is one flat, deliberately unnormalized table (`artist`, `song`, `genres`, `listeners`, `plays`, `loved_by`, `year`, `youtube_id`, `spotify_id`, `id`) rebuilt from the database and split into `part-NNN.json` files of about 10 MB, listed in `manifest.json`. The website loads them all and joins them. It holds aggregates only: never add usernames, profiles or per-user rows. Songs need at least 2 listeners. `genres` come from an allowlist in `export-songs.mjs`, using the song's own tags, or its artist's when it has none. Everything else stays encrypted.
- Song data is normalized. Tables: `artists`, `songs` (each song stored once), `periods`, `user_songs` (user → song, by ID, with rank and plays), `user_song_stats` (per user and period: play totals, top song and artist, artist concentration, overlap between the two periods, `similarity_to_me`), `song_runs`. Views with readable names: `user_songs_named`, `song_stats`.
- The repo is public, so Actions logs are too: the scripts log counts and errors, never usernames or keys. Errors go through `scripts/error-log.mjs` (`logError`, `scrub`), which prints the first 20 of each kind and a total per kind at the end. `lastfm-client.mjs` logs every Last.fm error as its code and a fixed description, so each script doesn't have to. It never prints Last.fm's own message or the request's params, which could hold a username. Those go in the encrypted database's `error_logs` table (one column, `log`: time, request params, outcome and Last.fm's message), for each request that ends in an error. The YouTube search only reads the database, so its errors are only in the Actions log. Never export or print this table in a workflow.

## Querying the data

The data isn't in the working tree, and a local copy goes stale after every workflow run. To answer any question about it, always download the latest copy from the `database` release first, then query a decrypted copy:

1. **Download and decrypt it** into a temp folder outside the repo. In the Bash tool:
   ```bash
   TMP="<scratchpad or temp folder>"
   node scripts/release-store.mjs download "$TMP/enc"
   export LAST_FM_AGE_IDENTITY="$(grep '^AGE-SECRET-KEY-' "$HOME/.last-fm-new-music-finder.age.key")"
   node --no-warnings scripts/decrypt.mjs "$TMP/enc/users.db.age" "$TMP/users.db"
   ```
   Pass the name without the number to `decrypt.mjs`; it joins any parts itself.
2. **Query it read-only with SQL** from a small script in that temp folder, using `node:sqlite` (the `sqlite3` CLI may not be installed):
   ```js
   import { DatabaseSync } from "node:sqlite";
   const db = new DatabaseSync(process.argv[2], { readOnly: true });
   console.log(db.prepare("SELECT artist, song, listeners_in_sample FROM song_stats WHERE period = ? ORDER BY listeners_in_sample DESC LIMIT 10").all("overall"));
   ```
   Start with the `song_stats` and `user_songs_named` views, which have readable names. Check row counts and `song_runs` so answers can say how much data they cover.
3. **Delete the decrypted copy when finished,** and never commit it or print the private key. The plaintext contains other users' profile data, so don't publish it either.

The database has no genre data. For genre questions, use Last.fm's `artist.getTopTags` and say that the label comes from artist tags, not from the song.

## Rate limits

Last.fm can suspend the API key for exceeding its limits. **Every Last.fm request must go through `scripts/lastfm-client.mjs`; never call the API with a separate `fetch`.** The client caps requests at 4 per second, and each rate-limit response (error 29 or HTTP 429) pauses all requests for longer and halves the speed. Three in a row with no success stops the script and the rest of the workflow run, and the run ends red. Don't retry a run stopped this way without finding out why it happened. Running scripts locally uses the same key as the workflows, so avoid doing it during a run.

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
