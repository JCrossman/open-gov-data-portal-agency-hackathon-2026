// One-off script: create policy_targets table + seed federal commitments + (re)build mv_policy_alignment.
// Run: node scripts/setup-policy-targets.cjs
const pg = require("pg");

const CONN =
  process.env.DATABASE_URL ||
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

const TARGETS = [
  {
    id: "nhs-2017",
    name: "National Housing Strategy",
    department: "Canada Mortgage and Housing Corporation / Infrastructure Canada",
    announced_year: 2017,
    total_commitment_cad: 82_000_000_000,
    period_years: 11,
    target_start: "2017-04-01",
    target_end: "2028-04-01",
    keywords: [
      "housing", "logement", "affordable housing", "National Housing Strategy",
      "rapid housing", "homeless", "Reaching Home", "CMHC", "shelter",
    ],
    description:
      "10+ year envelope (announced 2017, expanded 2022) for affordable housing supply, repair, and homelessness initiatives. Delivered through a mix of grants, CMHC loans, and federal-provincial agreements; only the grant portion appears in this dataset.",
    source_url: "https://www.placetocallhome.ca/",
    delivery_note:
      "Grants are only one delivery channel. CMHC loans and bilateral housing agreements fall outside the federal grants dataset.",
  },
  {
    id: "cwelcc-2021",
    name: "Canada-Wide Early Learning and Child Care (CWELCC)",
    department: "Employment and Social Development Canada",
    announced_year: 2021,
    total_commitment_cad: 30_000_000_000,
    period_years: 5,
    target_start: "2021-04-01",
    target_end: "2026-04-01",
    keywords: [
      "child care", "childcare", "early learning", "garderie",
      "apprentissage et garde des jeunes enfants",
    ],
    description:
      "Budget 2021 committed $30B over 5 years for $10/day early learning and child care, delivered overwhelmingly via bilateral federal-provincial-territorial transfer agreements.",
    source_url: "https://www.canada.ca/en/early-learning-child-care-agreement.html",
    delivery_note:
      "Delivered overwhelmingly via federal-provincial transfer agreements (not loaded in this portal). Grants below understate actual fulfillment.",
  },
  {
    id: "nza-2021",
    name: "Net Zero Accelerator (Strategic Innovation Fund)",
    department: "Innovation, Science and Economic Development Canada",
    announced_year: 2021,
    total_commitment_cad: 8_000_000_000,
    period_years: 7,
    target_start: "2021-04-01",
    target_end: "2028-04-01",
    keywords: [
      "Net Zero Accelerator", "net zero", "net-zero", "Strategic Innovation Fund",
      "decarboniz", "décarbonis", "low carbon", "low-carbon", "clean technology",
      "clean tech", "zero emission", "industrial transformation",
    ],
    description:
      "$8B (top-up of the Strategic Innovation Fund) over 7 years to support large-scale industrial decarbonization projects on the path to the 2030 emissions target and 2050 net-zero commitment.",
    source_url: "https://ised-isde.canada.ca/site/strategic-innovation-fund/en/net-zero-accelerator-initiative",
    delivery_note: null,
  },
  {
    id: "indigenous-2021",
    name: "Indigenous Priorities & Reconciliation (Budget 2021 envelope)",
    department: "Crown-Indigenous Relations / Indigenous Services Canada",
    announced_year: 2021,
    total_commitment_cad: 18_000_000_000,
    period_years: 5,
    target_start: "2021-04-01",
    target_end: "2026-04-01",
    keywords: [
      "indigenous", "first nation", "first nations", "inuit", "metis", "métis",
      "aboriginal", "autochtone", "reconciliation", "Truth and Reconciliation",
    ],
    description:
      "Budget 2021 committed $18B over 5 years for Indigenous priorities (health, housing, infrastructure, child welfare, languages) responding to TRC Calls to Action. Includes ongoing Indigenous Services Canada grant streams that predate the incremental envelope.",
    source_url: "https://www.budget.canada.ca/2021/report-rapport/toc-tdm-en.html",
    delivery_note: null,
  },
  {
    id: "health-transfers-2023",
    name: "Working Together to Improve Health Care for Canadians",
    department: "Health Canada",
    announced_year: 2023,
    total_commitment_cad: 46_200_000_000,
    period_years: 10,
    target_start: "2023-04-01",
    target_end: "2033-04-01",
    keywords: [
      "health care", "healthcare", "santé", "Canada Health Transfer",
      "primary care", "mental health", "santé mentale", "health workforce",
      "shared health priorities",
    ],
    description:
      "$46.2B over 10 years (Feb 2023 First Ministers' offer) of new federal funding for health care: top-ups to the Canada Health Transfer and bilateral agreements covering family health, workforce, mental health, and modernizing health data.",
    source_url: "https://www.canada.ca/en/health-canada/news/2023/02/working-together-to-improve-health-care-for-canadians.html",
    delivery_note:
      "Delivered primarily through the Canada Health Transfer and bilateral federal-provincial agreements (not grants). Grant matches understate fulfillment.",
  },
  {
    id: "dental-2023",
    name: "Canadian Dental Care Plan",
    department: "Health Canada",
    announced_year: 2023,
    total_commitment_cad: 13_000_000_000,
    period_years: 5,
    target_start: "2023-04-01",
    target_end: "2028-04-01",
    keywords: [
      "dental", "dentaire", "soins dentaires", "oral health", "santé buccodentaire",
      "Canadian Dental Care Plan", "CDCP", "Plan canadien de soins dentaires",
      "Sun Life", "Sun Life Assurance", "dental benefits", "dental services plan",
      "dental care",
    ],
    description:
      "Budget 2023 committed $13B over 5 years for the Canadian Dental Care Plan, delivered primarily through Sun Life direct-billing administration and provider reimbursements rather than project grants.",
    source_url: "https://www.budget.canada.ca/2023/report-rapport/chap2-en.html",
    delivery_note:
      "Delivered via direct insurance administration (Sun Life contract + provider reimbursement), outside the grants dataset. Grant allocation is expected to be near zero by design.",
  },
  {
    id: "defence-onsaf-2024",
    name: "Defence Policy: Our North, Strong and Free",
    department: "Department of National Defence",
    announced_year: 2024,
    total_commitment_cad: 73_000_000_000,
    period_years: 20,
    target_start: "2024-04-01",
    target_end: "2044-04-01",
    keywords: [
      "defence", "défense", "national defence", "Our North Strong and Free",
      "NORAD", "Canadian Armed Forces", "military", "Arctic sovereignty",
    ],
    description:
      "April 2024 defence policy update committing $73B in new spending over 20 years (with $8.1B over the first 5 years) for continental defence, Arctic sovereignty, and Canadian Armed Forces capability. The bulk flows through DND statutory and capital programs, not transfer-payment grants.",
    source_url: "https://www.canada.ca/en/department-national-defence/corporate/reports-publications/north-strong-free-2024.html",
    delivery_note:
      "Defence spending flows mostly through statutory appropriations, capital procurement, and operating budgets — not the grants/contributions vehicle measured here.",
  },
  {
    id: "pharmacare-2024",
    name: "National Pharmacare (Bill C-64, Phase 1)",
    department: "Health Canada",
    announced_year: 2024,
    total_commitment_cad: 1_500_000_000,
    period_years: 5,
    target_start: "2024-04-01",
    target_end: "2029-04-01",
    keywords: [
      "pharmacare", "assurance-médicaments", "prescription drug",
      "diabetes medication", "contraception", "Bill C-64",
    ],
    description:
      "Bill C-64 (Pharmacare Act, 2024) launched a single-payer first phase covering prescription contraception and diabetes medications, backed by ~$1.5B over 5 years subject to bilateral PT agreements.",
    source_url: "https://www.canada.ca/en/health-canada/news/2024/02/the-government-of-canada-introduces-legislation-on-pharmacare.html",
    delivery_note:
      "Delivered primarily through bilateral agreements with provinces and territories; project-grant share is expected to be small.",
  },
];

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS policy_targets (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  department           TEXT NOT NULL,
  announced_year       INT  NOT NULL,
  total_commitment_cad NUMERIC NOT NULL,
  period_years         INT  NOT NULL,
  annual_target        NUMERIC GENERATED ALWAYS AS (total_commitment_cad / NULLIF(period_years, 0)) STORED,
  target_start         DATE NOT NULL,
  target_end           DATE NOT NULL,
  keywords             TEXT[] NOT NULL,
  match_regex          TEXT NOT NULL,
  description          TEXT NOT NULL,
  source_url           TEXT,
  delivery_note        TEXT
);
`;

// Build a single POSIX alternation regex from the keywords list. Each keyword
// is regex-escaped so phrases with periods/spaces/hyphens are matched literally.
function buildRegex(keywords) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return keywords.map(esc).join("|");
}

const MV_DDL = `
DROP MATERIALIZED VIEW IF EXISTS mv_policy_alignment CASCADE;
CREATE MATERIALIZED VIEW mv_policy_alignment AS
SELECT
  pt.id,
  pt.name,
  pt.department,
  pt.announced_year,
  pt.total_commitment_cad,
  pt.period_years,
  pt.annual_target,
  pt.target_start,
  pt.target_end,
  pt.description,
  pt.source_url,
  pt.delivery_note,
  pt.keywords,
  COALESCE(g.total_matched, 0)::numeric AS total_matched,
  COALESCE(g.grant_count, 0)::int       AS grant_count,
  COALESCE(g.years_observed, 0)::int    AS years_observed,
  CASE WHEN COALESCE(g.years_observed, 0) > 0
       THEN g.total_matched / g.years_observed
       ELSE 0 END::numeric AS annual_actual,
  (pt.annual_target -
    CASE WHEN COALESCE(g.years_observed, 0) > 0
         THEN g.total_matched / g.years_observed
         ELSE 0 END
  )::numeric AS annual_gap,
  CASE WHEN pt.annual_target > 0 THEN
    100.0 * (pt.annual_target -
      CASE WHEN COALESCE(g.years_observed, 0) > 0
           THEN g.total_matched / g.years_observed
           ELSE 0 END
    ) / pt.annual_target
  ELSE 0 END::numeric AS gap_pct
