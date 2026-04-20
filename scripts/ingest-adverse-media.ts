/**
 * scripts/ingest-adverse-media.ts
 *
 * Challenge 10 external adverse-media ingestion.
 *
 * Sources (both open, structured, federal or federally aggregated):
 *
 *   1. Global Affairs Canada (GAC) Consolidated Canadian Autonomous Sanctions List
 *      https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml
 *      Severity: `sanctions`
 *      Covers persons and entities listed under SEMA / JVCFOA. Primarily
 *      foreign targets; direct matches against Canadian funded entities are
 *      expected to be rare, which is itself a legitimate Challenge 10 finding
 *      (and why the UI must not imply a large-N result).
 *
 *   2. Canadian Nuclear Safety Commission — Administrative Monetary Penalties
 *      (current + historical) via the open.canada.ca CKAN DataStore:
 *        - current    : resource_id dccce602-bd4e-4e50-937b-2bf9540b5418
 *        - historical : resource_id e538ba9b-3c41-4503-9454-c7d31ce5fda6
 *      Severity: `regulatory_action`
 *      These are real federal enforcement actions against named licensees,
 *      which is exactly the kind of external signal Challenge 10 asks for.
 *
 * The script is modular: each source is a function `ingestX(client)` that
 * returns the number of rows upserted. Adding more sources later (Competition
 * Bureau, CBSA, RCMP listings, CRA revoked charities) is a matter of writing
 * another function and registering it in SOURCES.
 *
 * Matching strategy (after ingestion):
 *   - exact_bn           : if a bn_prefix_guess matches substr(bn,1,9) on
 *                          t3010_id or grants.recipient_business_number.
 *   - exact_name         : normalized name equality against
 *                          (a) t3010_id.legal_name
 *                          (b) distinct grants.recipient_legal_name
 *                          (c) distinct contracts.vendor_name
 *   - vector_cosine      : pgvector cosine similarity against
 *                          entity_embeddings (threshold >= 0.72 and top-1)
 *
 * Re-running the script is idempotent: UNIQUE(source_id, source_record_id)
 * prevents duplicate adverse_media rows, and matches are regenerated from
 * scratch on each run for whatever adverse_media is currently present.
 */

import pg from "pg";
import {
  ADVERSE_MEDIA_SEVERITIES,
  normalizeEntityName,
  type AdverseMediaRecord,
  type AdverseMediaSource,
} from "../lib/adverse-media";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=verify-full";

const GAC_SANCTIONS_URL =
  "https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml";

const CKAN_DATASTORE = "https://open.canada.ca/data/api/action/datastore_search";
const AMP_RESOURCE_CURRENT = "dccce602-bd4e-4e50-937b-2bf9540b5418";
const AMP_RESOURCE_HISTORICAL = "e538ba9b-3c41-4503-9454-c7d31ce5fda6";

const VECTOR_MATCH_THRESHOLD = 0.72; // cosine similarity ((1 - distance))

const SOURCES: AdverseMediaSource[] = [
  {
    id: "gac_sema",
    name: "Global Affairs Canada — Consolidated Canadian Autonomous Sanctions List",
    url: GAC_SANCTIONS_URL,
    category: "sanctions",
    description:
      "Persons and entities listed under SEMA/JVCFOA, maintained by Global Affairs Canada.",
  },
  {
    id: "amp_cnsc",
    name: "Canadian Nuclear Safety Commission — Administrative Monetary Penalties",
    url: "https://open.canada.ca/data/en/dataset/9ab69b34-17e9-4dd1-a4c6-98b8b1dd3b77",
    category: "regulatory_action",
    description:
      "Federal AMPs issued by the CNSC against licensees for violations of the NSCA and regulations.",
  },
];

// ---------- DDL (safe to run repeatedly) ----------

