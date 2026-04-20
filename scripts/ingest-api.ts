import pg from "pg";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

const API_BASE = "https://open.canada.ca/data/api/action/datastore_search";
const PAGE_SIZE = 32000;

interface ResourceDef {
  id: string;
  name: string;
  table: string;
  columns: string[];
  fieldMap: Record<string, string>; // API field name -> DB column name
}

const RESOURCES: ResourceDef[] = [
  {
    id: "fac950c0-00d5-4ec1-a4d3-9cbebf98a305",
    name: "contracts",
    table: "contracts",
    columns: ["vendor_name", "contract_value", "original_value", "amendment_value", "solicitation_procedure", "owner_org_title", "contract_date", "commodity_type", "description_en", "instrument_type", "reference_number"],
    fieldMap: { vendor_name: "vendor_name", contract_value: "contract_value", original_value: "original_value", amendment_value: "amendment_value", solicitation_procedure: "solicitation_procedure", owner_org_title: "owner_org_title", contract_date: "contract_date", commodity_type: "commodity_type", description_en: "description_en", instrument_type: "instrument_type", reference_number: "reference_number" },
  },
  {
    id: "1d15a62f-5656-49ad-8c88-f40ce689d831",
    name: "grants",
    table: "grants",
    columns: ["recipient_legal_name", "recipient_business_number", "agreement_value", "agreement_type", "owner_org_title", "prog_name_en", "recipient_province", "recipient_city", "recipient_type", "agreement_start_date", "agreement_end_date", "description_en"],
    fieldMap: { recipient_legal_name: "recipient_legal_name", recipient_business_number: "recipient_business_number", agreement_value: "agreement_value", agreement_type: "agreement_type", owner_org_title: "owner_org_title", prog_name_en: "prog_name_en", recipient_province: "recipient_province", recipient_city: "recipient_city", recipient_type: "recipient_type", agreement_start_date: "agreement_start_date", agreement_end_date: "agreement_end_date", description_en: "description_en" },
  },
  {
    id: "694fdc72-eae4-4ee0-83eb-832ab7b230e3",
    name: "t3010_id",
    table: "t3010_id",
    columns: ["bn", "legal_name", "account_name", "category", "designation", "address", "city", "province", "postal_code"],
    fieldMap: { BN: "bn", "Legal Name": "legal_name", "Account Name": "account_name", Category: "category", Designation: "designation", "Address Line 1": "address", City: "city", Province: "province", "Postal Code": "postal_code" },
  },
  {
    id: "e545170c-3689-4833-b2a8-e9e83100ab59",
    name: "t3010_financial",
    table: "t3010_financial",
    columns: ["bn", "total_revenue", "total_expenditure", "gov_funding_federal", "gov_funding_provincial", "gov_funding_other", "compensation", "mgmt_admin_exp", "raw_fields"],
    fieldMap: { BN: "bn", "4200": "total_revenue", "5100": "total_expenditure", "4120": "gov_funding_federal", "4130": "gov_funding_provincial", "4140": "gov_funding_other", "4540": "compensation", "5010": "mgmt_admin_exp" },
  },
  {
    id: "3eb35dcd-9b0c-4ae9-a45c-e5e481567c23",
    name: "t3010_directors",
    table: "t3010_directors",
    columns: ["bn", "last_name", "first_name", "initials", "position", "at_arms_length", "start_date", "end_date", "fpe"],
    fieldMap: { BN: "bn", "Last Name": "last_name", "First Name": "first_name", Initials: "initials", Position: "position", "At Arm's Length": "at_arms_length", "Start Date": "start_date", "End Date": "end_date", FPE: "fpe" },
  },
  {
    id: "e945d3ac-ce8c-40c9-a322-47f477d6a8de",
    name: "t3010_transfers",
    table: "t3010_transfers",
    columns: ["donor_bn", "donee_bn", "donee_name", "total_gifts", "associated", "city", "province"],
    fieldMap: { BN: "donor_bn", "Donee BN": "donee_bn", "Donee Name": "donee_name", "Total Gifts": "total_gifts", Associated: "associated", City: "city", Province: "province" },
  },
  {
    id: "37fe5088-b30c-4713-9a42-5a3e7e08fcb0",
    name: "t3010_compensation",
    table: "t3010_compensation",
    columns: ["bn", "ft_employees", "pt_employees", "raw_fields"],
    fieldMap: { BN: "bn", "370": "ft_employees", "380": "pt_employees" },
  },
  {
    id: "1f16eb1b-cc03-4c95-a81c-0fdc0722c5ee",
    name: "t3010_programs",
    table: "t3010_programs",
    columns: ["bn", "program_type", "description"],
    fieldMap: { BN: "bn", "Program Type": "program_type", Description: "description" },
  },
  {
    id: "4e4db232-f5e8-43c7-b8b2-439eb7d55475",
    name: "wrongdoing",
    table: "wrongdoing",
    columns: ["fiscal_year", "quarter", "owner_org", "owner_org_title", "raw_fields"],
    fieldMap: { fiscal_year: "fiscal_year", quarter: "quarter", owner_org: "owner_org", owner_org_title: "owner_org_title" },
  },
];

