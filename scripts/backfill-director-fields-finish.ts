/**
 * Finish the director backfill from an existing staging table in chunks.
 * Uses natural-key join with a supporting index — no window functions.
 * Duplicate-key collisions (same bn/last_name/first_name/start_date/position/
 * at_arms_length) are resolved non-deterministically by PG; acceptable given
 * duplicates reflect multi-year filings of the same director.
 */
import pg from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

async function main() {
  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("Connected.");

  // Ensure the join-support index exists on staging.
  console.log("Ensuring staging index…");
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_stage_backfill_key
       ON t3010_directors_stage_backfill
       (bn, last_name, first_name, start_date, position, at_arms_length)`
  );
  await client.query(`ANALYZE t3010_directors_stage_backfill`);

  const minmax = await client.query(
    `SELECT MIN(id)::bigint AS lo, MAX(id)::bigint AS hi FROM t3010_directors`
  );
  const lo = Number(minmax.rows[0].lo);
  const hi = Number(minmax.rows[0].hi);
  const CHUNK = 50_000;
  console.log(`id range ${lo}..${hi}, chunk ${CHUNK}`);

  let updated = 0;
  for (let start = lo; start <= hi; start += CHUNK) {
    const end = start + CHUNK - 1;
    const t0 = Date.now();
    const r = await client.query(
      `UPDATE t3010_directors d
         SET fpe = s.fpe, initials = s.initials, end_date = s.end_date
       FROM t3010_directors_stage_backfill s
       WHERE d.id BETWEEN $1 AND $2
         AND d.bn IS NOT DISTINCT FROM s.bn
         AND d.last_name IS NOT DISTINCT FROM s.last_name
         AND d.first_name IS NOT DISTINCT FROM s.first_name
         AND d.start_date IS NOT DISTINCT FROM s.start_date
         AND d.position IS NOT DISTINCT FROM s.position
         AND d.at_arms_length IS NOT DISTINCT FROM s.at_arms_length`,
      [start, end]
    );
    updated += r.rowCount ?? 0;
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  chunk ${start}..${end} → updated ${r.rowCount?.toLocaleString()} (total ${updated.toLocaleString()}) ${el}s`);
  }

  console.log("\nCreating indexes on new columns…");
  await client.query(`CREATE INDEX IF NOT EXISTS idx_t3010_dir_fpe ON t3010_directors (fpe)`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_t3010_dir_end_date ON t3010_directors (end_date) WHERE end_date IS NOT NULL`
  );

  console.log("\nCoverage:");
  const cov = await client.query(
    `SELECT COUNT(*)::bigint AS total,
            COUNT(initials)::bigint AS with_initials,
            COUNT(end_date)::bigint AS with_end_date,
            COUNT(fpe)::bigint AS with_fpe
     FROM t3010_directors`
  );
  console.table(cov.rows);

  console.log("\nSource-side non-null counts:");
  const sc = await client.query(
    `SELECT COUNT(*)::bigint AS total,
            COUNT(initials)::bigint AS with_initials,
            COUNT(end_date)::bigint AS with_end_date,
            COUNT(fpe)::bigint AS with_fpe
     FROM t3010_directors_stage_backfill`
  );
  console.table(sc.rows);

  console.log("\nDropping staging…");
  await client.query(`DROP TABLE t3010_directors_stage_backfill`);

  await client.end();
  console.log("Done.");
}

main().catch((e) => {
  console.error("Finish failed:", e);
  process.exit(1);
});