const DDL = `
  CREATE TABLE IF NOT EXISTS adverse_media_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT,
    category TEXT NOT NULL,
    description TEXT,
    last_fetched_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS adverse_media (
    id BIGSERIAL PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES adverse_media_sources(id),
    source_record_id TEXT,
    severity TEXT NOT NULL,
    entity_name_raw TEXT NOT NULL,
    entity_name_normalized TEXT NOT NULL,
    bn_prefix_guess TEXT,
    source_url TEXT,
    published_at DATE,
    summary TEXT,
    raw JSONB,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_adverse_media_src_rec
    ON adverse_media (source_id, source_record_id);
  CREATE INDEX IF NOT EXISTS idx_adverse_media_norm
    ON adverse_media (entity_name_normalized);
  CREATE INDEX IF NOT EXISTS idx_adverse_media_severity
    ON adverse_media (severity);
  CREATE INDEX IF NOT EXISTS idx_adverse_media_bn_prefix
    ON adverse_media (bn_prefix_guess);

  CREATE TABLE IF NOT EXISTS adverse_media_matches (
    id BIGSERIAL PRIMARY KEY,
    adverse_media_id BIGINT NOT NULL REFERENCES adverse_media(id) ON DELETE CASCADE,
    matched_source TEXT NOT NULL,
    matched_entity_name TEXT NOT NULL,
    matched_bn TEXT,
    match_method TEXT NOT NULL,
    confidence NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_am_matches_adv
    ON adverse_media_matches (adverse_media_id);
  CREATE INDEX IF NOT EXISTS idx_am_matches_name
    ON adverse_media_matches (matched_entity_name);
  CREATE INDEX IF NOT EXISTS idx_am_matches_bn
    ON adverse_media_matches (matched_bn);
  CREATE INDEX IF NOT EXISTS idx_am_matches_method
    ON adverse_media_matches (match_method);
`;

// ---------- Source 1: GAC Consolidated Sanctions (XML) ----------

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : null;
}

async function fetchGacSanctions(): Promise<AdverseMediaRecord[]> {
  const res = await fetch(GAC_SANCTIONS_URL);
  if (!res.ok) throw new Error(`GAC sanctions HTTP ${res.status}`);
  const xml = await res.text();
  const records: AdverseMediaRecord[] = [];

  const blocks = xml.match(/<record>[\s\S]*?<\/record>/g) ?? [];
  for (const block of blocks) {
    const country = extractTag(block, "Country");
    const entityName = extractTag(block, "Entity") ?? extractTag(block, "EntityName");
    const lastName = extractTag(block, "LastName");
    const givenName = extractTag(block, "GivenName");
    const schedule = extractTag(block, "Schedule");
    const item = extractTag(block, "Item");
    const dateListed = extractTag(block, "DateOfListing");
    const aliases = extractTag(block, "Aliases");
    const title = extractTag(block, "Title");

    // Prefer explicit entity; otherwise combine given+last for individuals.
    const nameParts = [givenName, lastName].filter(Boolean).join(" ").trim();
    const raw = (entityName && entityName.length > 0 ? entityName : nameParts).trim();
    if (!raw) continue;

    // Construct a stable synthetic id even if schedule/item are missing.
    const srcId = `sema|${schedule ?? ""}|${item ?? ""}|${raw}`.slice(0, 240);

    const summaryParts: string[] = [];
    if (country) summaryParts.push(`Country: ${country}`);
    if (schedule) summaryParts.push(`Schedule: ${schedule}`);
    if (item) summaryParts.push(`Item: ${item}`);
    if (title) summaryParts.push(`Title: ${title}`);
    if (aliases) summaryParts.push(`Aliases: ${aliases}`);

    records.push({
      source_id: "gac_sema",
      source_record_id: srcId,
      severity: "sanctions",
      entity_name_raw: raw,
      entity_name_normalized: normalizeEntityName(raw),
      bn_prefix_guess: null,
      source_url: GAC_SANCTIONS_URL,
      published_at: dateListed && /^\d{4}-\d{2}-\d{2}$/.test(dateListed) ? dateListed : null,
      summary: summaryParts.join(" | ") || null,
      raw: { country, entityName, lastName, givenName, schedule, item, aliases, title },
    });
  }

  return records;
}

// ---------- Source 2: CNSC AMPs (CKAN DataStore) ----------

interface CkanRecord {
  _id: number;
  [key: string]: unknown;
}

