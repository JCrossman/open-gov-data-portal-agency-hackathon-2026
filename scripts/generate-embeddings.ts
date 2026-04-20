import pg from "pg";
import { DefaultAzureCredential } from "@azure/identity";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=verify-full";

const AZURE_OPENAI_ENDPOINT =
  process.env.AZURE_OPENAI_ENDPOINT ?? (() => { throw new Error("AZURE_OPENAI_ENDPOINT env var is required"); })();
const EMBEDDING_DEPLOYMENT = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 256;
const BATCH_SIZE = 2048; // Max inputs per API call
const API_VERSION = "2024-08-01-preview";

async function getToken(): Promise<string> {
  const credential = new DefaultAzureCredential();
  const tokenResponse = await credential.getToken("https://cognitiveservices.azure.com/.default");
  return tokenResponse.token;
}

async function getEmbeddings(texts: string[], token: string): Promise<number[][]> {
  const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=${API_VERSION}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.data.map((d: { embedding: number[] }) => d.embedding);
}

interface EntityRow {
  source: string;
  entity_name: string;
  bn: string | null;
}

async function main() {
  console.log("=== Entity Embedding Generator ===\n");

  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  client.on("error", () => {});
  await client.connect();

  // Ensure vector extension and correct table schema
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  await client.query(`
    CREATE TABLE IF NOT EXISTS entity_embeddings (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      bn TEXT,
      embedding vector(${EMBEDDING_DIMENSIONS})
    )
  `);

  // Check what dimensions the existing table uses
  const colInfo = await client.query(`
    SELECT atttypmod FROM pg_attribute
    WHERE attrelid = 'entity_embeddings'::regclass AND attname = 'embedding'
  `);
  const currentDim = colInfo.rows[0]?.atttypmod;
  if (currentDim && currentDim !== EMBEDDING_DIMENSIONS) {
    console.log(`Resizing embedding column from ${currentDim} to ${EMBEDDING_DIMENSIONS} dimensions...`);
    await client.query(`ALTER TABLE entity_embeddings ALTER COLUMN embedding TYPE vector(${EMBEDDING_DIMENSIONS})`);
  }

  // Gather entities to embed
  console.log("Gathering entities...");

  const charities = await client.query<EntityRow>(`
    SELECT 'charity' AS source, legal_name AS entity_name, bn
    FROM t3010_id
    WHERE legal_name IS NOT NULL AND legal_name != ''
    GROUP BY legal_name, bn
  `);
  console.log(`  Charities: ${charities.rows.length.toLocaleString()}`);

  // Top vendors by contract count (avoid embedding 208K tiny vendors)
  const vendors = await client.query<EntityRow>(`
    SELECT 'vendor' AS source, vendor_name AS entity_name, NULL AS bn
    FROM contracts
    WHERE vendor_name IS NOT NULL AND vendor_name != ''
    GROUP BY vendor_name
    HAVING COUNT(*) >= 3
    ORDER BY COUNT(*) DESC
  `);
  console.log(`  Vendors (3+ contracts): ${vendors.rows.length.toLocaleString()}`);

  // Top grant recipients by grant count
  const recipients = await client.query<EntityRow>(`
    SELECT 'grant_recipient' AS source, recipient_legal_name AS entity_name,
           MAX(recipient_business_number) AS bn
    FROM grants
    WHERE recipient_legal_name IS NOT NULL AND recipient_legal_name != ''
    GROUP BY recipient_legal_name
    HAVING COUNT(*) >= 2
    ORDER BY COUNT(*) DESC
  `);
  console.log(`  Grant recipients (2+ grants): ${recipients.rows.length.toLocaleString()}`);

  const allEntities = [...charities.rows, ...vendors.rows, ...recipients.rows];
  console.log(`  Total: ${allEntities.length.toLocaleString()} entities to embed\n`);

  // Check how many already exist
  const existingCount = await client.query("SELECT COUNT(*)::int AS n FROM entity_embeddings");
  const existing = existingCount.rows[0].n;
  if (existing > 0) {
    console.log(`  ${existing} embeddings already exist.`);

    if (process.argv.includes("--force")) {
      console.log("  --force flag set, truncating...");
      await client.query("TRUNCATE entity_embeddings RESTART IDENTITY");
    } else {
      // Skip entities that already have embeddings
      const existingNames = await client.query("SELECT DISTINCT entity_name FROM entity_embeddings");
      const existingSet = new Set(existingNames.rows.map((r: { entity_name: string }) => r.entity_name));
      const toEmbed = allEntities.filter((e) => !existingSet.has(e.entity_name));
      console.log(`  ${toEmbed.length.toLocaleString()} new entities to embed (skipping ${existingSet.size.toLocaleString()} existing)\n`);

      if (toEmbed.length === 0) {
        console.log("Nothing to do!");
        await client.end();
        return;
      }

      // Replace allEntities with filtered list
      allEntities.length = 0;
      allEntities.push(...toEmbed);
    }
  }

  // Get Azure OpenAI token
  console.log("Authenticating with Azure OpenAI...");
  let token = await getToken();
  console.log("  Authenticated.\n");

  // Process in batches
  const totalBatches = Math.ceil(allEntities.length / BATCH_SIZE);
  let embedded = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < allEntities.length; i += BATCH_SIZE) {
    const batch = allEntities.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    // Refresh token every 100 batches (~4 min)
    if (batchNum % 100 === 0) {
      token = await getToken();
    }

    try {
      const texts = batch.map((e) => e.entity_name);
      const embeddings = await getEmbeddings(texts, token);

      // Insert into DB
      const values: string[] = [];
      const params: unknown[] = [];
      for (let j = 0; j < batch.length; j++) {
        const base = j * 4;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::vector)`);
        params.push(
          batch[j].source,
          batch[j].entity_name,
          batch[j].bn,
          `[${embeddings[j].join(",")}]`,
        );
      }

      await client.query(
        `INSERT INTO entity_embeddings (source, entity_name, bn, embedding) VALUES ${values.join(", ")}`,
        params,
      );

      embedded += batch.length;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (embedded / (Number(elapsed) || 1)).toFixed(0);
      console.log(`  Batch ${batchNum}/${totalBatches}: ${embedded.toLocaleString()} embedded (${rate}/s, ${elapsed}s elapsed)`);
    } catch (e) {
      errors++;
      console.error(`  ❌ Batch ${batchNum}: ${(e as Error).message.substring(0, 120)}`);

      // If rate limited, wait and retry
      if ((e as Error).message.includes("429")) {
        console.log("  Rate limited, waiting 30s...");
        await new Promise((r) => setTimeout(r, 30000));
        i -= BATCH_SIZE; // Retry this batch
      }
    }
  }

  // Create index for fast similarity search
  console.log("\nCreating vector index...");
  try {
    await client.query("DROP INDEX IF EXISTS idx_embeddings_vector");
    await client.query(`
      CREATE INDEX idx_embeddings_vector ON entity_embeddings
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);
    console.log("  ✅ IVFFlat index created.");
  } catch (e) {
    console.log(`  ⚠️ Index: ${(e as Error).message.substring(0, 80)}`);
  }

  // Summary
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const finalCount = await client.query("SELECT COUNT(*)::int AS n FROM entity_embeddings");
  console.log(`\n=== Complete: ${finalCount.rows[0].n.toLocaleString()} embeddings (${totalElapsed}s, ${errors} errors) ===`);

  await client.end();
}

main().catch((err) => {
  console.error("Embedding generation failed:", err);
  process.exit(1);
});
