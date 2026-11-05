// How the Last.fm scripts rank users by activity. user.getFriends reports playcount as 0, so total listens come from
// user.getInfo instead (fetch-user-info.mjs), in their own columns that crawl-friends.mjs doesn't overwrite.

export function addProfileColumns(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  const wanted = ["total_plays INTEGER", "total_artists INTEGER", "total_tracks INTEGER", "total_albums INTEGER", "profile_fetched_at TEXT", "profile_error TEXT"];
  for (const column of wanted) {
    if (!columns.includes(column.split(" ")[0])) db.exec(`ALTER TABLE users ADD COLUMN ${column}`);
  }
}

// A WITH clause for "friend_counts (name, n)": the friends we've seen for each user, in either direction.
export const FRIEND_COUNTS = `
  friend_counts (name, n) AS (
    SELECT a, count(*) FROM (SELECT user AS a, friend AS b FROM friendships UNION SELECT friend, user FROM friendships)
    GROUP BY a COLLATE NOCASE
  )`;

// Join with: users u LEFT JOIN friend_counts f ON f.name = u.name COLLATE NOCASE
// friends_total is the real count, but only crawled users have one.
export const FRIENDS = "MAX(COALESCE(u.friends_total, 0), COALESCE(f.n, 0))";

// Average listens a day since the account was made. Unlike the total, it doesn't favor old accounts that went quiet.
// An account counts as at least 30 days old, so a new one that imported its history doesn't top the list.
export const PLAYS_PER_DAY = "(u.total_plays * 86400.0 / MAX(unixepoch() - u.registered_at, 30 * 86400))";

// Sustained for years, this many a day is probably a bot or an automated account. A judgment call: it isn't drawn from
// the data, so fetch-user-info.mjs logs how many users pass it. They're only moved back in the queue, never skipped.
export const LIKELY_BOT_PLAYS_PER_DAY = 300;

// Best first. Users with no listen count yet go after those with one, sorted by friends, then likely bots, then users
// with no listens or a failed lookup.
export const ACTIVITY_ORDER = `
  CASE WHEN u.profile_fetched_at IS NOT NULL AND COALESCE(u.total_plays, 0) = 0 THEN 2
       WHEN ${PLAYS_PER_DAY} >= ${LIKELY_BOT_PLAYS_PER_DAY} THEN 1
       ELSE 0 END,
  ${PLAYS_PER_DAY} DESC,
  ${FRIENDS} DESC,
  random()`;
