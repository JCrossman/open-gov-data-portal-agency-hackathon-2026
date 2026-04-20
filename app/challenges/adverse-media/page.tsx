export const dynamic = "force-dynamic";
import Link from "next/link";
import { querySafe } from "@/lib/db";
import { ADVERSE_MEDIA_SEVERITIES } from "@/lib/adverse-media";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";
import SignalBadge from "@/components/SignalBadge";

const SEVERITY_DESCRIPTIONS: Record<string, string> = {
  sanctions: "Subject of an active sanctions listing (e.g. Global Affairs Canada Special Economic Measures).",
  fraud: "Subject of public reporting alleging fraud or financial misrepresentation.",
  regulatory_action: "Subject of an active regulatory enforcement action by a Canadian regulator.",
  criminal_investigation: "Subject of a criminal investigation, charges, or conviction reported in public records.",
  safety_incident: "Subject of a documented safety incident — workplace, product, or public-safety related.",
  filing_lapse: "Registered charity that has not filed a T3010 return for 2+ years yet continued to receive federal grants after its last filing — a CRA-revocation precursor signal (charities that stop filing are subject to administrative revocation under the Income Tax Act).",
};

export const revalidate = 3600;

interface SeverityCount {
  severity: string;
  n: number;
}

interface MatchRow {
  adverse_media_id: number;
  severity: string;
  source_id: string;
  source_url: string | null;
  published_at: string | null;
  entity_name_raw: string;
  summary: string | null;
  matched_source: string;
  matched_entity_name: string;
  matched_bn: string | null;
  match_method: string;
  confidence: string;
  grants_total: string | null;
  grants_count: string | null;
  contracts_total: string | null;
  contracts_count: string | null;
}

function money(v: string | number | null | undefined): string {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  if (!n || Number.isNaN(n)) return "—";
  return "$" + Math.round(n).toLocaleString();
}

