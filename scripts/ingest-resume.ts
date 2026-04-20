import pg from "pg";

// Resume loading for resources that failed or were partial
const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

const API_BASE = "https://open.canada.ca/data/api/action/datastore_search";

function cleanVal(v: unknown): string | null {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  return String(v);
}

async function fetchPage(resourceId: string, offset: number, limit: number): Promise<{ records: Record<string, unknown>[]; total: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const params = new URLSearchParams({
        resource_id: resourceId,
        limit: String(limit),
        offset: String(offset),
      });
      const res = await fetch(`${API_BASE}?${params}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        console.log(`      API ${res.status} at offset ${offset}, attempt ${attempt + 1}/3`);
        if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
        throw new Error(`API error ${res.status}`);
      }
      const body = await res.json() as { success: boolean; result: { records: Record<string, unknown>[]; total: number } };
      if (!body.success) throw new Error("API failure");
      return body.result;
    } catch (e) {
      if (attempt < 2) {
        console.log(`      Retry ${attempt + 2}/3 for offset ${offset}: ${(e as Error).message?.substring(0, 60)}`);
        await sleep(3000 * (attempt + 1));
      } else throw e;
    }
  }
  throw new Error("unreachable");
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function insertBatch(client: pg.Client, table: string, cols: string[], rows: (string | null)[][]): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = rows.map(
    (row, ri) => `(${row.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(", ")})`,
  );
  await client.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${placeholders.join(", ")}`,
    rows.flat(),
  );
}

async function resumeResource(
  client: pg.Client,
  name: string,
  resourceId: string,
  table: string,
  columns: string[],
  mapFn: (r: Record<string, unknown>) => (string | null)[],
  startOffset: number,
  pageSize: number,
): Promise<number> {
  const firstPage = await fetchPage(resourceId, 0, 1);
  const total = firstPage.total;
  const pages = Math.ceil((total - startOffset) / pageSize);
  console.log(`  ${name}: resuming from offset ${startOffset.toLocaleString()} of ${total.toLocaleString()} (${pages} pages of ${pageSize})`);

  let loaded = 0;

  for (let offset = startOffset; offset < total; offset += pageSize) {
    try {
      const data = await fetchPage(resourceId, offset, pageSize);
      let batch: (string | null)[][] = [];

      for (const record of data.records) {
        batch.push(mapFn(record));
        loaded++;
        if (batch.length >= 500) {
          await insertBatch(client, table, columns, batch);
          batch = [];
        }
      }
      if (batch.length > 0) {
        await insertBatch(client, table, columns, batch);
      }

      const page = Math.floor((offset - startOffset) / pageSize) + 1;
      if (page % 5 === 0 || offset + pageSize >= total) {
        console.log(`    ${name}: ${(startOffset + loaded).toLocaleString()} / ${total.toLocaleString()}`);
      }
    } catch (e) {
      console.error(`    ${name} failed at offset ${offset}: ${(e as Error).message?.substring(0, 80)}`);
      // Continue to next page instead of stopping entirely
      continue;
    }
  }

  return loaded;
}

async function main() {
  console.log("=== Resume ETL: Loading remaining data ===\n");

  const client = new pg.Client(DB_URL);
  await client.connect();

  // Check current counts
  for (const table of ["contracts", "grants", "t3010_compensation"]) {
    const res = await client.query(`SELECT COUNT(*) FROM ${table}`);
    console.log(`  ${table}: ${parseInt(res.rows[0].count).toLocaleString()} rows currently`);
  }

  // Resume contracts from offset 416000 with smaller page size
  const contractsLoaded = await resumeResource(
    client, "contracts",
    "fac950c0-00d5-4ec1-a4d3-9cbebf98a305",
    "contracts",
    ["vendor_name", "contract_value", "original_value", "amendment_value", "solicitation_procedure", "owner_org_title", "contract_date", "commodity_type", "description_en", "instrument_type", "reference_number"],
    (r) => [
      cleanVal(r.vendor_name), cleanVal(r.contract_value), cleanVal(r.original_value),
      cleanVal(r.amendment_value), cleanVal(r.solicitation_procedure), cleanVal(r.owner_org_title),
      cleanVal(r.contract_date), cleanVal(r.commodity_type), cleanVal(r.description_en),
      cleanVal(r.instrument_type), cleanVal(r.reference_number),
    ],
    416000, 10000, // smaller pages to avoid API timeout
  );
  console.log(`  contracts: +${contractsLoaded.toLocaleString()} new rows\n`);

  // Resume grants from offset 320000
  const grantsLoaded = await resumeResource(
    client, "grants",
    "1d15a62f-5656-49ad-8c88-f40ce689d831",
    "grants",
    ["recipient_legal_name", "recipient_business_number", "agreement_value", "agreement_type", "owner_org_title", "prog_name_en", "recipient_province", "recipient_city", "recipient_type", "agreement_start_date", "agreement_end_date", "description_en"],
    (r) => [
      cleanVal(r.recipient_legal_name), cleanVal(r.recipient_business_number),
      cleanVal(r.agreement_value), cleanVal(r.agreement_type), cleanVal(r.owner_org_title),
      cleanVal(r.prog_name_en), cleanVal(r.recipient_province), cleanVal(r.recipient_city),
      cleanVal(r.recipient_type), cleanVal(r.agreement_start_date), cleanVal(r.agreement_end_date),
      cleanVal(r.description_en),
    ],
    320000, 10000,
  );
  console.log(`  grants: +${grantsLoaded.toLocaleString()} new rows\n`);

  // Reload compensation (truncate first since it was partial with wrong types)
  await client.query("TRUNCATE t3010_compensation RESTART IDENTITY");
  const compLoaded = await resumeResource(
    client, "t3010_compensation",
    "37fe5088-b30c-4713-9a42-5a3e7e08fcb0",
    "t3010_compensation",
    ["bn", "ft_employees", "pt_employees", "raw_fields"],
    (r) => {
      const raw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) { if (/^\d{3}$/.test(k)) raw[k] = v; }
      return [
        cleanVal(r.BN), cleanVal(r["370"]), cleanVal(r["380"]),
        Object.keys(raw).length > 0 ? JSON.stringify(raw) : null,
      ];
    },
    0, 32000,
  );
  console.log(`  t3010_compensation: ${compLoaded.toLocaleString()} rows\n`);

  // Final verification
  console.log("Final counts:");
  for (const table of ["contracts", "grants", "t3010_id", "t3010_financial", "t3010_directors", "t3010_transfers", "t3010_compensation", "t3010_programs", "wrongdoing"]) {
    const res = await client.query(`SELECT COUNT(*) FROM ${table}`);
    console.log(`  ${table}: ${parseInt(res.rows[0].count).toLocaleString()}`);
  }

  await client.end();
  console.log("\n=== Resume Complete ===");
}

main().catch((err) => {
  console.error("Resume failed:", err);
  process.exit(1);
});
