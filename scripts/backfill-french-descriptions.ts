/**
 * Backfill French-language columns on contracts and grants by joining on
 * existing English text (description_en, prog_name_en, etc.). This works
 * because federal open-data descriptions are largely templated: identical
 * English text reliably corresponds to identical French text across records.
 *
 * Strategy:
 *   1. ALTER TABLE to add nullable _fr columns.
 *   2. Stream the two CKAN resources, storing only the EN→FR mappings we
 *      need, deduped by the EN column (take the most common FR for each EN).
 *   3. UPDATE real tables from the lookup in one pass per column.
 *
 * This is intentionally idempotent: re-running only fills remaining NULL _fr
 * values, so you can pause and resume safely.
 */
import pg from "pg";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL is required");

const API_BASE = "https://open.canada.ca/data/api/action/datastore_search";
const PAGE_SIZE = 32000;

interface FrResource {
  ckanId: string;
  label: string;
  table: string;
  mappings: { en: string; fr: string; ckanEn?: string; ckanFr?: string }[];
}

const RESOURCES: FrResource[] = [
  {
    ckanId: "fac950c0-00d5-4ec1-a4d3-9cbebf98a305",
    label: "contracts",
    table: "contracts",
    mappings: [
      { en: "description_en", fr: "description_fr" },
    ],
  },
  {
    ckanId: "1d15a62f-5656-49ad-8c88-f40ce689d831",
    label: "grants",
    table: "grants",
    mappings: [
      { en: "description_en", fr: "description_fr" },
      { en: "prog_name_en", fr: "prog_name_fr" },
      { en: "prog_purpose_en", fr: "prog_purpose_fr", ckanEn: "prog_purpose_en" },
      { en: "agreement_title_en", fr: "agreement_title_fr", ckanEn: "agreement_title_en" },
    ],
  },
];

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s === "None" || s === "null") return null;
  return s;
}