async function fetchCkanDatastore(resourceId: string): Promise<CkanRecord[]> {
  const all: CkanRecord[] = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const url = `${CKAN_DATASTORE}?resource_id=${resourceId}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CKAN HTTP ${res.status} for ${resourceId}`);
    const json = (await res.json()) as {
      success: boolean;
      result: { records: CkanRecord[]; total?: number };
    };
    if (!json.success) throw new Error(`CKAN unsuccessful for ${resourceId}`);
    const records = json.result.records ?? [];
    all.push(...records);
    if (records.length < limit) break;
    offset += limit;
    if (offset > 200000) break; // hard safety cap
  }
  return all;
}

function parseAmpDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Format: M/D/YYYY
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function ampRecordToAdverseMedia(r: CkanRecord, resourceId: string): AdverseMediaRecord | null {
  // Current and historical use slightly different headers; licensee column
  // exists in current, but the historical CSV omits it (only AMP identifier
  // describes the subject). We skip historical records with no named subject.
  const licensee = (r["Licensee"] as string | undefined) ?? "";
  const ampId = (r["AMP identifier"] as string | undefined) ?? (r["ss"] as string | undefined) ?? String(r._id);
  if (!licensee || licensee.trim() === "") return null;
  const division = (r["Issuing division"] as string | undefined) ?? "";
  const activity = (r["Licensed activity"] as string | undefined) ?? "";
  const provision = (r["Provision"] as string | undefined) ?? "";
  const penalty = (r["Penalty amount (CAD)"] as string | undefined) ?? "";
  const dateIssued = r["Date issued"];

  const summary =
    [
      `AMP ${ampId}`,
      division && `Division: ${division}`,
      activity && `Activity: ${activity}`,
      provision && `Provision: ${provision}`,
      penalty && `Penalty: $${penalty} CAD`,
    ]
      .filter(Boolean)
      .join(" | ") || null;

  return {
    source_id: "amp_cnsc",
    source_record_id: `${resourceId}|${ampId}`,
    severity: "regulatory_action",
    entity_name_raw: licensee.trim(),
    entity_name_normalized: normalizeEntityName(licensee),
    bn_prefix_guess: null,
    source_url: `https://open.canada.ca/data/en/dataset/9ab69b34-17e9-4dd1-a4c6-98b8b1dd3b77/resource/${resourceId}`,
    published_at: parseAmpDate(dateIssued),
    summary,
    raw: r as unknown,
  };
}

async function fetchCnscAmps(): Promise<AdverseMediaRecord[]> {
  const out: AdverseMediaRecord[] = [];
  for (const rid of [AMP_RESOURCE_CURRENT, AMP_RESOURCE_HISTORICAL]) {
    try {
      const rows = await fetchCkanDatastore(rid);
      for (const r of rows) {
        const rec = ampRecordToAdverseMedia(r, rid);
        if (rec) out.push(rec);
      }
    } catch (e) {
      console.error(`  ⚠️ AMP fetch failed for ${rid}: ${(e as Error).message}`);
    }
  }
  return out;
}

// ---------- Persistence ----------

async function upsertSources(client: pg.Client) {
  for (const s of SOURCES) {
    await client.query(
      `INSERT INTO adverse_media_sources (id, name, url, category, description, last_fetched_at)
       VALUES ($1,$2,$3,$4,$5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         url = EXCLUDED.url,
         category = EXCLUDED.category,
         description = EXCLUDED.description,
         last_fetched_at = NOW()`,
      [s.id, s.name, s.url ?? null, s.category, s.description ?? null],
    );
  }
}