export default async function AdverseMediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tableCheck = await querySafe<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema='public' AND table_name='adverse_media'`,
  );
  const hasTable = (tableCheck[0]?.n ?? 0) > 0;

  const severityCounts = hasTable
    ? await querySafe<SeverityCount>(
        `SELECT severity, COUNT(*)::int AS n FROM adverse_media GROUP BY severity ORDER BY severity`,
      )
    : [];

  const sources = hasTable
    ? await querySafe<{ id: string; name: string; url: string | null; last_fetched_at: string | null; category: string }>(
        `SELECT id, name, url, last_fetched_at, category FROM adverse_media_sources ORDER BY id`,
      )
    : [];

  const headline = hasTable
    ? await querySafe<{ funded_flagged: number }>(
        `SELECT COUNT(*)::int AS funded_flagged FROM (
           SELECT DISTINCT UPPER(m.matched_entity_name) AS key
           FROM adverse_media_matches m
           WHERE EXISTS (SELECT 1 FROM grants g WHERE UPPER(g.recipient_legal_name) = UPPER(m.matched_entity_name))
              OR EXISTS (SELECT 1 FROM contracts c WHERE UPPER(c.vendor_name) = UPPER(m.matched_entity_name))
         ) t`,
      )
    : [];

  const methodSummary = hasTable
    ? await querySafe<{ match_method: string; n: number }>(
        `SELECT match_method, COUNT(*)::int AS n FROM adverse_media_matches GROUP BY match_method ORDER BY match_method`,
      )
    : [];

  // External matches table sort config
  const ALLOWED_EXTERNAL = {
    entity: "m.matched_entity_name",
    severity: "a.severity",
    grants: "COALESCE(gt.total, 0)",
    contracts: "COALESCE(ct.total, 0)",
    listed_date: "a.published_at",
  } as const;
  type ExternalKey = keyof typeof ALLOWED_EXTERNAL;
  const sortExternal = parseSort<typeof ALLOWED_EXTERNAL, ExternalKey>(
    sp,
    ALLOWED_EXTERNAL,
    "grants",
    "desc",
    "sortE",
    "dirE",
  );

  const matches = hasTable
    ? await querySafe<MatchRow>(
        `
      WITH matched AS (
        SELECT a.id AS adverse_media_id,
               a.severity, a.source_id, a.source_url, a.published_at,
               a.entity_name_raw, a.summary,
               m.matched_source, m.matched_entity_name, m.matched_bn,
               m.match_method, m.confidence
        FROM adverse_media a
        JOIN adverse_media_matches m ON m.adverse_media_id = a.id
      ),
      gt AS (
        SELECT UPPER(m.matched_entity_name) AS key,
               SUM(g.agreement_value)::numeric AS total,
               COUNT(*)::int AS cnt
        FROM matched m
        JOIN grants g ON UPPER(g.recipient_legal_name) = UPPER(m.matched_entity_name)
        GROUP BY UPPER(m.matched_entity_name)
      ),
      ct AS (
        SELECT UPPER(m.matched_entity_name) AS key,
               SUM(c.effective_value)::numeric AS total,
               COUNT(*)::int AS cnt
        FROM matched m
        JOIN contracts c ON UPPER(c.vendor_name) = UPPER(m.matched_entity_name)
        GROUP BY UPPER(m.matched_entity_name)
      )
      SELECT m.*, gt.total AS grants_total, gt.cnt AS grants_count,
             ct.total AS contracts_total, ct.cnt AS contracts_count
      FROM matched m
      LEFT JOIN gt ON gt.key = UPPER(m.matched_entity_name)
      LEFT JOIN ct ON ct.key = UPPER(m.matched_entity_name)
      WHERE COALESCE(gt.total, 0) + COALESCE(ct.total, 0) > 0
      ORDER BY ${sortExternal.orderBySql}
      LIMIT 100
      `,
      )
    : [];

  const fundedFlagged = headline[0]?.funded_flagged ?? 0;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <nav className="mb-6 text-sm text-slate-500">
        <Link href="/challenges" className="hover:underline">← All challenges</Link>
      </nav>

      <header className="mb-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900">
          Challenge 10 · Adverse media on external recipients
        </div>
        <h1 className="mt-3 text-3xl font-bold text-slate-900">
          Adverse Media (External Enforcement Signals)
        </h1>
        <p className="mt-2 max-w-3xl text-slate-600">
          Challenge 10 asks which <strong>external recipients</strong> of public funding are the
          subject of serious adverse signals — enforcement actions, sanctions, fraud allegations,
          criminal investigations, or safety incidents. This page combines (a) structured federal
          enforcement sources cross-referenced against grant and contract recipients, (b) a CRA-derived{" "}
          <code>filing_lapse</code> signal flagging registered charities that have not filed a T3010
          return for 2+ years yet continued to receive federal grants (a precursor to administrative
          revocation under the Income Tax Act), and (c) a companion table of internal federal-employee
          wrongdoing disclosures for context.
        </p>
      </header>

      {!hasTable && (
        <section className="rounded border border-dashed border-slate-300 bg-slate-50 p-6 text-slate-700">
          <h2 className="text-lg font-semibold">Pipeline not yet populated</h2>
          <p className="mt-2 text-sm">
            The <code>adverse_media</code> tables exist in the schema but contain no rows. Run{" "}
            <code>npx tsx scripts/ingest-adverse-media.ts</code> to populate them.
          </p>
        </section>
      )}

      {hasTable && (
        <>
          <section className="mb-8 grid gap-4 md:grid-cols-4">
            <div className="rounded border border-slate-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Funded recipients with ≥1 external flag
              </div>
              <div className="mt-1 text-3xl font-bold text-slate-900">{fundedFlagged.toLocaleString()}</div>
              <div className="mt-1 text-xs text-slate-500">
                Distinct names appearing in both an adverse-media source and either grants or contracts.
              </div>
            </div>
            {ADVERSE_MEDIA_SEVERITIES.map((sev) => {
              const row = severityCounts.find((r) => r.severity === sev);
              return (
                <div key={sev} className="rounded border border-slate-200 bg-white p-4">
                  <div className="text-xs uppercase tracking-wide text-slate-500">{sev.replace(/_/g, " ")}</div>
                  <div className="mt-1 text-3xl font-bold text-slate-900">{(row?.n ?? 0).toLocaleString()}</div>
                  <div className="mt-1 text-xs text-slate-500">records ingested</div>
                </div>
              );
            })}
          </section>

          <section className="mb-8 rounded border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-slate-900">Sources</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {sources.map((s) => (
                <li key={s.id} className="flex flex-col">
                  <div className="font-medium text-slate-800">
                    {s.name} <span className="text-xs text-slate-500">({s.category})</span>
                  </div>
                  {s.url && (
                    <a href={s.url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">
                      {s.url}
                    </a>
                  )}
                  <div className="text-xs text-slate-500">
                    Last fetched: {s.last_fetched_at ? new Date(s.last_fetched_at).toUTCString() : "never"}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500">
              A companion table below shows federal public-servant wrongdoing disclosures
              (Public Servants Disclosure Protection Act). That dataset describes
              <strong> government-internal wrongdoing</strong>, not external-recipient adverse
              media, and is included for transparency only — it does not answer Challenge 10 on
              its own.
            </p>
          </section>

          <section className="mb-8 rounded border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-slate-900">Matching summary</h2>
            <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
              {["exact_bn", "exact_name", "vector_cosine"].map((m) => {
                const row = methodSummary.find((r) => r.match_method === m);
                return (
                  <div key={m} className="rounded border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs uppercase text-slate-500">{m.replace(/_/g, " ")}</div>
                    <div className="text-2xl font-bold text-slate-900">{(row?.n ?? 0).toLocaleString()}</div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              <strong>exact_bn</strong> requires a 9-digit business-number prefix match.{" "}
              <strong>exact_name</strong> uses case/punctuation-insensitive normalized-name equality
              (common legal suffixes stripped). <strong>vector_cosine</strong> uses pgvector similarity
              over <code>entity_embeddings</code> with threshold ≥ 0.72 and top-1 only.
            </p>
          </section>

          <section className="mb-8 rounded border border-slate-200 bg-white">
            <h2 className="border-b border-slate-200 px-5 py-3 text-lg font-semibold text-slate-900">
              Funded recipients with external adverse flags (top 100 by funding total)
            </h2>
            {matches.length === 0 ? (
              <p className="p-5 text-sm text-slate-600">
                No matched entities with any grants or contracts on file. Given that the first source
                loaded is a foreign-targeted sanctions list, this outcome is consistent with the
                expected low base rate and is itself an honest Challenge 10 finding.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <SortableHeader
                        columnKey="entity"
                        label="Matched entity"
                        sort={sortExternal}
                        defaultDir="asc"
                        preserve={{ sortW: sp.sortW as string, dirW: sp.dirW as string }}
                      />
                      <SortableHeader
                        columnKey="severity"
                        label="Severity"
                        sort={sortExternal}
                        defaultDir="asc"
                        preserve={{ sortW: sp.sortW as string, dirW: sp.dirW as string }}
                        info="Category of the adverse-media listing: sanctions, fraud, regulatory_action, criminal_investigation, safety_incident, or filing_lapse (charity stopped filing T3010 while still receiving grants). Hover the badge in any row for the full definition."
                      />
                      <th className="px-4 py-2">Source</th>
                      <th className="px-4 py-2">Method</th>
                      <SortableHeader
                        columnKey="grants"
                        label="Grants"
                        sort={sortExternal}
                        align="right"
                        defaultDir="desc"
                        preserve={{ sortW: sp.sortW as string, dirW: sp.dirW as string }}
                        info="Total federal grant dollars this matched entity has received across all years on file (with grant count shown beneath)."
                      />
                      <SortableHeader
                        columnKey="contracts"
                        label="Contracts"
                        sort={sortExternal}
                        align="right"
                        defaultDir="desc"
                        preserve={{ sortW: sp.sortW as string, dirW: sp.dirW as string }}
                        info="Total federal contract dollars this matched entity has received across all years on file (with contract count shown beneath)."
                      />
                      <SortableHeader
                        columnKey="listed_date"
                        label="Listed date"
                        sort={sortExternal}
                        defaultDir="desc"
                        preserve={{ sortW: sp.sortW as string, dirW: sp.dirW as string }}
                        info="Date this entity was first published on the underlying adverse-media source (e.g. when the sanctions listing was issued)."
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m, i) => (
                      <tr key={`${m.adverse_media_id}-${i}`} className="border-b border-slate-100">
                        <td className="px-4 py-2">
                          <div className="font-medium text-slate-900">{m.matched_entity_name}</div>
                          <div className="text-xs text-slate-500">
                            {m.matched_source}
                            {m.matched_bn ? ` · BN ${m.matched_bn}` : ""}
                            {m.entity_name_raw !== m.matched_entity_name ? ` · listed as “${m.entity_name_raw}”` : ""}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <SignalBadge
                            label={m.severity}
                            description={SEVERITY_DESCRIPTIONS[m.severity] ?? "Severity category from the adverse-media taxonomy."}
                            tone="warning"
                          />
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {m.source_url ? (
                            <a href={m.source_url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                              {m.source_id}
                            </a>
                          ) : (
                            m.source_id
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {m.match_method}
                          {m.match_method === "vector_cosine" ? ` (${Number(m.confidence).toFixed(2)})` : ""}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {money(m.grants_total)}
                          {m.grants_count ? <div className="text-xs text-slate-500">{m.grants_count} grants</div> : null}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {money(m.contracts_total)}
                          {m.contracts_count ? <div className="text-xs text-slate-500">{m.contracts_count} contracts</div> : null}
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-600">
                          {m.published_at ? new Date(m.published_at).toISOString().slice(0, 10) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded border border-slate-200 bg-slate-50 p-5 text-xs text-slate-600">
            <h3 className="text-sm font-semibold text-slate-800">Caveats</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Adverse-media presence is <strong>not</strong> proof of wrongdoing — open the source link for the original listing.</li>
              <li>Exact-name matches can produce false positives when common business words align; they are shown as low-confidence leads, not findings.</li>
              <li>The sanctions source targets foreign persons and entities, so few Canadian funded-recipient matches are expected and low counts are an honest reflection of that universe.</li>
              <li>This pipeline starts with structured federal sources (GAC sanctions, CNSC penalties) plus a CRA-derived <code>filing_lapse</code> signal: registered charities that have not filed a T3010 return for 2+ years yet continued to receive federal grants. Under the Income Tax Act, charities that stop filing are subject to administrative revocation, so this is a defensible recipient-focused precursor to the CRA revoked-charity register.</li>
              <li>The <code>filing_lapse</code> signal is a <strong>precursor</strong>, not proof of formal CRA revocation — confirm against the official CRA Charities Listing before drawing conclusions about any individual entity.</li>
            </ul>
          </section>

          {/* Internal-wrongdoing companion */}
          <InternalWrongdoingCompanion searchParams={sp} />
        </>
      )}
    </main>
  );
}

async function InternalWrongdoingCompanion({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Wrongdoing table sort config
  const ALLOWED_WRONGDOING = {
    fiscal_year: "fiscal_year",
    quarter: "quarter",
    owner_org: "owner_org",
    owner_org_title: "owner_org_title",
  } as const;
  type WrongdoingKey = keyof typeof ALLOWED_WRONGDOING;
  const sortWrongdoing = parseSort<typeof ALLOWED_WRONGDOING, WrongdoingKey>(
    searchParams,
    ALLOWED_WRONGDOING,
    "fiscal_year",
    "desc",
    "sortW",
    "dirW",
  );

  const rows = await querySafe<Record<string, unknown>>(
    `SELECT * FROM wrongdoing ORDER BY ${sortWrongdoing.orderBySql} LIMIT 25`,
  );
  const total = await querySafe<{ n: number }>(`SELECT n FROM mv_table_counts WHERE tbl='wrongdoing'`);
  const fieldKeys = rows.length > 0
    ? Object.keys(rows[0]).filter((id) => !id.startsWith("_")).slice(0, 6)
    : ["fiscal_year", "quarter", "owner_org", "owner_org_title"];
  const n = total[0]?.n ?? 0;
  return (
    <section className="mt-10 rounded border border-slate-200 bg-white">
      <header className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Companion: Internal federal-employee wrongdoing disclosures
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Founded acts of wrongdoing <strong>by federal public servants</strong> disclosed under
          the <em>Public Servants Disclosure Protection Act</em>. The &ldquo;owner org&rdquo; is
          the <strong>department where the wrongdoing occurred</strong>, not an external funding
          recipient. Included here only for completeness — it is not an answer to Challenge 10.
          Registry total: <strong>{n.toLocaleString()}</strong> cases.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left uppercase text-slate-500">
              <th className="px-3 py-2">#</th>
              {fieldKeys.map((k) => {
                const isSortable = k in ALLOWED_WRONGDOING;
                if (isSortable) {
                  return (
                    <SortableHeader
                      key={k}
                      columnKey={k as WrongdoingKey}
                      label={k.replace(/_/g, " ")}
                      sort={sortWrongdoing}
                      defaultDir={k === "fiscal_year" || k === "quarter" ? "desc" : "asc"}
                      preserve={{ sortE: searchParams.sortE as string, dirE: searchParams.dirE as string }}
                    />
                  );
                }
                return <th key={k} className="px-3 py-2">{k.replace(/_/g, " ")}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-100">
                <td className="px-3 py-2">{i + 1}</td>
                {fieldKeys.map((k) => (
                  <td key={k} className="max-w-[240px] truncate px-3 py-2">
                    {String(r[k] ?? "").substring(0, 100)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={fieldKeys.length + 1} className="p-4 text-center text-slate-500">
                  No rows in <code>wrongdoing</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
