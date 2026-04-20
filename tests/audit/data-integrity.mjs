#!/usr/bin/env node
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 15000,
});

const failures = [];
const passes = [];

async function check(name, fn) {
  try {
    const r = await fn();
    if (r?.ok === false) failures.push({ name, detail: r.detail ?? "" });
    else passes.push({ name, detail: r?.detail ?? "" });
  } catch (e) {
    failures.push({ name, detail: `exception: ${e?.message ?? e}` });
  }
}

async function q(sql) {
  const r = await pool.query(sql);
  return r.rows;
}

const rowChecks = [
  { table: "contracts",          min: 1_000_000 },
  { table: "grants",             min: 1_000_000 },
  { table: "t3010_id",           min: 80_000 },
  { table: "t3010_financial",    min: 80_000 },
  { table: "t3010_directors",    min: 500_000 },
  { table: "t3010_transfers",    min: 300_000 },
  { table: "t3010_compensation", min: 40_000 },
  { table: "t3010_programs",     min: 80_000 },
];
for (const r of rowChecks) {
  await check(`rowcount: ${r.table} >= ${r.min.toLocaleString()}`, async () => {
    const rows = await q(`SELECT COUNT(*)::bigint AS n FROM ${r.table}`);
    const n = Number(rows[0].n);
    return { ok: n >= r.min, detail: `actual=${n.toLocaleString()}` };
  });
}

const mvChecks = [
  "mv_zombie_recipients", "mv_ghost_capacity", "mv_funding_stats",
  "mv_amendment_creep", "mv_vendor_concentration", "mv_related_parties",
  "mv_policy_buckets", "mv_duplicative_funding", "mv_contract_commodity",
  "mv_table_counts",
];
for (const mv of mvChecks) {
  await check(`mv_exists+nonempty: ${mv}`, async () => {
    const rows = await q(`SELECT COUNT(*)::bigint AS n FROM ${mv}`);
    const n = Number(rows[0].n);
    return { ok: n > 0, detail: `rows=${n.toLocaleString()}` };
  });
}

await check("benchmark: Mastercard Foundation NOT in mv_zombie_recipients", async () => {
  const rows = await q(
    `SELECT legal_name FROM mv_zombie_recipients WHERE UPPER(legal_name) LIKE '%MASTERCARD FOUNDATION%' LIMIT 1`,
  );
  return { ok: rows.length === 0, detail: rows.length ? rows[0].legal_name : "absent" };
});

await check("benchmark: Sobey Foundation NOT in mv_zombie_recipients", async () => {
  const rows = await q(
    `SELECT legal_name FROM mv_zombie_recipients WHERE UPPER(legal_name) LIKE '%SOBEY FOUNDATION%' LIMIT 1`,
  );
  return { ok: rows.length === 0, detail: rows.length ? rows[0].legal_name : "absent" };
});

for (const mv of ["mv_zombie_recipients", "mv_ghost_capacity"]) {
  await check(`benchmark: GOUVERNEMENT DU QUEBEC NOT in ${mv}`, async () => {
    const rows = await q(
      `SELECT legal_name FROM ${mv} WHERE UPPER(legal_name) LIKE '%GOUVERNEMENT%QU%BEC%' LIMIT 1`,
    );
    return { ok: rows.length === 0, detail: rows.length ? rows[0].legal_name : "absent" };
  });
}

await check("benchmark: S.U.C.C.E.S.S. has >=10 grant rows via BN prefix", async () => {
  const rows = await q(
    `WITH bn AS (
       SELECT DISTINCT substr(bn,1,9) AS p
       FROM t3010_id
       WHERE UPPER(legal_name) LIKE '%S.U.C.C.E.S.S.%'
     )
     SELECT COUNT(*)::bigint AS n FROM grants g
     WHERE g.recipient_business_number IS NOT NULL
       AND substr(g.recipient_business_number,1,9) IN (SELECT p FROM bn)`,
  );
  const n = Number(rows[0].n);
  return { ok: n >= 10, detail: `grant rows=${n}` };
});

await pool.end();

let exitCode = 0;
console.log("\n# Data Integrity Audit\n");
console.log(`Passes: ${passes.length}    Failures: ${failures.length}\n`);
if (passes.length) {
  console.log("## Passing checks\n");
  for (const p of passes) console.log(`- ${p.name}  (${p.detail})`);
  console.log("");
}
if (failures.length) {
  exitCode = 1;
  console.log("## Failing checks\n");
  for (const f of failures) console.log(`- ${f.name}  -- ${f.detail}`);
  console.log("");
}
process.exit(exitCode);
