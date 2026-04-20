import { createWriteStream, createReadStream } from "fs";
import { mkdir } from "fs/promises";
import { pipeline } from "stream/promises";
import { parse } from "csv-parse";
import pg from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

const DUMP_BASE = "https://open.canada.ca/data/datastore/dump";
const DATA_DIR = "./data/csv";

interface ResourceDef {
  id: string;
  name: string;
  table: string;
  mapper: (row: Record<string, string>) => Record<string, unknown> | null;
  columns: string[];
}

function num(v: string | undefined): number | null {
  if (!v || v === "None" || v === "") return null;
  const n = parseFloat(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(v: string | undefined): string | null {
  if (!v || v === "None" || v.length < 8) return null;
  return v.substring(0, 10);
}

const RESOURCES: ResourceDef[] = [
  {
    id: "fac950c0-00d5-4ec1-a4d3-9cbebf98a305",
    name: "contracts",
    table: "contracts",
    columns: [
      "vendor_name", "contract_value", "original_value", "amendment_value",
      "solicitation_procedure", "owner_org_title", "contract_date",
      "commodity_type", "description_en", "instrument_type", "reference_number",
    ],
    mapper: (r) => ({
      vendor_name: r.vendor_name || null,
      contract_value: num(r.contract_value),
      original_value: num(r.original_value),
      amendment_value: num(r.amendment_value),
      solicitation_procedure: r.solicitation_procedure || null,
      owner_org_title: r.owner_org_title || null,
      contract_date: dateOrNull(r.contract_date),
      commodity_type: r.commodity_type || null,
      description_en: r.description_en || null,
      instrument_type: r.instrument_type || null,
      reference_number: r.reference_number || null,
    }),
  },
  {
    id: "1d15a62f-5656-49ad-8c88-f40ce689d831",
    name: "grants",
    table: "grants",
    columns: [
      "recipient_legal_name", "recipient_business_number", "agreement_value",
      "agreement_type", "owner_org_title", "prog_name_en",
      "recipient_province", "recipient_city", "recipient_type",
      "agreement_start_date", "agreement_end_date", "description_en",
    ],
    mapper: (r) => ({
      recipient_legal_name: r.recipient_legal_name || null,
      recipient_business_number: r.recipient_business_number || null,
      agreement_value: num(r.agreement_value),
      agreement_type: r.agreement_type || null,
      owner_org_title: r.owner_org_title || null,
      prog_name_en: r.prog_name_en || null,
      recipient_province: r.recipient_province || null,
      recipient_city: r.recipient_city || null,
      recipient_type: r.recipient_type || null,
      agreement_start_date: dateOrNull(r.agreement_start_date),
      agreement_end_date: dateOrNull(r.agreement_end_date),
      description_en: r.description_en || null,
    }),
  },
  {
    id: "694fdc72-eae4-4ee0-83eb-832ab7b230e3",
    name: "t3010_id",
    table: "t3010_id",
    columns: ["bn", "legal_name", "account_name", "category", "designation", "address", "city", "province", "postal_code"],
    mapper: (r) => ({
      bn: r.BN || null,
      legal_name: r["Legal Name"] || null,
      account_name: r["Account Name"] || null,
      category: r.Category || null,
      designation: r.Designation || null,
      address: [r["Address Line 1"], r["Address Line 2"]].filter(Boolean).join(", ") || null,
      city: r.City || null,
      province: r.Province || null,
      postal_code: r["Postal Code"] || null,
    }),
  },
  {
    id: "e545170c-3689-4833-b2a8-e9e83100ab59",
    name: "t3010_financial",
    table: "t3010_financial",
    columns: ["bn", "total_revenue", "total_expenditure", "gov_funding_federal", "gov_funding_provincial", "gov_funding_other", "compensation", "mgmt_admin_exp", "raw_fields"],
    mapper: (r) => ({
      bn: r.BN || null,
      total_revenue: num(r["4200"]),
      total_expenditure: num(r["5100"]),
      gov_funding_federal: num(r["4120"]),
      gov_funding_provincial: num(r["4130"]),
      gov_funding_other: num(r["4140"]),
      compensation: num(r["4540"]),
      mgmt_admin_exp: num(r["5010"]),
      raw_fields: JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => /^\d{4}$/.test(k)))),
    }),
  },
  {
    id: "3eb35dcd-9b0c-4ae9-a45c-e5e481567c23",
    name: "t3010_directors",
    table: "t3010_directors",
    columns: ["bn", "last_name", "first_name", "position", "at_arms_length", "start_date"],
    mapper: (r) => ({
      bn: r.BN || null,
      last_name: r["Last Name"] || null,
      first_name: r["First Name"] || null,
      position: r.Position || null,
      at_arms_length: r["At Arm's Length"] || null,
      start_date: r["Start Date"] || null,
    }),
  },
  {
    id: "e945d3ac-ce8c-40c9-a322-47f477d6a8de",
    name: "t3010_transfers",
    table: "t3010_transfers",
    columns: ["donor_bn", "donee_bn", "donee_name", "total_gifts", "associated", "city", "province"],
    mapper: (r) => ({
      donor_bn: r.BN || null,
      donee_bn: r["Donee BN"] || null,
      donee_name: r["Donee Name"] || null,
      total_gifts: num(r["Total Gifts"]),
      associated: r.Associated || null,
      city: r.City || null,
      province: r.Province || null,
    }),
  },
  {
    id: "37fe5088-b30c-4713-9a42-5a3e7e08fcb0",
    name: "t3010_compensation",
    table: "t3010_compensation",
    columns: ["bn", "ft_employees", "pt_employees", "raw_fields"],
    mapper: (r) => ({
      bn: r.BN || null,
      ft_employees: num(r["370"]),
      pt_employees: num(r["380"]),
      raw_fields: JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => /^\d{3}$/.test(k)))),
    }),
  },
  {
    id: "1f16eb1b-cc03-4c95-a81c-0fdc0722c5ee",
    name: "t3010_programs",
    table: "t3010_programs",
    columns: ["bn", "program_type", "description"],
    mapper: (r) => ({
      bn: r.BN || null,
      program_type: r["Program Type"] || null,
      description: r.Description || null,
    }),
  },
  {
    id: "4e4db232-f5e8-43c7-b8b2-439eb7d55475",
    name: "wrongdoing",
    table: "wrongdoing",
    columns: ["fiscal_year", "quarter", "owner_org", "owner_org_title", "raw_fields"],
    mapper: (r) => ({
      fiscal_year: r.fiscal_year || null,
      quarter: r.quarter || null,
      owner_org: r.owner_org || null,
      owner_org_title: r.owner_org_title || null,
      raw_fields: JSON.stringify(r),
    }),
  },
];

