/* One-off: create or replace mv_purpose_cluster on the live Azure PG.
   Run once after deployment; subsequent rebuilds happen via optimize-db.ts.
*/
const { Client } = require("pg");

const SQL = `
DROP MATERIALIZED VIEW IF EXISTS mv_purpose_cluster CASCADE;
CREATE MATERIALIZED VIEW mv_purpose_cluster AS
WITH classified AS (
  SELECT
    COALESCE(NULLIF(substr(recipient_business_number, 1, 9), ''),
             'NM:' || UPPER(TRIM(recipient_legal_name))) AS recip_key,
    CASE WHEN recipient_business_number IS NOT NULL
              AND length(recipient_business_number) >= 9
         THEN substr(recipient_business_number, 1, 9) END AS bn_prefix,
    recipient_legal_name,
    owner_org_title,
    prog_name_en,
    agreement_value,
    CASE
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(housing|homeless|shelter|rent supplement|affordable home|co-?op housing)\\M' THEN 'housing'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(mental health|psychiatric|suicide|addiction|substance use|opioid)\\M' THEN 'mental_health'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(indigenous|first nations?|inuit|m[eé]tis|aboriginal|reconciliation)\\M' THEN 'indigenous'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(climate|emissions?|greenhouse|net.?zero|decarboniz|clean energy|renewable energy)\\M' THEN 'climate'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(research|innovation|scientif|laboratory|nserc|cihr|sshrc|r&d)\\M' THEN 'research'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(child ?care|early learning|early childhood)\\M' THEN 'child_care'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(immigrant|newcomer|settlement services|refugee|asylum)\\M' THEN 'settlement'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(official languages?|francoph)\\M' THEN 'official_languages'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\mveterans?\\M' THEN 'veterans'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(seniors?|elderly|aging)\\M' THEN 'seniors'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\myouth\\M' THEN 'youth'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(women|gender|gender-based violence|domestic violence)\\M' THEN 'women_gender'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(skills|workforce|apprentice|employment program)\\M' THEN 'skills_employment'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(agricultur|farm|food security)\\M' THEN 'agriculture'
      WHEN (lower(coalesce(prog_name_en,'')) || ' ' || lower(coalesce(description_en,'')))
           ~ '\\m(arts|culture|heritage|museum|festival)\\M' THEN 'arts_culture'
      ELSE NULL
    END AS purpose_cluster
  FROM grants
  WHERE recipient_legal_name IS NOT NULL
    AND agreement_value > 0
    AND owner_org_title IS NOT NULL
    AND prog_name_en IS NOT NULL
)
SELECT
  recip_key,
  MAX(bn_prefix) AS bn_prefix,
  MAX(recipient_legal_name) AS recipient_legal_name,
  purpose_cluster,
  COUNT(DISTINCT owner_org_title)::int AS n_departments,
  COUNT(DISTINCT prog_name_en)::int AS n_programs,
  COUNT(*)::int AS grant_count,
  SUM(agreement_value)::numeric AS total_value,
  STRING_AGG(DISTINCT owner_org_title, ' | ' ORDER BY owner_org_title) AS departments,
  jsonb_agg(DISTINCT jsonb_build_object('dept', owner_org_title, 'program', prog_name_en))
    FILTER (WHERE owner_org_title IS NOT NULL) AS programs
FROM classified
WHERE purpose_cluster IS NOT NULL
GROUP BY recip_key, purpose_cluster
HAVING COUNT(DISTINCT owner_org_title) >= 2
   AND COUNT(DISTINCT prog_name_en) >= 2;

CREATE UNIQUE INDEX IF NOT EXISTS mv_purpose_cluster_key
  ON mv_purpose_cluster (recip_key, purpose_cluster);
CREATE INDEX IF NOT EXISTS mv_purpose_cluster_val
  ON mv_purpose_cluster (total_value DESC);
CREATE INDEX IF NOT EXISTS mv_purpose_cluster_dept
  ON mv_purpose_cluster (n_departments DESC);
`;

(async () => {
  const c = new Client({
    connectionString:
      "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require",
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  console.log("Creating mv_purpose_cluster ...");
  const t = Date.now();
  await c.query(SQL);
  console.log(`Built in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const summary = await c.query(`
    SELECT COUNT(*)::int AS clusters,
           SUM(total_value)::numeric AS tot_val,
           COUNT(*) FILTER (WHERE n_departments >= 3)::int AS big
    FROM mv_purpose_cluster
  `);
  console.log("summary:", summary.rows[0]);
  const top = await c.query(`
    SELECT recipient_legal_name, purpose_cluster, n_departments, n_programs,
           total_value
    FROM mv_purpose_cluster
    ORDER BY total_value DESC
    LIMIT 10
  `);
  console.log("top by value:");
  console.table(top.rows);
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
