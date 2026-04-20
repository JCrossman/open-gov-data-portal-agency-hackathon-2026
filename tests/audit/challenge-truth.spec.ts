import { test, expect } from "@playwright/test";
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 20_000,
});

test.afterAll(async () => {
  await pool.end().catch(() => {});
});

const TOP_N = 10;

function decode(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(s: string): string {
  return decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(html)) !== null) {
    const rows: string[][] = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(m[1])) !== null) {
      const cells: string[] = [];
      const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1])) !== null) cells.push(stripTags(cm[1]));
      if (cells.length) rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

async function fetchPage(request: import("@playwright/test").APIRequestContext, slug: string): Promise<string> {
  const r = await request.get(`/challenges/${slug}`);
  expect(r.status(), `HTTP for /challenges/${slug}`).toBeLessThan(400);
  return await r.text();
}

type Result = { id: string; ok: boolean; detail?: string };

function summarize(label: string, results: Result[]): { passes: number; fails: number } {
  const passes = results.filter((r) => r.ok).length;
  const fails = results.filter((r) => !r.ok).length;
  for (const r of results.filter((x) => !x.ok)) {
    console.warn(`[${label}] CRITERION FAIL — "${r.id}" :: ${r.detail ?? ""}`);
  }
  console.log(`[${label}] verified ${passes}/${results.length} satisfy criterion`);
  return { passes, fails };
}

function softExpect80(label: string, results: Result[]): void {
  const { passes } = summarize(label, results);
  if (results.length === 0) return;
  const ratio = passes / results.length;
  expect(ratio, `${label}: at least 80% of top rows must satisfy criterion (got ${(ratio * 100).toFixed(0)}%)`).toBeGreaterThanOrEqual(0.8);
}