FROM policy_targets pt
LEFT JOIN LATERAL (
  SELECT
    SUM(gr.agreement_value) AS total_matched,
    COUNT(*)                AS grant_count,
    GREATEST(
      1,
      EXTRACT(YEAR FROM MAX(gr.agreement_start_date))::int
        - EXTRACT(YEAR FROM MIN(gr.agreement_start_date))::int + 1
    ) AS years_observed
  FROM grants gr
  WHERE gr.agreement_start_date >= pt.target_start
    AND gr.agreement_start_date <  pt.target_end
    AND gr.agreement_value IS NOT NULL
    AND (gr.prog_name_en ~* pt.match_regex OR gr.description_en ~* pt.match_regex)
) g ON TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS mv_policy_alignment_id ON mv_policy_alignment (id);
`;

async function main() {
  const pool = new pg.Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    console.log("Creating policy_targets table…");
    await client.query(TABLE_DDL);
    // Defensive: if table existed from a prior run without match_regex, add it.
    await client.query("ALTER TABLE policy_targets ADD COLUMN IF NOT EXISTS match_regex TEXT");

    console.log(`Upserting ${TARGETS.length} commitments…`);
    await client.query("BEGIN");
    await client.query("DELETE FROM policy_targets");
    for (const t of TARGETS) {
      await client.query(
        `INSERT INTO policy_targets
          (id, name, department, announced_year, total_commitment_cad, period_years,
           target_start, target_end, keywords, match_regex, description, source_url, delivery_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          t.id, t.name, t.department, t.announced_year, t.total_commitment_cad,
          t.period_years, t.target_start, t.target_end, t.keywords, buildRegex(t.keywords),
          t.description, t.source_url, t.delivery_note,
        ],
      );
    }
    await client.query("COMMIT");

    console.log("Building mv_policy_alignment (this scans grants, may take ~30-60s)…");
    const t0 = Date.now();
    await client.query(MV_DDL);
    console.log(`MV built in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

    const r = await client.query(
      `SELECT id, name, department,
              ROUND(annual_target)::bigint AS annual_target,
              ROUND(annual_actual)::bigint AS annual_actual,
              ROUND(annual_gap)::bigint AS annual_gap,
              ROUND(gap_pct, 1) AS gap_pct,
              grant_count, years_observed
         FROM mv_policy_alignment ORDER BY annual_gap DESC`,
    );
    console.log(`\n${r.rows.length} rows in mv_policy_alignment:\n`);
    console.table(r.rows);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("FAILED:", e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