async function upsertAdverseMedia(client: pg.Client, records: AdverseMediaRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  // Chunk to stay under bind-param limits.
  const chunkSize = 500;
  let inserted = 0;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((r, j) => {
      const b = j * 10;
      values.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10}::jsonb)`,
      );
      params.push(
        r.source_id,
        r.source_record_id,
        r.severity,
        r.entity_name_raw,
        r.entity_name_normalized,
        r.bn_prefix_guess,
        r.source_url,
        r.published_at,
        r.summary,
        JSON.stringify(r.raw ?? null),
      );
    });
    const res = await client.query(
      `INSERT INTO adverse_media
         (source_id, source_record_id, severity, entity_name_raw, entity_name_normalized,
          bn_prefix_guess, source_url, published_at, summary, raw)
       VALUES ${values.join(",")}
       ON CONFLICT (source_id, source_record_id) DO UPDATE SET
         entity_name_raw = EXCLUDED.entity_name_raw,
         entity_name_normalized = EXCLUDED.entity_name_normalized,
         severity = EXCLUDED.severity,
         source_url = EXCLUDED.source_url,
         published_at = EXCLUDED.published_at,
         summary = EXCLUDED.summary,
         raw = EXCLUDED.raw`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

// ---------- Matching ----------

async function runMatching(client: pg.Client): Promise<{ exact_bn: number; exact_name: number; vector: number }> {
  // Clear previous matches — matches derive entirely from current adverse_media.
  await client.query("TRUNCATE adverse_media_matches RESTART IDENTITY");

  // 1) exact_bn — only fires for records that have a bn_prefix_guess.
  const bnRes = await client.query(`
    WITH src AS (
      SELECT id, bn_prefix_guess FROM adverse_media
      WHERE bn_prefix_guess IS NOT NULL AND bn_prefix_guess <> ''
    ),
    hits AS (
      SELECT s.id AS adverse_media_id,
             'charity'::text AS matched_source,
             t.legal_name AS matched_entity_name,
             t.bn AS matched_bn
      FROM src s
      JOIN t3010_id t ON substr(t.bn, 1, 9) = s.bn_prefix_guess
      UNION ALL
      SELECT s.id,
             'grant_recipient',
             g.recipient_legal_name,
             g.recipient_business_number
      FROM src s
      JOIN grants g ON substr(g.recipient_business_number, 1, 9) = s.bn_prefix_guess
      WHERE g.recipient_legal_name IS NOT NULL
    )
    INSERT INTO adverse_media_matches
      (adverse_media_id, matched_source, matched_entity_name, matched_bn, match_method, confidence)
    SELECT DISTINCT adverse_media_id, matched_source, matched_entity_name, matched_bn, 'exact_bn', 1.0
    FROM hits
  `);

  // 2) exact_name — normalized-name equality against charities, grant
  //    recipients, and vendors. We compute the normalized name on the DB side
  //    using the same rules as normalizeEntityName (upper, strip punctuation,
  //    collapse whitespace, strip common legal suffixes). For the legal-suffix
  //    step we approximate with regexp_replace.
  //
  //    Any charity/grant/vendor whose normalized name equals the adverse-media
  //    normalized name counts as a match. Confidence fixed at 0.95 (exact
  //    match on a normalized-name basis, but without BN confirmation).
  const normSql = `
    regexp_replace(
      regexp_replace(
        regexp_replace(
          translate(upper($NAME), 'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÑÇ', 'AAAAAAEEEEIIIIOOOOOUUUUNC'),
          '[[:punct:]]', ' ', 'g'),
        '\\s+', ' ', 'g'),
      '\\s+(LIMITED|LIMITEE|LTD|LTEE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LLP|LLC|PLC|SOCIETY|ASSOCIATION|FOUNDATION)(\\s+(LIMITED|LIMITEE|LTD|LTEE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LLP|LLC|PLC|SOCIETY|ASSOCIATION|FOUNDATION))*\\s*$',
      '', 'g')
  `;

  // Pre-build trimmed versions for each table in a session-scoped TEMP table.
  // Using plain CREATE TEMP TABLE (no ON COMMIT DROP) so rows survive the
  // implicit per-statement transactions of node-postgres autocommit mode.
  await client.query("DROP TABLE IF EXISTS tmp_ent_norm");
  await client.query(`
    CREATE TEMP TABLE tmp_ent_norm (
      source TEXT, entity_name TEXT, bn TEXT, norm_name TEXT
    )
  `);

  await client.query(`
    INSERT INTO tmp_ent_norm (source, entity_name, bn, norm_name)
    SELECT 'charity', legal_name, bn,
           trim(${normSql.replace(/\$NAME/g, "legal_name")})
    FROM t3010_id
    WHERE legal_name IS NOT NULL AND legal_name <> ''
  `);
  await client.query(`
    INSERT INTO tmp_ent_norm (source, entity_name, bn, norm_name)
    SELECT 'grant_recipient', recipient_legal_name, MAX(recipient_business_number),
           trim(${normSql.replace(/\$NAME/g, "recipient_legal_name")})
    FROM grants
    WHERE recipient_legal_name IS NOT NULL AND recipient_legal_name <> ''
    GROUP BY recipient_legal_name
  `);
  await client.query(`
    INSERT INTO tmp_ent_norm (source, entity_name, bn, norm_name)
    SELECT 'vendor', vendor_name, NULL,
           trim(${normSql.replace(/\$NAME/g, "vendor_name")})
    FROM contracts
    WHERE vendor_name IS NOT NULL AND vendor_name <> ''
    GROUP BY vendor_name
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_tmp_ent_norm_name ON tmp_ent_norm (norm_name)");

  const nameRes = await client.query(`
    INSERT INTO adverse_media_matches
      (adverse_media_id, matched_source, matched_entity_name, matched_bn, match_method, confidence)
    SELECT DISTINCT a.id, e.source, e.entity_name, e.bn, 'exact_name', 0.95
    FROM adverse_media a
    JOIN tmp_ent_norm e ON e.norm_name = a.entity_name_normalized
    WHERE a.entity_name_normalized IS NOT NULL
      AND length(a.entity_name_normalized) >= 4
      AND NOT EXISTS (
        SELECT 1 FROM adverse_media_matches m
        WHERE m.adverse_media_id = a.id
          AND m.matched_source = e.source
          AND m.matched_entity_name = e.entity_name
      )
  `);

  // 3) vector_cosine — use existing entity_embeddings table + Azure OpenAI
  //    embedding of the adverse-media entity_name_raw. We do this in Node so
  //    we can reuse the same Azure credential path as generate-embeddings.ts.
  let vectorAdded = 0;
  if (process.env.SKIP_VECTORS !== "1") {
    try {
      vectorAdded = await runVectorMatching(client);
    } catch (e) {
      console.error(`  ⚠️ vector matching skipped: ${(e as Error).message.substring(0, 160)}`);
    }
  }

  return {
    exact_bn: bnRes.rowCount ?? 0,
    exact_name: nameRes.rowCount ?? 0,
    vector: vectorAdded,
  };
}

