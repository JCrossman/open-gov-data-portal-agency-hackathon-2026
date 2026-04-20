/**
 * Backfill initials, end_date, fpe into t3010_directors WITHOUT truncating.
 *
 * Strategy: stream all CKAN director records into a staging table, then
 * pair staging rows to live rows by the full natural key
 * (bn, last_name, first_name, start_date, position, at_arms_length) plus a
 * row_number() tiebreaker so duplicate filings get paired 1:1 rather than
 * collapsed.
 */
import pg from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

const RESOURCE_ID = "3eb35dcd-9b0c-4ae9-a45c-e5e481567c23";
const API_BASE = "https://open.canada.ca/data/api/action/datastore_search";
const PAGE_SIZE = 32000;

interface CkanRecord {
  BN?: string | null;
  FPE?: string | null;
  "Last Name"?: string | null;
  "First Name"?: string | null;
  Initials?: string | null;
  Position?: string | null;
  "At Arm's Length"?: string | null;
  "Start Date"?: string | null;
  "End Date"?: string | null;
}

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s === "None") return null;
  return s;
}

async function fetchPage(offset: number): Promise<{ records: CkanRecord[]; total: number }> {
  const params = new URLSearchParams({ resource_id: RESOURCE_ID, limit: String(PAGE_SIZE), offset: String(offset) });
  const url = `${API_BASE}?${params}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`CKAN ${res.status}`);
      const body = (await res.json()) as { success: boolean; result: { records: CkanRecord[]; total: number } };
      if (!body.success) throw new Error("CKAN returned failure");
      return body.result;
    } catch (e) {
      lastErr = e;
      const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1));
      console.warn(`    fetch offset=${offset} attempt ${attempt} failed: ${(e as Error).message}; retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function insertBatch(client: pg.Client, rows: (string | null)[][]): Promise<void> {
  if (rows.length === 0) return;
  const cols = 9;
  const placeholders = rows
    .map((row, ri) => `(${row.map((_, ci) => `$${ri * cols + ci + 1}`).join(", ")})`)
    .join(", ");
  const sql = `INSERT INTO t3010_directors_stage_backfill
      (bn, last_name, first_name, start_date, position, at_arms_length, fpe, initials, end_date)
      VALUES ${placeholders}`;
  await client.query(sql, rows.flat());
}

async function main() {
  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("Connected.");

  console.log("Creating staging table…");
  await client.query(`DROP TABLE IF EXISTS t3010_directors_stage_backfill`);
  await client.query(`
    CREATE TABLE t3010_directors_stage_backfill (
      bn TEXT,
      last_name TEXT,
      first_name TEXT,
      start_date TEXT,
      position TEXT,
      at_arms_length TEXT,
      fpe DATE,
      initials TEXT,
      end_date DATE
    )
  `);

  const first = await fetchPage(0);
  const total = first.total;
  const pages = Math.ceil(total / PAGE_SIZE);
  console.log(`CKAN total: ${total.toLocaleString()} (${pages} pages)`);

  const BATCH = 1000;
  let loaded = 0;
  for (let p = 0; p < pages; p++) {
    const data = p === 0 ? first : await fetchPage(p * PAGE_SIZE);
    let batch: (string | null)[][] = [];
    for (const r of data.records) {
      batch.push([
        clean(r.BN),
        clean(r["Last Name"]),
        clean(r["First Name"]),
        clean(r["Start Date"]),
        clean(r.Position),
        clean(r["At Arm's Length"]),
        clean(r.FPE),
        clean(r.Initials),
        clean(r["End Date"]),
      ]);
      loaded++;
      if (batch.length >= BATCH) {
        await insertBatch(client, batch);
        batch = [];
      }
    }
    if (batch.length > 0) await insertBatch(client, batch);
    if ((p + 1) % 2 === 0 || p === pages - 1) {
      console.log(`  page ${p + 1}/${pages} — ${loaded.toLocaleString()} rows staged`);
    }
  }

  console.log("\nIndexing staging…");
  await client.query(`CREATE INDEX ON t3010_directors_stage_backfill (bn, last_name, first_name, start_date)`);
  await client.query(`ANALYZE t3010_directors_stage_backfill`);

  const stageCount = await client.query(`SELECT COUNT(*) FROM t3010_directors_stage_backfill`);
  console.log(`  staging rows: ${stageCount.rows[0].count}`);

  console.log("\nRunning UPDATE with row_number pairing…");
  const t0 = Date.now();
  const upd = await client.query(`
    WITH s AS (
      SELECT bn, last_name, first_name, start_date, position, at_arms_length,
             fpe, initials, end_date,
             row_number() OVER (
               PARTITION BY bn, last_name, first_name, start_date, position, at_arms_length
               ORDER BY fpe NULLS LAST, end_date NULLS LAST, initials NULLS LAST
             ) AS rn
      FROM t3010_directors_stage_backfill
    ),
    t AS (
      SELECT id, bn, last_name, first_name, start_date, position, at_arms_length,
             row_number() OVER (
               PARTITION BY bn, last_name, first_name, start_date, position, at_arms_length
               ORDER BY id
             ) AS rn
      FROM t3010_directors
    ),
    pair AS (
      SELECT t.id, s.fpe, s.initials, s.end_date
      FROM t
      JOIN s ON
        t.bn IS NOT DISTINCT FROM s.bn
        AND t.last_name IS NOT DISTINCT FROM s.last_name
        AND t.first_name IS NOT DISTINCT FROM s.first_name
        AND t.start_date IS NOT DISTINCT FROM s.start_date
        AND t.position IS NOT DISTINCT FROM s.position
        AND t.at_arms_length IS NOT DISTINCT FROM s.at_arms_length
        AND t.rn = s.rn
    )
    UPDATE t3010_directors d
    SET fpe = pair.fpe,
        initials = pair.initials,
        end_date = pair.end_date
    FROM pair
    WHERE d.id = pair.id
  `);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  updated ${upd.rowCount?.toLocaleString()} rows in ${elapsed}s`);

  console.log("\nCreating indexes on new columns…");
  await client.query(`CREATE INDEX IF NOT EXISTS idx_t3010_dir_fpe ON t3010_directors (fpe)`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_t3010_dir_end_date ON t3010_directors (end_date) WHERE end_date IS NOT NULL`
  );

  console.log("\nCoverage:");
  const cov = await client.query(`
    SELECT COUNT(*)::bigint AS total,
           COUNT(initials)::bigint AS with_initials,
           COUNT(end_date)::bigint AS with_end_date,
           COUNT(fpe)::bigint AS with_fpe
    FROM t3010_directors
  `);
  console.table(cov.rows);

  console.log("\nSource-side non-null counts for reference:");
  const srcCov = await client.query(`
    SELECT COUNT(*)::bigint AS total,
           COUNT(initials)::bigint AS with_initials,
           COUNT(end_date)::bigint AS with_end_date,
           COUNT(fpe)::bigint AS with_fpe
    FROM t3010_directors_stage_backfill
  `);
  console.table(srcCov.rows);

  console.log("\nDropping staging table…");
  await client.query(`DROP TABLE t3010_directors_stage_backfill`);

  await client.end();
  console.log("Done.");
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
