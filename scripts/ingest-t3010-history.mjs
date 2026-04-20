import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';

const RESOURCES = JSON.parse(fs.readFileSync('/tmp/t3010_resources.json','utf8'));
const YEARS_TO_INGEST = [2023, 2022, 2021, 2020, 2019, 2018];
const PAGE_SIZE = 32000;

const cfg = {
  host: process.env.PGHOST ?? (() => { throw new Error('PGHOST env var is required'); })(),
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'opengov',
  user: process.env.PGUSER ?? (() => { throw new Error('PGUSER env var is required'); })(),
  password: process.env.PGPASSWORD ?? (() => { throw new Error('PGPASSWORD env var is required'); })(),
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
};

const log = (m) => console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);

async function connect() {
  for (let i = 0; i < 5; i++) {
    try {
      const c = new pg.Client(cfg);
      await c.connect();
      await c.query("SET statement_timeout = 0");
      return c;
    } catch (e) {
      log(`connect retry ${i+1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000 * (i+1)));
    }
  }
  throw new Error('cannot connect');
}

async function q(client, sql, params) {
  for (let i = 0; i < 5; i++) {
    try { return await client.query(sql, params); }
    catch (e) {
      log(`query retry ${i+1}: ${e.message.slice(0,200)}`);
      try { await client.end(); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      Object.assign(client, await connect());
    }
  }
  throw new Error('query failed after retries');
}

async function fetchAllRecords(resourceId, label) {
  const all = [];
  let offset = 0;
  while (true) {
    const url = `https://open.canada.ca/data/api/action/datastore_search?resource_id=${resourceId}&limit=${PAGE_SIZE}&offset=${offset}`;
    let recs;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
        const j = await r.json();
        if (!j.success) throw new Error('datastore err ' + JSON.stringify(j.error));
        recs = j.result.records;
        break;
      } catch (e) {
        log(`  ${label} fetch retry ${i+1} offset=${offset}: ${e.message}`);
        await new Promise(r => setTimeout(r, 5000 * (i+1)));
      }
    }
    if (!recs) throw new Error(`fetch failed ${label} offset ${offset}`);
    if (recs.length === 0) break;
    all.push(...recs);
    offset += PAGE_SIZE;
    if (recs.length < PAGE_SIZE) break;
  }
  return all;
}

