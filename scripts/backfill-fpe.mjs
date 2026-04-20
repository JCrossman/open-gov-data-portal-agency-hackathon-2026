// Backfill t3010_financial.fpe from CKAN resource 694/e545 for every BN.
// Pages through the financial resource (has BN + FPE) in 32K chunks.
import pg from "pg";
const RES = "e545170c-3689-4833-b2a8-e9e83100ab59";
const LIMIT = 32000;
const DB = "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

const client = new pg.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
await client.connect();

await client.query(`CREATE TEMP TABLE fpe_stage (bn text PRIMARY KEY, fpe date)`);

let offset = 0;
let total = 0;
while (true) {
  const url = `https://open.canada.ca/data/api/3/action/datastore_search?resource_id=${RES}&limit=${LIMIT}&offset=${offset}&fields=BN,FPE`;
  const r = await fetch(url);
  const j = await r.json();
  const recs = j?.result?.records ?? [];
  if (recs.length === 0) break;
  // Group by BN, keep max FPE
  const map = new Map();
  for (const rec of recs) {
    const bn = rec.BN?.trim();
    const fpe = rec.FPE?.trim();
    if (!bn || !fpe) continue;
    const prev = map.get(bn);
    if (!prev || fpe > prev) map.set(bn, fpe);
  }
  const values = [...map.entries()];
  // Batch insert
  const CHUNK = 1000;
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK);
    const params = [];
    const placeholders = slice.map((_, k) => {
      params.push(slice[k][0], slice[k][1]);
      return `($${k*2+1}, $${k*2+2}::date)`;
    }).join(",");
    await client.query(`
      INSERT INTO fpe_stage(bn, fpe) VALUES ${placeholders}
      ON CONFLICT (bn) DO UPDATE SET fpe = GREATEST(fpe_stage.fpe, EXCLUDED.fpe)
    `, params);
  }
  total += recs.length;
  console.log(`offset=${offset} got=${recs.length} accum=${total} uniqueBNs=${map.size}`);
  if (recs.length < LIMIT) break;
  offset += LIMIT;
}

console.log("Staging rows:", (await client.query("SELECT COUNT(*) FROM fpe_stage")).rows[0].count);
const upd = await client.query(`
  UPDATE t3010_financial f SET fpe = s.fpe
  FROM fpe_stage s WHERE f.bn = s.bn AND (f.fpe IS DISTINCT FROM s.fpe)
`);
console.log("Updated rows:", upd.rowCount);
const nn = await client.query(`SELECT COUNT(*) FROM t3010_financial WHERE fpe IS NOT NULL`);
console.log("t3010_financial with fpe:", nn.rows[0].count);
await client.end();