function cleanVal(v: unknown): string | null {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  return String(v);
}

function mapRecord(record: Record<string, unknown>, resource: ResourceDef): (string | null)[] {
  const result: (string | null)[] = [];
  for (const col of resource.columns) {
    if (col === "raw_fields") {
      // Collect all numeric-keyed fields as JSON
      const raw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) {
        if (/^\d{3,4}$/.test(k)) raw[k] = v;
      }
      result.push(Object.keys(raw).length > 0 ? JSON.stringify(raw) : null);
    } else if (col === "address" && resource.name === "t3010_id") {
      const a1 = cleanVal(record["Address Line 1"]) ?? "";
      const a2 = cleanVal(record["Address Line 2"]) ?? "";
      result.push([a1, a2].filter(Boolean).join(", ") || null);
    } else {
      // Find the API field name for this DB column
      const apiField = Object.entries(resource.fieldMap).find(([, dbCol]) => dbCol === col)?.[0];
      result.push(apiField ? cleanVal(record[apiField]) : null);
    }
  }
  return result;
}

async function fetchPage(resourceId: string, offset: number, fields?: string[]): Promise<{ records: Record<string, unknown>[]; total: number }> {
  const params = new URLSearchParams({
    resource_id: resourceId,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (fields) params.set("fields", fields.join(","));

  const res = await fetch(`${API_BASE}?${params}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const body = await res.json() as { success: boolean; result: { records: Record<string, unknown>[]; total: number } };
  if (!body.success) throw new Error("API returned failure");
  return body.result;
}

async function insertBatch(client: pg.Client, table: string, cols: string[], rows: (string | null)[][]): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = rows.map(
    (row, ri) => `(${row.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(", ")})`,
  );
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${placeholders.join(", ")}`;
  await client.query(sql, rows.flat());
}

async function loadResource(resource: ResourceDef, client: pg.Client): Promise<number> {
  const firstPage = await fetchPage(resource.id, 0);
  const total = firstPage.total;
  const pages = Math.ceil(total / PAGE_SIZE);
  console.log(`  ${resource.name}: ${total.toLocaleString()} records (${pages} pages)`);

  let loaded = 0;
  const BATCH_SIZE = 500;

  for (let page = 0; page < pages; page++) {
    const data = page === 0 ? firstPage : await fetchPage(resource.id, page * PAGE_SIZE);
    let batch: (string | null)[][] = [];

    for (const record of data.records) {
      batch.push(mapRecord(record, resource));
      loaded++;

      if (batch.length >= BATCH_SIZE) {
        await insertBatch(client, resource.table, resource.columns, batch);
        batch = [];
      }
    }

    if (batch.length > 0) {
      await insertBatch(client, resource.table, resource.columns, batch);
    }

    if ((page + 1) % 5 === 0 || page === pages - 1) {
      console.log(`    page ${page + 1}/${pages} (${loaded.toLocaleString()} rows)`);
    }
  }

  return loaded;
}

async function createIndexes(client: pg.Client): Promise<void> {
  console.log("\nCreating indexes...");
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_contracts_vendor ON contracts (vendor_name)",
    "CREATE INDEX IF NOT EXISTS idx_contracts_solicitation ON contracts (solicitation_procedure)",
    "CREATE INDEX IF NOT EXISTS idx_contracts_commodity ON contracts (commodity_type)",
    "CREATE INDEX IF NOT EXISTS idx_contracts_dept ON contracts (owner_org_title)",
    "CREATE INDEX IF NOT EXISTS idx_contracts_value ON contracts (contract_value)",
    "CREATE INDEX IF NOT EXISTS idx_grants_recipient ON grants (recipient_legal_name)",
    "CREATE INDEX IF NOT EXISTS idx_grants_bn ON grants (recipient_business_number)",
    "CREATE INDEX IF NOT EXISTS idx_grants_type ON grants (recipient_type)",
    "CREATE INDEX IF NOT EXISTS idx_grants_dept ON grants (owner_org_title)",
    "CREATE INDEX IF NOT EXISTS idx_grants_value ON grants (agreement_value)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_id_bn ON t3010_id (bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_id_name ON t3010_id USING gin (to_tsvector('english', legal_name))",
    "CREATE INDEX IF NOT EXISTS idx_t3010_fin_bn ON t3010_financial (bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_dir_bn ON t3010_directors (bn)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_dir_name ON t3010_directors (last_name, first_name)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_dir_fpe ON t3010_directors (fpe)",
    "CREATE INDEX IF NOT EXISTS idx_t3010_dir_end_date ON t3010_directors (end_date) WHERE end_date IS NOT NULL",
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
  console.log("=== OpenGov ETL: API Pagination to PostgreSQL ===\n");

  const client = new pg.Client(DB_URL);
  await client.connect();
  console.log("Connected to PostgreSQL.\n");

  // Truncate
  console.log("Clearing existing data...");
  for (const r of RESOURCES) {
    await client.query(`TRUNCATE TABLE ${r.table} RESTART IDENTITY`);
  }

  // Load each resource
  console.log("\nLoading data via CKAN API pagination...\n");
  let totalRows = 0;
  for (const resource of RESOURCES) {
    const start = Date.now();
    try {
      const count = await loadResource(resource, client);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  => ${resource.name}: ${count.toLocaleString()} rows loaded (${elapsed}s)\n`);
      totalRows += count;
    } catch (e) {
      console.error(`  ERROR loading ${resource.name}: ${(e as Error).message}`);
    }
  }

  console.log(`\nTotal: ${totalRows.toLocaleString()} rows loaded.`);

  // Drop staging tables if they exist
  await client.query("DROP TABLE IF EXISTS contracts_staging");
  await client.query("DROP TABLE IF EXISTS grants_staging");

  await createIndexes(client);

  // Refresh materialized views (if they exist)
  await refreshMaterializedViews(client);

  // Final verification
  console.log("\nVerifying...");
  for (const r of RESOURCES) {
    const res = await client.query(`SELECT COUNT(*) FROM ${r.table}`);
    console.log(`  ${r.table}: ${parseInt(res.rows[0].count).toLocaleString()} rows`);
  }

  await client.end();
  console.log("\n=== ETL Complete ===");
}

async function refreshMaterializedViews(client: pg.Client): Promise<void> {
  console.log("\nRefreshing materialized views...");
  const mvRes = await client.query(
    `SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' ORDER BY matviewname`
  );
  if (mvRes.rows.length === 0) {
    console.log("  No materialized views found. Run scripts/optimize-db.ts to create them.");
    return;
  }
  for (const row of mvRes.rows) {
    const name = row.matviewname;
    const start = Date.now();
    try {
      await client.query(`REFRESH MATERIALIZED VIEW ${name}`);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  ✅ ${name} (${elapsed}s)`);
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`  ❌ ${name}: ${(e as Error).message.substring(0, 80)} (${elapsed}s)`);
    }
  }
}

main().catch((err) => {
  console.error("ETL failed:", err);
  process.exit(1);
});
