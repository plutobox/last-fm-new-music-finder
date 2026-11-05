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