async function fetchPage(
  resourceId: string,
  offset: number,
  fields: string[]
): Promise<{ records: Record<string, unknown>[]; total: number }> {
  const params = new URLSearchParams({
    resource_id: resourceId,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    fields: fields.join(","),
    sort: "_id asc",
  });
  const url = `${API_BASE}?${params}`;
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 120_000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`CKAN ${res.status} for ${resourceId}@${offset}`);
        const body = (await res.json()) as {
          success: boolean;
          result: { records: Record<string, unknown>[]; total: number };
        };
        if (!body.success) throw new Error("CKAN success=false");
        return body.result;
      } finally {
        clearTimeout(to);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(30_000, 2000 * Math.pow(2, attempt - 1));
        console.warn(
          `    CKAN fetch failed (attempt ${attempt}/${MAX_ATTEMPTS}) for ${resourceId}@${offset}: ${(e as Error).message}. Retrying in ${delay}ms…`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function addColumnIfMissing(
  client: pg.Client,
  table: string,
  column: string
): Promise<boolean> {
  const exists = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (exists.rowCount && exists.rowCount > 0) return false;
  await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} text`);
  return true;
}

async function ensureMissingColumnExists(client: pg.Client): Promise<void> {
  // Some CKAN grants fields are not yet in our table; add EN columns too where needed so
  // we have a join key. prog_purpose_en and agreement_title_en are not in our schema.
  const toAddOnGrants: string[] = ["prog_purpose_en", "agreement_title_en"];
  for (const col of toAddOnGrants) {
    const added = await addColumnIfMissing(client, "grants", col);
    if (added) console.log(`  [grants] added join column ${col}`);
  }
}

async function backfillResource(
  client: pg.Client,
  resource: FrResource
): Promise<void> {
  console.log(`\n=== ${resource.label} ===`);

  // 1. Ensure all target FR columns exist
  for (const m of resource.mappings) {
    const enAdded = await addColumnIfMissing(client, resource.table, m.en);
    if (enAdded) console.log(`  [${resource.table}] added ${m.en}`);
    const added = await addColumnIfMissing(client, resource.table, m.fr);
    if (added) console.log(`  [${resource.table}] added ${m.fr}`);
  }

  // Idempotent resume: skip mappings already >=95% filled.
  const mappingsNeeded: FrResource["mappings"] = [];
  for (const m of resource.mappings) {
    const r = await client.query(
      `SELECT COUNT(*) AS total, COUNT(${m.fr}) AS filled FROM ${resource.table}`
    );
    const total = Number(r.rows[0].total);
    const filled = Number(r.rows[0].filled);
    const pct = total ? (filled / total) * 100 : 0;
    if (pct >= 95) {
      console.log(`  ✅ ${resource.table}.${m.fr}: already ${pct.toFixed(1)}% filled — skip`);
    } else {
      console.log(`  ⏳ ${resource.table}.${m.fr}: ${pct.toFixed(1)}% filled — will backfill`);
      mappingsNeeded.push(m);
    }
  }
  if (mappingsNeeded.length === 0) {
    console.log(`  (nothing to do for ${resource.label})`);
    return;
  }

  // 2. Build in-memory lookup from CKAN (only for mappings we need)
  const fields = new Set<string>(["_id"]);
  for (const m of mappingsNeeded) {
    fields.add(m.ckanEn ?? m.en);
    fields.add(m.ckanFr ?? m.fr);
  }

  const lookups: Record<string, Map<string, Map<string, number>>> = {};
  for (const m of mappingsNeeded) {
    lookups[m.en] = new Map();
  }

  console.log("  Fetching EN→FR mappings from CKAN…");
  const firstPage = await fetchPage(resource.ckanId, 0, Array.from(fields));
  const total = firstPage.total;
  const pages = Math.ceil(total / PAGE_SIZE);
  console.log(`    ${total.toLocaleString()} records, ${pages} pages`);

  const processPage = (records: Record<string, unknown>[]) => {
    for (const rec of records) {
      for (const m of mappingsNeeded) {
        const en = clean(rec[m.ckanEn ?? m.en]);
        const fr = clean(rec[m.ckanFr ?? m.fr]);
        if (!en || !fr) continue;
        const bucket = lookups[m.en];
        let frCounts = bucket.get(en);
        if (!frCounts) {
          frCounts = new Map();
          bucket.set(en, frCounts);
        }
        frCounts.set(fr, (frCounts.get(fr) ?? 0) + 1);
      }
    }
  };

  processPage(firstPage.records);

  for (let p = 1; p < pages; p++) {
    const page = await fetchPage(resource.ckanId, p * PAGE_SIZE, Array.from(fields));
    processPage(page.records);
    if ((p + 1) % 5 === 0 || p === pages - 1) {
      const bucketSize = Object.values(lookups)
        .map((b) => b.size)
        .reduce((a, b) => a + b, 0);
      console.log(
        `    page ${p + 1}/${pages} (${bucketSize.toLocaleString()} distinct EN keys cached)`
      );
    }
  }

  // 3. For each mapping, push lookup into a temp table and UPDATE in chunks
  for (const m of mappingsNeeded) {
    const bucket = lookups[m.en];
    const rows: [string, string][] = [];
    for (const [en, frCounts] of bucket) {
      let bestFr = "";
      let bestCount = -1;
      for (const [fr, count] of frCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestFr = fr;
        }
      }
      rows.push([en, bestFr]);
    }
    console.log(
      `  ${m.en} → ${m.fr}: ${rows.length.toLocaleString()} distinct mappings`
    );
    if (rows.length === 0) continue;

    const tmpName = `tmp_${resource.table}_${m.en}`;
    // No PRIMARY KEY — some values (e.g. grants.description_en) exceed
    // Postgres' btree tuple limit (~2704 bytes). We already deduped in-memory.
    await client.query(
      `DROP TABLE IF EXISTS ${tmpName}; CREATE TEMP TABLE ${tmpName} (en text, fr text)`
    );

    const chunkSize = 1000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk
        .map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`)
        .join(", ");
      const params = chunk.flat();
      await client.query(
        `INSERT INTO ${tmpName}(en, fr) VALUES ${placeholders}`,
        params
      );
    }
    // Hash index on md5(en) avoids the btree length limit and still gives
    // the planner a fast equi-join probe.
    await client.query(
      `CREATE INDEX ON ${tmpName} USING hash (md5(en))`
    );
    await client.query(`ANALYZE ${tmpName}`);

    // Chunked UPDATE by id range to keep each statement short and the TCP
    // connection lively. Azure PG's idle-ish network path can otherwise
    // terminate a very long single statement mid-stream.
    const maxIdRow = await client.query(
      `SELECT COALESCE(MAX(id), 0) AS max_id FROM ${resource.table}`
    );
    const maxId = Number(maxIdRow.rows[0].max_id);
    const ID_STEP = 100_000;
    let totalUpdated = 0;
    const start = Date.now();
    for (let lo = 0; lo < maxId; lo += ID_STEP) {
      const hi = lo + ID_STEP;
      const res = await client.query(
        `UPDATE ${resource.table} t SET ${m.fr} = s.fr
         FROM ${tmpName} s
         WHERE t.${m.en} = s.en AND t.${m.fr} IS NULL AND t.id >= $1 AND t.id < $2`,
        [lo, hi]
      );
      totalUpdated += res.rowCount ?? 0;
      process.stdout.write(
        `\r    UPDATE ${resource.table}.${m.fr}: id ${lo.toLocaleString()}–${hi.toLocaleString()} → ${totalUpdated.toLocaleString()} rows updated`
      );
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n    ✅ ${resource.table}.${m.fr}: ${totalUpdated.toLocaleString()} rows (${elapsed}s)`);

    await client.query(`DROP TABLE ${tmpName}`);
  }
}

async function main() {
  const client = new pg.Client({
    connectionString: DB_URL,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Large operations — disable statement timeout just in case
    statement_timeout: 0,
    query_timeout: 0,
  });
  await client.connect();
  console.log("Connected to PostgreSQL.");

  // TCP keepalive at the query level too
  await client.query("SET statement_timeout = 0");
  await client.query("SET idle_in_transaction_session_timeout = 0");

  await ensureMissingColumnExists(client);

  for (const r of RESOURCES) {
    try {
      await backfillResource(client, r);
    } catch (e) {
      console.error(`  ❌ ${r.label} failed: ${(e as Error).message}`);
    }
  }

  // Summary
  console.log("\n=== Coverage summary ===");
  const checks = [
    "SELECT 'contracts.description_fr' as col, count(*) total, count(description_fr) filled, round(100.0 * count(description_fr) / count(*), 1) pct FROM contracts",
    "SELECT 'grants.description_fr' as col, count(*) total, count(description_fr) filled, round(100.0 * count(description_fr) / count(*), 1) pct FROM grants",
    "SELECT 'grants.prog_name_fr' as col, count(*) total, count(prog_name_fr) filled, round(100.0 * count(prog_name_fr) / count(*), 1) pct FROM grants",
    "SELECT 'grants.prog_purpose_fr' as col, count(*) total, count(prog_purpose_fr) filled, round(100.0 * count(prog_purpose_fr) / count(*), 1) pct FROM grants",
    "SELECT 'grants.agreement_title_fr' as col, count(*) total, count(agreement_title_fr) filled, round(100.0 * count(agreement_title_fr) / count(*), 1) pct FROM grants",
  ];
  for (const q of checks) {
    const r = await client.query(q);
    const row = r.rows[0];
    console.log(`  ${row.col}: ${row.filled}/${row.total} (${row.pct}%)`);
  }

  await client.end();
  console.log("\n=== Backfill complete ===");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
