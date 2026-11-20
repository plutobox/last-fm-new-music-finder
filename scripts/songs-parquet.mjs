// Writes the public song table as Parquet files, one band of listener counts per file, so the site can read only the
// files and row groups a query needs (e.g. the default "most listeners" view reads only the top band). The site
// reads them with hyparquet, a plain JavaScript reader, which decodes Snappy itself, hence Snappy rather than zstd.
// A band bigger than MAX_FILE_BYTES is split into numbered files. Within each file, rows run from most listeners to
// fewest, then most plays, so each row group's min/max stats let the site skip it.
import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

// [lowest, highest] listeners per band; null means no upper limit. Every song has at least 2 listeners.
export const BANDS = [[100, null], [20, 99], [10, 19], [5, 9], [3, 4], [2, 2]];
// Bumped whenever the files' layout changes, so the export rewrites files from an older layout.
export const PARQUET_FORMAT = 2;
const MAX_FILE_BYTES = "40MB"; // GitHub warns about files over 50 MB and refuses them over 100 MB
// Small enough that the default view reads little more than the songs it shows, big enough that a full scan isn't
// hundreds of requests.
const ROW_GROUP_SIZE = 20000;
export const PARQUET_FILE = /^listeners-[0-9a-z-]+\.parquet$/;

const sqlString = (s) => `'${s.replaceAll("'", "''")}'`;

// rows: arrays in the order of columns. Writes the files into outDir, replacing earlier ones, and returns the list
// for the manifest, from the most listeners to the fewest.
export async function writeSongParquet(rows, columns, outDir, workDir) {
  const jsonPath = path.join(workDir, "songs.ndjson");
  const stream = fs.createWriteStream(jsonPath);
  for (const row of rows) {
    const record = Object.fromEntries(columns.map((c, i) => [c, row[i]]));
    if (!stream.write(`${JSON.stringify(record)}\n`)) await new Promise((resolve) => stream.once("drain", resolve));
  }
  await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));

  const instance = await DuckDBInstance.create(path.join(workDir, "songs.duckdb"), {
    memory_limit: "4GB",
    threads: "2",
    temp_directory: path.join(workDir, "duckdb-tmp"),
    preserve_insertion_order: "true",
  });
  const con = await instance.connect();
  try {
    await con.run(`
      CREATE TABLE songs AS SELECT * FROM read_json(${sqlString(jsonPath)}, format = 'newline_delimited', columns = {
        artist: 'VARCHAR', song: 'VARCHAR', genres: 'VARCHAR[]', listeners: 'INTEGER', plays: 'INTEGER',
        loved_by: 'INTEGER', year: 'SMALLINT', youtube_id: 'VARCHAR', spotify_id: 'VARCHAR', id: 'INTEGER'
      })
    `);
    fs.rmSync(jsonPath);

    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (PARQUET_FILE.test(f)) fs.rmSync(path.join(outDir, f));

    const files = [];
    for (const [low, high] of BANDS) {
      const bandDir = path.join(workDir, `band-${low}`);
      const where = high === null ? `listeners >= ${low}` : `listeners BETWEEN ${low} AND ${high}`;
      await con.run(`
        COPY (SELECT ${columns.join(", ")} FROM songs WHERE ${where} ORDER BY listeners DESC, plays DESC, artist, song)
        TO ${sqlString(bandDir)} (FORMAT parquet, CODEC 'snappy', ROW_GROUP_SIZE ${ROW_GROUP_SIZE},
          FILE_SIZE_BYTES '${MAX_FILE_BYTES}', FILENAME_PATTERN 'part_{i}')
      `);
      // DuckDB numbers the split files in the order it wrote them.
      const written = fs.existsSync(bandDir)
        ? fs.readdirSync(bandDir).filter((f) => f.endsWith(".parquet"))
            .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
        : [];
      for (const [i, f] of written.entries()) {
        const name = `listeners-${low}-${high ?? "up"}-${String(i).padStart(3, "0")}.parquet`;
        fs.renameSync(path.join(bandDir, f), path.join(outDir, name));
        const reader = await con.runAndReadAll(`
          SELECT count(*)::INTEGER AS songs, min(listeners) AS min, max(listeners) AS max
          FROM read_parquet(${sqlString(path.join(outDir, name))})
        `);
        const stats = reader.getRowObjectsJS()[0];
        files.push({
          name,
          songs: stats.songs,
          bytes: fs.statSync(path.join(outDir, name)).size,
          listeners: { min: stats.min, max: stats.max },
        });
      }
    }
    return files;
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}