async function runVectorMatching(client: pg.Client): Promise<number> {
  const hasVector = await client.query(
    `SELECT 1 FROM pg_extension WHERE extname='vector'`,
  );
  if (hasVector.rowCount === 0) return 0;

  const hasEmbeddings = await client.query(
    `SELECT COUNT(*)::int AS n FROM entity_embeddings`,
  );
  if ((hasEmbeddings.rows[0]?.n ?? 0) === 0) return 0;

  // Which adverse_media rows still need a match at all? We only embed those
  // that don't already have an exact match to avoid burning API tokens.
  const pending = await client.query<{ id: number; name: string }>(`
    SELECT a.id, a.entity_name_raw AS name
    FROM adverse_media a
    WHERE NOT EXISTS (SELECT 1 FROM adverse_media_matches m WHERE m.adverse_media_id = a.id)
      AND length(a.entity_name_raw) >= 4
    ORDER BY a.id
  `);
  if (pending.rowCount === 0) return 0;

  // Lazy-load Azure Identity only if we need it.
  const { DefaultAzureCredential } = await import("@azure/identity");
  const AZURE_OPENAI_ENDPOINT =
    process.env.AZURE_OPENAI_ENDPOINT ?? (() => { throw new Error("AZURE_OPENAI_ENDPOINT env var is required"); })();
  const EMBEDDING_DEPLOYMENT = "text-embedding-3-small";
  const EMBEDDING_DIMENSIONS = 256;
  const API_VERSION = "2024-08-01-preview";
  const BATCH = 1024;

  const cred = new DefaultAzureCredential();
  let token = (await cred.getToken("https://cognitiveservices.azure.com/.default")).token;

  const names = pending.rows.map((r) => r.name);
  const ids = pending.rows.map((r) => r.id);
  const embeddings: number[][] = [];

  for (let i = 0; i < names.length; i += BATCH) {
    if (i > 0 && i % (BATCH * 20) === 0) {
      token = (await cred.getToken("https://cognitiveservices.azure.com/.default")).token;
    }
    const slice = names.slice(i, i + BATCH);
    const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=${API_VERSION}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: slice, dimensions: EMBEDDING_DIMENSIONS }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Embedding API ${res.status}: ${err.substring(0, 180)}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    for (const d of data.data) embeddings.push(d.embedding);
  }

  let added = 0;
  for (let i = 0; i < ids.length; i++) {
    const vec = `[${embeddings[i].join(",")}]`;
    const hit = await client.query<{
      source: string;
      entity_name: string;
      bn: string | null;
      sim: number;
    }>(
      `SELECT source, entity_name, bn,
              1 - (embedding <=> $1::vector) AS sim
       FROM entity_embeddings
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
      [vec],
    );
    const row = hit.rows[0];
    if (!row) continue;
    if (row.sim < VECTOR_MATCH_THRESHOLD) continue;
    const matchedSource =
      row.source === "charity"
        ? "charity"
        : row.source === "vendor"
          ? "vendor"
          : "grant_recipient";
    await client.query(
      `INSERT INTO adverse_media_matches
         (adverse_media_id, matched_source, matched_entity_name, matched_bn, match_method, confidence)
       VALUES ($1,$2,$3,$4,'vector_cosine',$5)`,
      [ids[i], matchedSource, row.entity_name, row.bn, row.sim],
    );
    added++;
  }
  return added;
}

// ---------- Main ----------

async function main() {
  const force = process.argv.includes("--force");
  const skipVectors = process.argv.includes("--skip-vectors");
  if (skipVectors) process.env.SKIP_VECTORS = "1";

  console.log("=== OpenGov Adverse-Media Ingest ===");
  console.log("Severity taxonomy:", ADVERSE_MEDIA_SEVERITIES.join(", "));
  console.log("");

  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 600000,
    query_timeout: 600000,
  });
  client.on("error", () => {});
  await client.connect();

  console.log("Applying DDL...");
  await client.query(DDL);
  await upsertSources(client);

  if (force) {
    console.log("  --force: truncating adverse_media + adverse_media_matches");
    await client.query("TRUNCATE adverse_media, adverse_media_matches RESTART IDENTITY CASCADE");
  }

  let total = 0;

  console.log("\n[1/2] Fetching GAC consolidated sanctions (XML)...");
  try {
    const recs = await fetchGacSanctions();
    console.log(`  Parsed ${recs.length.toLocaleString()} records from GAC SEMA`);
    const inserted = await upsertAdverseMedia(client, recs);
    console.log(`  Upserted ${inserted.toLocaleString()} rows into adverse_media`);
    total += inserted;
  } catch (e) {
    console.error(`  ❌ GAC SEMA fetch failed: ${(e as Error).message}`);
  }

  console.log("\n[2/2] Fetching CNSC AMPs (CKAN)...");
  try {
    const recs = await fetchCnscAmps();
    console.log(`  Parsed ${recs.length.toLocaleString()} records from CNSC AMP`);
    const inserted = await upsertAdverseMedia(client, recs);
    console.log(`  Upserted ${inserted.toLocaleString()} rows into adverse_media`);
    total += inserted;
  } catch (e) {
    console.error(`  ❌ CNSC AMP fetch failed: ${(e as Error).message}`);
  }

  const total_count = await client.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM adverse_media",
  );
  console.log(`\nadverse_media now has ${total_count.rows[0].n.toLocaleString()} total rows.`);

  console.log("\n[matching] Linking adverse-media records to funded entities...");
  if (skipVectors) {
    console.log("  --skip-vectors: vector matching will be skipped");
  }
  const matchStats = await runMatching(client);
  console.log(
    `  matches inserted: exact_bn=${matchStats.exact_bn}, exact_name=${matchStats.exact_name}, vector=${matchStats.vector}`,
  );

  const matchTotal = await client.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM adverse_media_matches",
  );
  console.log(`  adverse_media_matches now has ${matchTotal.rows[0].n.toLocaleString()} rows.`);

  console.log(`\n=== Done. Ingested/refreshed ${total.toLocaleString()} source rows. ===`);

  await client.end();
}

main().catch((err) => {
  console.error("Adverse-media ingest failed:", err);
  process.exit(1);
});