async function downloadCSV(resource: ResourceDef): Promise<string> {
  const url = `${DUMP_BASE}/${resource.id}?format=csv`;
  const filePath = `${DATA_DIR}/${resource.name}.csv`;

  // Skip if file already exists and is non-empty
  try {
    const { stat } = await import("fs/promises");
    const s = await stat(filePath);
    if (s.size > 1000) {
      console.log(`  ${resource.name}: using cached file (${(s.size / 1024 / 1024).toFixed(0)}MB)`);
      return filePath;
    }
  } catch { /* file doesn't exist, download it */ }

  console.log(`  Downloading ${resource.name}...`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to download ${resource.name}: ${res.status}`);

  const writer = createWriteStream(filePath);
  await pipeline(res.body!, writer);
  console.log(`  Downloaded ${resource.name}`);
  return filePath;
}

async function loadCSV(resource: ResourceDef, filePath: string, client: pg.Client): Promise<number> {
  const cols = resource.columns;

  let count = 0;
  let errors = 0;
  const BATCH_SIZE = 500;
  let batch: unknown[][] = [];

  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_records_with_error: true,
      cast: false,
    }),
  );

  parser.on("skip", () => { errors++; });

  try {
    for await (const row of parser) {
      const mapped = resource.mapper(row as Record<string, string>);
      if (!mapped) continue;

      batch.push(cols.map((c) => (mapped as Record<string, unknown>)[c] ?? null));
      count++;

      if (batch.length >= BATCH_SIZE) {
        try {
          await insertBatch(client, resource.table, cols, batch);
        } catch (e) {
          console.error(`    Insert error in ${resource.name}: ${(e as Error).message?.substring(0, 120)}`);
        }
        batch = [];
        if (count % 100000 === 0) {
          console.log(`    ${resource.name}: ${count.toLocaleString()} rows...`);
        }
      }
    }
  } catch (e) {
    console.error(`    ${resource.name} stream error at row ${count}: ${(e as Error).message?.substring(0, 120)}`);
  }

  if (batch.length > 0) {
    try {
      await insertBatch(client, resource.table, cols, batch);
    } catch { /* skip final batch error */ }
  }

  if (errors > 0) {
    console.log(`    ${resource.name}: ${errors} rows skipped due to CSV errors`);
  }
  return count;
}

async function insertBatch(client: pg.Client, table: string, cols: string[], batch: unknown[][]): Promise<void> {
  if (batch.length === 0) return;

  const colList = cols.join(", ");
  const rows = batch.map(
    (row, ri) => `(${row.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(", ")})`,
  );
  const sql = `INSERT INTO ${table} (${colList}) VALUES ${rows.join(", ")}`;
  const params = batch.flat();

  await client.query(sql, params);
}

async function createIndexes(client: pg.Client): Promise<void> {
  console.log("\nCreating indexes...");
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_contracts_vendor ON contracts (vendor_name)",
    "CREATE INDEX IF NOT EXISTS idx_contracts_solicitation ON contracts (solicitation_procedure)",
    "CREATE INDEX IF NOT EXISTS idx_contracts_commodity ON contracts (commodity_type)",
    "CREATE INDEX IF NOT EXISTS idx_contracts_dept ON contracts (owner_org_title)",
    "CREATE INDEX IF NOT EXISTS idx_grants_recipient ON grants (recipient_legal_name)",
    "CREATE INDEX IF NOT EXISTS idx_grants_bn ON grants (recipient_business_number)",
    "CREATE INDEX IF NOT EXISTS idx_grants_type ON grants (recipient_type)",
    "CREATE INDEX IF NOT EXISTS idx_grants_dept ON grants (owner_org_title)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_id_bn ON t3010_id (bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_fin_bn ON t3010_financial (bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_dir_bn ON t3010_directors (bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_dir_name ON t3010_directors (last_name, first_name)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_xfer_donor ON t3010_transfers (donor_bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_xfer_donee ON t3010_transfers (donee_bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_comp_bn ON t3010_compensation (bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_prog_bn ON t3010_programs (bn)",
    "CREATE INDEX IF NOT EXISTS idx_embeddings_source ON entity_embeddings (source)",
    "CREATE INDEX IF NOT EXISTS idx_embeddings_bn ON entity_embeddings (bn)",
  ];

  for (const sql of indexes) {
    await client.query(sql);
  }
  console.log(`  Created ${indexes.length} indexes`);
}

async function main() {
  console.log("=== OpenGov ETL: Download & Load ===\n");

  await mkdir(DATA_DIR, { recursive: true });

  // Download all CSVs in parallel
  console.log("Step 1: Downloading CSVs from open.canada.ca...");
  const downloads = await Promise.all(
    RESOURCES.map(async (r) => {
      const path = await downloadCSV(r);
      return { resource: r, path };
    }),
  );
  console.log(`  All ${downloads.length} CSVs downloaded.\n`);

  // Connect to PostgreSQL
  const client = new pg.Client(DB_URL);
  await client.connect();
  console.log("Step 2: Connected to PostgreSQL.\n");

  // Truncate tables
  console.log("Step 3: Clearing existing data...");
  for (const r of RESOURCES) {
    await client.query(`TRUNCATE TABLE ${r.table} RESTART IDENTITY`);
  }
  console.log("  Tables cleared.\n");

  // Load each CSV
  console.log("Step 4: Loading CSVs into PostgreSQL...");
  let totalRows = 0;
  for (const { resource, path } of downloads) {
    const start = Date.now();
    const count = await loadCSV(resource, path, client);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ${resource.name}: ${count.toLocaleString()} rows (${elapsed}s)`);
    totalRows += count;
  }
  console.log(`  Total: ${totalRows.toLocaleString()} rows loaded.\n`);

  // Create indexes
  await createIndexes(client);

  // Verify counts
  console.log("\nStep 5: Verifying...");
  for (const r of RESOURCES) {
    const res = await client.query(`SELECT COUNT(*) FROM ${r.table}`);
    console.log(`  ${r.table}: ${parseInt(res.rows[0].count).toLocaleString()} rows`);
  }

  await client.end();
  console.log("\n=== ETL Complete ===");
}

main().catch((err) => {
  console.error("ETL failed:", err);
  process.exit(1);
});