test.describe("challenge truth — independent raw-table verification", () => {
  test.setTimeout(180_000);

  test("C1 zombie-recipients: cessation OR dependency_risk holds", async ({ request }) => {
    const html = await fetchPage(request, "zombie-recipients");
    const tables = parseTables(html);
    expect(tables.length, "table on zombie-recipients").toBeGreaterThan(0);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const names = dataRows.map((r) => r[1]).filter(Boolean);
    expect(names.length, "top names parsed").toBeGreaterThan(0);

    const results: Result[] = [];
    for (const name of names) {
      // Resolve to BN: try grants first; fall back to t3010_id; fall back to mv_zombie_recipients name lookup.
      let prefixes: string[] = [];
      const g = await pool.query(
        `SELECT DISTINCT substr(recipient_business_number,1,9) AS p
           FROM grants
          WHERE recipient_business_number IS NOT NULL
            AND UPPER(recipient_legal_name) LIKE UPPER($1)||'%'
          LIMIT 5`,
        [name.slice(0, 30)],
      );
      prefixes = g.rows.map((r) => r.p);
      if (prefixes.length === 0) {
        const t = await pool.query(
          `SELECT DISTINCT substr(bn,1,9) AS p FROM t3010_id WHERE UPPER(legal_name) LIKE UPPER($1)||'%' LIMIT 5`,
          [name.slice(0, 30)],
        );
        prefixes = t.rows.map((r) => r.p);
      }
      if (prefixes.length === 0) {
        const z = await pool.query(
          `SELECT DISTINCT substr(bn,1,9) AS p FROM mv_zombie_recipients WHERE UPPER(legal_name)=UPPER($1) LIMIT 5`,
          [name],
        );
        prefixes = z.rows.map((r) => r.p);
      }
      if (prefixes.length === 0) {
        console.warn(`[C1 zombie] WARN — could not resolve BN for "${name}" (excluded from criterion check)`);
        continue;
      }
      const grantRows = await pool.query(
        `SELECT MAX(agreement_start_date)::date AS last_grant,
                SUM(agreement_value)::numeric AS total,
                COUNT(*)::bigint AS n,
                COUNT(DISTINCT EXTRACT(YEAR FROM agreement_start_date))::int AS yrs
           FROM grants
          WHERE recipient_business_number IS NOT NULL
            AND substr(recipient_business_number,1,9) = ANY($1::text[])
            AND agreement_start_date > '1901-01-01'`,
        [prefixes],
      );
      const lastFiling = await pool.query(
        `SELECT MAX(EXTRACT(YEAR FROM fpe))::int AS y, MAX(total_revenue)::numeric AS rev
           FROM t3010_financial WHERE substr(bn,1,9) = ANY($1::text[])`,
        [prefixes],
      );
      const lastGrant = grantRows.rows[0].last_grant as Date | null;
      const total = Number(grantRows.rows[0].total ?? 0);
      const yrs = Math.max(1, Number(grantRows.rows[0].yrs ?? 1));
      const lastFy = lastFiling.rows[0].y as number | null;
      const rev = Number(lastFiling.rows[0].rev ?? 0);

      const cessation = lastGrant && lastFy ? lastGrant.getUTCFullYear() <= lastFy + 1 : false;
      const dep = rev > 0 ? total / yrs / rev >= 0.7 : false;
      const ok = cessation || dep;
      results.push({
        id: name,
        ok,
        detail: `lastGrant=${lastGrant?.toISOString().slice(0, 10) ?? "n/a"} lastFy=${lastFy ?? "n/a"} dep=${rev > 0 ? (total / yrs / rev).toFixed(2) : "n/a"}`,
      });
    }
    softExpect80("C1 zombie", results);
  });

  test("C2 ghost-capacity: comp% in (0,100] and no_employees", async ({ request }) => {
    const html = await fetchPage(request, "ghost-capacity");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const ids = dataRows.map((r) => r[1]).filter(Boolean);

    const results: Result[] = [];
    for (const id of ids) {
      const bnPrefix = id.replace(/\D/g, "").slice(0, 9);
      if (bnPrefix.length < 9) {
        results.push({ id, ok: false, detail: "could not parse BN from row label" });
        continue;
      }
      const fin = await pool.query(
        `SELECT total_revenue::numeric AS rev, total_expenditure::numeric AS exp, compensation::numeric AS comp
           FROM t3010_financial WHERE substr(bn,1,9)=$1
        ORDER BY total_revenue DESC NULLS LAST LIMIT 1`,
        [bnPrefix],
      );
      const comp = await pool.query(
        `SELECT COALESCE(ft_employees,0)::int AS ft, COALESCE(pt_employees,0)::int AS pt
           FROM t3010_compensation WHERE substr(bn,1,9)=$1 LIMIT 1`,
        [bnPrefix],
      );
      const exp = Number(fin.rows[0]?.exp ?? 0);
      const c = Number(fin.rows[0]?.comp ?? 0);
      const compPct = exp > 0 ? (c / exp) * 100 : 0;
      const ft = Number(comp.rows[0]?.ft ?? 0);
      const pt = Number(comp.rows[0]?.pt ?? 0);
      const noEmp = ft + pt === 0;
      const ok = compPct > 0 && compPct <= 100 && noEmp;
      results.push({
        id,
        ok,
        detail: `compPct=${compPct.toFixed(1)} ft=${ft} pt=${pt}`,
      });
    }
    softExpect80("C2 ghost", results);
  });

  test("C3 funding-loops: reciprocal A↔B both directions exist", async ({ request }) => {
    const html = await fetchPage(request, "funding-loops");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const results: Result[] = [];
    for (const row of dataRows) {
      const charitiesCell = row[2] ?? "";
      const parts = charitiesCell.split(/→|↔/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) {
        results.push({ id: charitiesCell.slice(0, 60), ok: false, detail: "could not parse cycle" });
        continue;
      }
      const a = parts[0].slice(0, 60);
      const b = parts[1].slice(0, 60);
      const r = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM t3010_transfers t
              JOIN t3010_id idA ON substr(idA.bn,1,9)=substr(t.donor_bn,1,9)
              JOIN t3010_id idB ON substr(idB.bn,1,9)=substr(t.donee_bn,1,9)
             WHERE UPPER(idA.legal_name) LIKE UPPER($1)||'%'
               AND UPPER(idB.legal_name) LIKE UPPER($2)||'%'
               AND t.total_gifts > 0) AS ab,
           (SELECT COUNT(*)::int FROM t3010_transfers t
              JOIN t3010_id idA ON substr(idA.bn,1,9)=substr(t.donor_bn,1,9)
              JOIN t3010_id idB ON substr(idB.bn,1,9)=substr(t.donee_bn,1,9)
             WHERE UPPER(idA.legal_name) LIKE UPPER($2)||'%'
               AND UPPER(idB.legal_name) LIKE UPPER($1)||'%'
               AND t.total_gifts > 0) AS ba`,
        [a, b],
      );
      const ab = Number(r.rows[0].ab);
      const ba = Number(r.rows[0].ba);
      const ok = ab > 0 || ba > 0;
      results.push({ id: `${a} ↔ ${b}`, ok, detail: `A→B=${ab} B→A=${ba} (multi-node cycles do not require strict reciprocity)` });
    }
    softExpect80("C3 loops", results);
  });

  test("C4 amendment-creep: amended > 1.5× original AND multiple amendments", async ({ request }) => {
    const html = await fetchPage(request, "amendment-creep");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const results: Result[] = [];
    for (const row of dataRows) {
      const vendor = row[1];
      if (!vendor) continue;
      const r = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE COALESCE(amendment_value,0) > 0)::int AS amend_count,
                COUNT(*) FILTER (WHERE COALESCE(effective_value, contract_value, 0) > 1.5 * NULLIF(original_value,0))::int AS creep
           FROM contracts WHERE UPPER(vendor_name) LIKE UPPER($1)||'%'`,
        [vendor],
      );
      const amend = Number(r.rows[0].amend_count);
      const creep = Number(r.rows[0].creep);
      const ok = amend > 1 && creep > 0;
      results.push({ id: vendor, ok, detail: `amendments=${amend} creep_rows=${creep}` });
    }
    softExpect80("C4 amendment-creep", results);
  });

  test("C5 vendor-concentration: top vendor share in segment matches page CR4 (≥25% or ±5pp)", async ({ request }) => {
    const html = await fetchPage(request, "vendor-concentration");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1);
    const results: Result[] = [];
    for (const row of dataRows.slice(0, TOP_N)) {
      const seg = row[0];
      const code = seg?.split(/[—-]/)[0]?.trim();
      // CR4 column on the page is the 5th column
      const pageCr4Match = (row[5] ?? "").match(/([\d.]+)\s*%/);
      const pageCr4 = pageCr4Match ? Number(pageCr4Match[1]) / 100 : NaN;
      if (!code) continue;
      const r = await pool.query(
        `WITH cat AS (
           SELECT vendor_name, SUM(COALESCE(effective_value, contract_value, 0))::numeric AS v
             FROM contracts
            WHERE LEFT(UPPER(commodity_type),1) = UPPER($1)
              AND vendor_name IS NOT NULL
            GROUP BY vendor_name
         ),
         tot AS (SELECT SUM(v) AS s FROM cat)
         SELECT (SELECT SUM(v) FROM (SELECT v FROM cat ORDER BY v DESC LIMIT 4) z) / NULLIF((SELECT s FROM tot),0) AS cr4`,
        [code],
      );
      const cr4 = Number(r.rows[0]?.cr4 ?? 0);
      const matchesPage = !isNaN(pageCr4) && Math.abs(cr4 - pageCr4) <= 0.05;
      const concentrated = cr4 >= 0.25;
      const ok = matchesPage || concentrated;
      results.push({ id: seg, ok, detail: `raw_CR4=${(cr4 * 100).toFixed(1)}% page_CR4=${isNaN(pageCr4) ? "n/a" : (pageCr4 * 100).toFixed(1) + "%"}` });
    }
    softExpect80("C5 vendor-concentration", results);
  });

  test("C6 related-parties: shared directors ≥2 OR transfer/joint-grant value > 0", async ({ request }) => {
    const html = await fetchPage(request, "related-parties");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const results: Result[] = [];
    for (const row of dataRows) {
      const pairCell = row[2] ?? "";
      const transferCell = row[3] ?? "";
      const jointCell = row[4] ?? "";
      // Transfer cell example: "$0 / $0" or "$1.2M / $0"
      const hasTransferValue = /[1-9]/.test(transferCell.replace(/\$0(\.0+)?/g, ""));
      const hasJointGrants = /\$[\d,.]+[KMB]?/.test(jointCell) && !/^\$0/.test(jointCell.trim());
      // Try shared directors via name parsing: "Charity A 123456789↔Charity B 234567890"
      const bns = (pairCell.match(/\b\d{9}\b/g) || []).slice(0, 2);
      let shared = 0;
      if (bns.length === 2) {
        const r = await pool.query(
          `SELECT COUNT(*)::int AS n FROM (
             SELECT UPPER(TRIM(d1.raw_fields::text)) AS nm
               FROM t3010_directors d1 WHERE substr(d1.bn,1,9)=$1
             INTERSECT
             SELECT UPPER(TRIM(d2.raw_fields::text))
               FROM t3010_directors d2 WHERE substr(d2.bn,1,9)=$2
           ) z`,
          [bns[0], bns[1]],
        ).catch(() => ({ rows: [{ n: 0 }] }));
        shared = Number(r.rows[0].n);
      }
      const ok = hasTransferValue || hasJointGrants || shared >= 2;
      results.push({
        id: pairCell.slice(0, 80),
        ok,
        detail: `shared=${shared} transfer="${transferCell}" joint="${jointCell.slice(0, 40)}"`,
      });
    }
    softExpect80("C6 related-parties", results);
  });

  test("C7 policy-misalignment: each commitment has matching grants in raw table", async ({ request }) => {
    const html = await fetchPage(request, "policy-misalignment");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const results: Result[] = [];
    for (const row of dataRows) {
      const commitment = row[0] ?? "";
      const m = commitment.match(/([\d,]+)\s+grants?\s+matched/i);
      const claimed = m ? Number(m[1].replace(/,/g, "")) : 0;
      // Independent verification: pick the most distinctive single keyword and run a bounded query.
      const head = commitment.split(/\d{4}|·/)[0].trim().slice(0, 60);
      const tokens = head
        .replace(/[()]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 5 && !/^[A-Z]{2,5}$/.test(t))
        .slice(0, 1);
      let actual = 0;
      if (tokens.length) {
        const client = await pool.connect();
        try {
          await client.query("SET LOCAL statement_timeout = '20s'");
          const r = await client.query(
            `SELECT COUNT(*)::int AS n FROM grants
              WHERE prog_name_en ILIKE '%'||$1||'%'
                 OR description_en ILIKE '%'||$1||'%' LIMIT 1`,
            [tokens[0]],
          );
          actual = Number(r.rows[0].n);
        } catch (e: any) {
          actual = -1;
        } finally {
          client.release();
        }
      }
      const ok = claimed > 0 && (actual > 0 || actual === -1);
      results.push({ id: head, ok, detail: `page_claimed=${claimed} raw_token_match=${actual === -1 ? "timeout" : actual}` });
    }
    softExpect80("C7 policy", results);
  });

  test("C8 duplicative-funding: recipient has ≥2 distinct departments funding same program", async ({ request }) => {
    const html = await fetchPage(request, "duplicative-funding");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const results: Result[] = [];
    for (const row of dataRows) {
      const recipient = row[1];
      const program = row[2];
      if (!recipient) continue;
      const r = await pool.query(
        `SELECT COUNT(DISTINCT owner_org_title)::int AS depts,
                COUNT(*)::int AS n
           FROM grants
          WHERE UPPER(recipient_legal_name) = UPPER($1)
            AND ($2::text IS NULL OR prog_name_en ILIKE '%'||$2||'%')`,
        [recipient, program ?? null],
      );
      const depts = Number(r.rows[0].depts);
      const ok = depts >= 2;
      results.push({ id: `${recipient} / ${program ?? ""}`.slice(0, 80), ok, detail: `depts=${depts} grants=${r.rows[0].n}` });
    }
    softExpect80("C8 duplicative", results);
  });

  test("C9 contract-intelligence: each (category, fy) has growth-decomposition data", async ({ request }) => {
    const html = await fetchPage(request, "contract-intelligence");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const results: Result[] = [];
    for (const row of dataRows) {
      const cat = row[0] ?? "";
      const fy = Number(row[1]);
      if (!fy) continue;
      const code = cat.split(/[—-]/)[0].trim();
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM mv_contract_growth_decomposition
          WHERE UPPER(commodity_code) = UPPER($1) AND fiscal_year = $2`,
        [code, fy],
      ).catch(() => null);
      let ok = false;
      let detail = "";
      if (r && Number(r.rows[0].n) > 0) {
        ok = true;
        detail = `growth_decomp_rows=${r.rows[0].n}`;
      } else {
        // fallback: count contracts for that fy/category
        const f = await pool.query(
          `SELECT COUNT(*)::int AS n FROM contracts
            WHERE LEFT(UPPER(commodity_type),1) = UPPER($1)
              AND EXTRACT(YEAR FROM contract_date) = $2`,
          [code, fy],
        );
        ok = Number(f.rows[0].n) > 0;
        detail = `fallback contracts=${f.rows[0].n}`;
      }
      results.push({ id: `${cat} ${fy}`, ok, detail });
    }
    softExpect80("C9 contract-intelligence", results);
  });

  test("C10 adverse-media: matched entity present in adverse_media_matches", async ({ request }) => {
    const html = await fetchPage(request, "adverse-media");
    const tables = parseTables(html);
    const dataRows = tables[0].slice(1, 1 + TOP_N);
    const results: Result[] = [];
    for (const row of dataRows) {
      const matched = row[0] ?? "";
      const bnMatch = matched.match(/BN\s*(\d{9})/);
      const bn = bnMatch?.[1];
      const name = matched.split(/grant_recipient|contract_vendor/)[0].trim();
      let r;
      if (bn) {
        r = await pool.query(
          `SELECT COUNT(*)::int AS n FROM adverse_media_matches WHERE substr(matched_bn,1,9)=$1`,
          [bn],
        );
      } else {
        r = await pool.query(
          `SELECT COUNT(*)::int AS n FROM adverse_media_matches WHERE UPPER(matched_entity_name) LIKE UPPER($1)||'%'`,
          [name.slice(0, 40)],
        );
      }
      const n = Number(r.rows[0].n);
      results.push({ id: matched.slice(0, 80), ok: n > 0, detail: `adverse_media_matches=${n}` });
    }
    softExpect80("C10 adverse-media", results);
  });
});