function csvEscape(s) {
  s = (s ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function copyCSV(client, sql, rows) {
  if (rows.length === 0) return;
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
  for (let i = 0; i < 3; i++) {
    try {
      const s = client.query(copyFrom(sql));
      await pipeline(Readable.from([csv]), s);
      return;
    } catch (e) {
      log(`  COPY retry ${i+1}: ${e.message.slice(0,200)}`);
      try { await client.end(); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      Object.assign(client, await connect());
    }
  }
  throw new Error('COPY failed');
}

function num(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(String(v).replace(/,/g,''));
  return Number.isFinite(n) ? String(n) : '';
}

function parseFPE(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // CRA FPE comes as YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0,10) : '';
}

async function ingestFinancialYear(client, year, resourceId) {
  log(`--- Financial ${year} (${resourceId}) ---`);
  const recs = await fetchAllRecords(resourceId, `financial ${year}`);
  log(`  fetched ${recs.length} records`);

  const rows = recs.map(r => {
    const bn = (r.BN || '').trim();
    const fpe = parseFPE(r.FPE);
    if (!bn || !fpe) return null;
    return [
      bn,
      num(r['4700'] || r['4650']), // total_revenue fallback
      num(r['5100']),               // total_expenditure
      num(r['4120']),               // gov_funding_federal = line 4120
      num(r['4130']),               // line 4130 (investment income — constitutionally labeled)
      num(r['4140']),               // line 4140 (other revenue — constitutionally labeled)
      num(r['390'] || r['4880']),   // compensation
      num(r['5010']),               // mgmt_admin_exp
      JSON.stringify(r),            // raw_fields
      fpe,
    ];
  }).filter(Boolean);

  log(`  parsed ${rows.length} rows`);

  await q(client, `
    DROP TABLE IF EXISTS t3010_financial_staging_y;
    CREATE TABLE t3010_financial_staging_y (
      bn TEXT, total_revenue TEXT, total_expenditure TEXT,
      gov_funding_federal TEXT, gov_funding_provincial TEXT, gov_funding_other TEXT,
      compensation TEXT, mgmt_admin_exp TEXT, raw_fields TEXT, fpe TEXT
    );
  `);

  // chunk to avoid single huge stream
  const CHUNK = 20000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await copyCSV(client, `COPY t3010_financial_staging_y FROM STDIN WITH (FORMAT csv)`, rows.slice(i, i+CHUNK));
    log(`  staged ${Math.min(i+CHUNK, rows.length)}/${rows.length}`);
  }

  // INSERT with dedup vs existing (bn,fpe)
  const ins = await q(client, `
    INSERT INTO t3010_financial (bn, total_revenue, total_expenditure, gov_funding_federal, gov_funding_provincial, gov_funding_other, compensation, mgmt_admin_exp, raw_fields, fpe)
    SELECT s.bn,
      NULLIF(s.total_revenue,'')::numeric,
      NULLIF(s.total_expenditure,'')::numeric,
      NULLIF(s.gov_funding_federal,'')::numeric,
      NULLIF(s.gov_funding_provincial,'')::numeric,
      NULLIF(s.gov_funding_other,'')::numeric,
      NULLIF(s.compensation,'')::numeric,
      NULLIF(s.mgmt_admin_exp,'')::numeric,
      NULLIF(s.raw_fields,'')::jsonb,
      s.fpe::date
    FROM t3010_financial_staging_y s
    WHERE NOT EXISTS (
      SELECT 1 FROM t3010_financial f WHERE f.bn = s.bn AND f.fpe = s.fpe::date
    );
  `);
  log(`  INSERTED ${ins.rowCount} new financial rows for ${year}`);

  await q(client, `DROP TABLE t3010_financial_staging_y;`);
}

async function buildIdHistory(client) {
  log(`=== Building t3010_id_history across all years ===`);
  await q(client, `
    DROP TABLE IF EXISTS t3010_id_history;
    CREATE TABLE t3010_id_history (
      bn TEXT NOT NULL,
      list_year INT NOT NULL,
      legal_name TEXT,
      category TEXT,
      designation TEXT,
      PRIMARY KEY (bn, list_year)
    );
  `);

  const allYears = [2024, ...YEARS_TO_INGEST];
  for (const year of allYears) {
    const rid = RESOURCES[year]?.id;
    if (!rid) { log(`  skip ${year} (no id resource)`); continue; }
    log(`--- ID ${year} (${rid}) ---`);
    const recs = await fetchAllRecords(rid, `id ${year}`);
    log(`  fetched ${recs.length} records`);

    const rows = recs.map(r => {
      const bn = (r.BN || '').trim();
      if (!bn) return null;
      return [
        bn,
        String(year),
        (r['Legal name'] || r['LegalName'] || r['Legal Name'] || '').trim(),
        (r['Category'] || '').trim(),
        (r['Designation'] || '').trim(),
      ];
    }).filter(Boolean);

    await q(client, `
      DROP TABLE IF EXISTS t3010_id_staging;
      CREATE TABLE t3010_id_staging (bn TEXT, list_year TEXT, legal_name TEXT, category TEXT, designation TEXT);
    `);

    const CHUNK = 20000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await copyCSV(client, `COPY t3010_id_staging FROM STDIN WITH (FORMAT csv)`, rows.slice(i, i+CHUNK));
    }

    const r = await q(client, `
      INSERT INTO t3010_id_history (bn, list_year, legal_name, category, designation)
      SELECT DISTINCT ON (bn) bn, list_year::int, NULLIF(legal_name,''), NULLIF(category,''), NULLIF(designation,'')
      FROM t3010_id_staging
      WHERE bn IS NOT NULL AND bn <> ''
      ON CONFLICT (bn, list_year) DO NOTHING;
    `);
    log(`  INSERTED ${r.rowCount} id-history rows for ${year}`);
    await q(client, `DROP TABLE t3010_id_staging;`);
  }

  await q(client, `
    CREATE INDEX idx_id_history_bn ON t3010_id_history (bn);
    CREATE INDEX idx_id_history_year ON t3010_id_history (list_year);
    ANALYZE t3010_id_history;
  `);

  const stats = await q(client, `
    SELECT list_year, COUNT(*) AS n FROM t3010_id_history GROUP BY list_year ORDER BY list_year;
  `);
  log(`Coverage: ${JSON.stringify(stats.rows)}`);
}

async function main() {
  let client = await connect();

  log('=== Multi-year T3010 financial ingest ===');
  for (const year of YEARS_TO_INGEST) {
    const rid = RESOURCES[year]?.financial;
    if (!rid) { log(`skip ${year} (no financial resource)`); continue; }
    await ingestFinancialYear(client, year, rid);
  }

  log('=== Summary financial ===');
  const r = await q(client, `SELECT EXTRACT(YEAR FROM fpe) AS year, COUNT(*) FROM t3010_financial GROUP BY 1 ORDER BY 1;`);
  for (const row of r.rows) log(`  ${row.year}: ${row.count}`);

  await buildIdHistory(client);

  await client.end();
  log('DONE');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
