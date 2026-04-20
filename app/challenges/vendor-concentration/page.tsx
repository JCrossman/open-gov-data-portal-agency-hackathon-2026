export const revalidate = 3600;
import { queryWithStatus } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import VendorTreemapChart from "@/components/charts/VendorTreemap";
import type { VendorDatum } from "@/components/charts/VendorTreemap";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";

function fmtDollars(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

const COMMODITY_LABEL: Record<string, string> = {
  S: "Services",
  G: "Goods",
  C: "Construction",
};

interface VendorRow {
  norm_vendor: string;
  display_name: string;
  total_value: number;
  contract_count: number;
}

interface DupeRow {
  strip_key: string;
  distinct_norm: number;
  variant_count: number;
  cluster_spend: string | number;
  cluster_contracts: number;
  norm_vendors: string[];
  sample_names: string[];
  sample_spend: (string | number)[];
}

interface SegmentRow {
  segment: string;
  norm_vendor: string;
  display_name: string | null;
  total_value: number;
  contract_count: number;
  share_pct: number | null;
  rnk: number;
  seg_total_value: number;
  seg_contract_count: number;
  seg_vendor_count: number;
  hhi: number | null;
  cr4: number | null;
  cr10: number | null;
}

export default async function VendorConcentrationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // Sort parsers for each table
  // Table 1: Commodity type summary
  const ALLOWED_CAT = {
    segment: "segment",
    total_value: "seg_total_value",
    contracts: "seg_contract_count",
    vendors: "seg_vendor_count",
    hhi: "hhi",
    cr4: "cr4",
    cr10: "cr10",
  } as const;
  const sortCat = parseSort(sp, ALLOWED_CAT, "segment", "asc", "sort1", "dir1");

  // Table 2: Department concentration
  const ALLOWED_DEPT = {
    department: "segment",
    total_value: "seg_total_value",
    vendors: "seg_vendor_count",
    hhi: "hhi",
    cr4: "cr4",
  } as const;
  const sortDept = parseSort(sp, ALLOWED_DEPT, "hhi", "desc", "sort2", "dir2");

  // Table 3: Full market top 20 vendors
  const ALLOWED_VENDOR = {
    vendor: "display_name",
    total_value: "total_value",
    share: "total_value",
    contracts: "contract_count",
  } as const;
  const sortVendor = parseSort(sp, ALLOWED_VENDOR, "total_value", "desc", "sort3", "dir3");

  const ALLOWED_DUPE = {
    spend: "cluster_spend",
    distinct: "distinct_norm",
    variants: "variant_count",
  } as const;
  const sortDupe = parseSort(sp, ALLOWED_DUPE, "spend", "desc", "sort4", "dir4");

  const [statsRes, allVendorsRes, byCatRes, byDeptRes, dupesRes] = await Promise.all([
    queryWithStatus<{ n: number; total_value: number; unique_vendors: number }>(
      `SELECT n, total_value, unique_vendors FROM mv_service_contracts_count`,
    ),
    queryWithStatus<VendorRow>(`SELECT * FROM mv_vendor_concentration ORDER BY ${sortVendor.orderBySql}, norm_vendor`),
    queryWithStatus<SegmentRow>(`SELECT * FROM mv_vendor_concentration_by_category ORDER BY ${sortCat.orderBySql}, rnk`),
    queryWithStatus<SegmentRow>(
      `SELECT * FROM mv_vendor_concentration_by_department
       WHERE segment IN (
         SELECT segment FROM mv_vendor_concentration_by_department
         WHERE norm_vendor='*SEGMENT*' AND seg_vendor_count >= 5
         ORDER BY hhi DESC NULLS LAST LIMIT 8
       )
       ORDER BY ${sortDept.orderBySql}, rnk`,
    ),
    queryWithStatus<DupeRow>(
      `SELECT strip_key, distinct_norm, variant_count, cluster_spend, cluster_contracts,
              norm_vendors, sample_names, sample_spend
       FROM mv_vendor_name_dupes
       ORDER BY ${sortDupe.orderBySql}
       LIMIT 25`,
    ),
  ]);

  const header = (
    <>
      <a
        href="/challenges"
        style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}
      >
        ← Back to Challenges
      </a>
      <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
        Challenge 5: Vendor Concentration
      </h1>
      <blockquote
        style={{
          borderLeft: "4px solid var(--gc-accent)",
          margin: "0 0 2rem",
          padding: "0.75rem 1rem",
          background: "var(--gc-bg-secondary)",
          color: "var(--gc-text-secondary)",
          fontSize: "0.9375rem",
          lineHeight: 1.6,
        }}
      >
        In any given category of government spending, how many vendors are
        actually competing? Concentration is shown segment-by-segment
        (commodity type and department) with HHI + CR4 + CR10 on the full
        vendor list in each segment — not the top-50 slice. Vendor normalization
        applies family rules (Deloitte, Microsoft, Cofomo, IBM, PwC, etc.). See
        <code className="font-mono"> lib/vendor-normalization.ts</code>.
      </blockquote>
    </>
  );

  if (!statsRes.ok || !allVendorsRes.ok || !byCatRes.ok || !byDeptRes.ok || !dupesRes.ok) {
    const err = [statsRes, allVendorsRes, byCatRes, byDeptRes, dupesRes].find((r) => !r.ok)!;
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        {header}
        <DataUnavailableBanner
          scope="Vendor-concentration findings (mv_vendor_concentration / _by_category / _by_department / mv_service_contracts_count)"
          error={err.ok ? undefined : err.error}
        />
      </div>
    );
  }

  const statsRow = statsRes.rows[0];
  const allVendors = allVendorsRes.rows;
  const byCatRows = byCatRes.rows;
  const byDeptRows = byDeptRes.rows;
  const dupeRows = dupesRes.rows;

  const totalContracts = statsRow?.n ?? 0;
  const uniqueVendorsFullMarket = Number(statsRow?.unique_vendors ?? 0);
  const grandTotal = Number(statsRow?.total_value ?? 0);

  const top20: VendorDatum[] = allVendors.slice(0, 20).map((v) => ({
    name: truncate(v.display_name ?? v.norm_vendor, 22),
    value: Number(v.total_value),
    share: (Number(v.total_value) / grandTotal) * 100,
  }));
  const top10: VendorDatum[] = top20.slice(0, 10);

  const catSummaries = byCatRows.filter((r) => r.norm_vendor === "*SEGMENT*");
  const catTopByKey = new Map<string, SegmentRow[]>();
  for (const r of byCatRows) {
    if (r.norm_vendor === "*SEGMENT*") continue;
    const bucket = catTopByKey.get(r.segment) ?? [];
    bucket.push(r);
    catTopByKey.set(r.segment, bucket);
  }

  const deptSummaries = byDeptRows
    .filter((r) => r.norm_vendor === "*SEGMENT*")
    .sort((a, b) => Number(b.hhi ?? 0) - Number(a.hhi ?? 0));
  const deptTopByKey = new Map<string, SegmentRow[]>();
  for (const r of byDeptRows) {
    if (r.norm_vendor === "*SEGMENT*") continue;
    const bucket = deptTopByKey.get(r.segment) ?? [];
    bucket.push(r);
    deptTopByKey.set(r.segment, bucket);
  }

  const fullMarketTop5Share = allVendors.slice(0, 5).reduce((s, v) => s + Number(v.total_value), 0) / grandTotal * 100;
  const fullMarketTop10Share = allVendors.slice(0, 10).reduce((s, v) => s + Number(v.total_value), 0) / grandTotal * 100;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      {header}

      {/* Section 1 — Primary: segmented concentration */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 1 — Concentration by Commodity Type
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_vendor_concentration_by_category</code>. Detailed <code className="font-mono">commodity_code</code> (GSIN) is not loaded in the current ETL — segments here are the coarse <code className="font-mono">commodity_type</code> buckets (S=Services, G=Goods, C=Construction). HHI and CR4/CR10 computed on the full vendor list in each segment.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <SortableHeader columnKey="segment" label="Segment" sort={sortCat as any} align="left" defaultDir="asc" style={th} preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} />
              <SortableHeader columnKey="total_value" label="Total value" sort={sortCat as any} align="right" style={th} preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} />
              <SortableHeader columnKey="contracts" label="Contracts" sort={sortCat as any} align="right" style={th} preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} />
              <SortableHeader columnKey="vendors" label="Vendors" sort={sortCat as any} align="right" style={th} preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} />
              <SortableHeader columnKey="hhi" label="HHI" sort={sortCat as any} align="right" style={th} preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} info="Herfindahl-Hirschman Index — sum of squared market shares (in percent) of every vendor in the segment. Below 1500 = competitive; 1500–2500 = moderately concentrated; above 2500 = highly concentrated." />
              <SortableHeader columnKey="cr4" label="CR4" sort={sortCat as any} align="right" style={th} preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} info="Four-firm concentration ratio — combined share of the four largest vendors in this segment. Higher means a smaller group of suppliers wins more of the work." />
              <SortableHeader columnKey="cr10" label="CR10" sort={sortCat as any} align="right" style={th} preserve={{ sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} info="Ten-firm concentration ratio — combined share of the ten largest vendors in this segment." />
            </tr>
          </thead>
          <tbody>
            {catSummaries.map((s, i) => (
              <tr key={s.segment} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                <td style={td}>
                  <strong>{s.segment}</strong> — {COMMODITY_LABEL[s.segment] ?? s.segment}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(s.seg_total_value))}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {Number(s.seg_contract_count).toLocaleString()}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {Number(s.seg_vendor_count).toLocaleString()}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 700,
                    color: Number(s.hhi ?? 0) > 1500 ? "var(--gc-accent)" : "inherit",
                  }}
                >
                  {Number(s.hhi ?? 0).toFixed(0)}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {Number(s.cr4 ?? 0).toFixed(1)}%
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {Number(s.cr10 ?? 0).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 2 — Most Concentrated Departments (Services)
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_vendor_concentration_by_department</code>. Top 8 service-buying departments by HHI, with a minimum of 5 distinct vendors to suppress tiny-segment artefacts. Top-3 vendors shown per department.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <SortableHeader columnKey="department" label="Department" sort={sortDept as any} align="left" defaultDir="asc" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} />
              <SortableHeader columnKey="total_value" label="Services $" sort={sortDept as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} />
              <SortableHeader columnKey="vendors" label="Vendors" sort={sortDept as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} />
              <SortableHeader columnKey="hhi" label="HHI" sort={sortDept as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} info="Herfindahl-Hirschman Index for this department's services spending. Below 1500 = competitive; 1500–2500 = moderately concentrated; above 2500 = highly concentrated." />
              <SortableHeader columnKey="cr4" label="CR4" sort={sortDept as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} info="Four-firm concentration ratio — combined share of the four largest service vendors in this department." />
              <th style={th}>Top vendors (share)</th>
            </tr>
          </thead>
          <tbody>
            {deptSummaries.map((s, i) => {
              const top3 = (deptTopByKey.get(s.segment) ?? []).slice(0, 3);
              return (
                <tr key={s.segment} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                  <td style={td}>{truncate(s.segment, 48)}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {fmtDollars(Number(s.seg_total_value))}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {Number(s.seg_vendor_count).toLocaleString()}
                  </td>
                  <td
                    style={{
                      ...td,
                      textAlign: "right",
                      fontFamily: "var(--font-mono)",
                      fontWeight: 700,
                      color: Number(s.hhi ?? 0) > 1500 ? "var(--gc-accent)" : "inherit",
                    }}
                  >
                    {Number(s.hhi ?? 0).toFixed(0)}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {Number(s.cr4 ?? 0).toFixed(1)}%
                  </td>
                  <td style={{ ...td, fontSize: "0.75rem" }}>
                    {top3.map((v, vi) => (
                      <div key={vi}>
                        {truncate(v.display_name ?? v.norm_vendor, 28)}
                        <span style={{ color: "var(--gc-text-secondary)" }}> ({Number(v.share_pct ?? 0).toFixed(1)}%)</span>
                      </div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 3 — Region
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 1.5rem" }}>
        Region-segmented concentration is <strong>not available</strong> in this release: the <code className="font-mono">contracts</code> ETL does not load <code className="font-mono">buyer_region</code>, <code className="font-mono">delivery_region</code>, postal code, or any other geographic field. When these are ingested, the <code className="font-mono">mv_vendor_concentration_by_region</code> MV will be populated using the same schema as <code className="font-mono">_by_category</code>.
      </p>

      {/* Section 4 — Vendor-name normalization warnings */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 4 — Vendor-Name Normalization Warnings
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_vendor_name_dupes</code>. Each row is a cluster of distinct
        normalized-vendor IDs whose raw <code className="font-mono">vendor_name</code> strings collapse to the
        same alpha-only key after stripping common legal suffixes (Inc, Ltd, Corp, Group, Canada, etc.). These
        are <strong>candidate near-duplicates</strong> that the family-rule normalization in
        {" "}<code className="font-mono">lib/vendor-normalization.ts</code> did <em>not</em> catch — meaning
        concentration metrics (HHI, CR4, CR10, top-vendor share) are likely <strong>under-stated</strong> for
        these names. Filtered to clusters with combined spend &gt; $1M. PostgreSQL <code className="font-mono">fuzzystrmatch</code>
        and <code className="font-mono">pg_trgm</code> are not available on Azure Database for PostgreSQL Flexible
        Server, so similarity is detected via stripped-key collision rather than edit distance. Some clusters may
        be genuine distinct entities sharing a stripped key — review before merging.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <th style={th}>#</th>
              <th style={th}>Distinct normalized IDs (cluster)</th>
              <th style={th}>Sample raw names</th>
              <SortableHeader columnKey="distinct" label="IDs" sort={sortDupe as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} info="Number of distinct normalized_vendor IDs in this cluster. Each is currently treated as a separate vendor by the concentration metrics, even though they likely refer to the same legal entity." />
              <SortableHeader columnKey="variants" label="Raw variants" sort={sortDupe as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} info="Number of distinct raw vendor_name strings in the cluster (e.g. 'Irving Shipbuilding Inc' vs 'Irving Shipbuilding Inc.' counts as two variants)." />
              <SortableHeader columnKey="spend" label="Combined spend" sort={sortDupe as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort2: sp.sort2 as string, dir2: sp.dir2 as string, sort3: sp.sort3 as string, dir3: sp.dir3 as string }} info="Sum of effective contract value across every raw vendor_name in the cluster. The amount that is currently scattered across multiple normalized IDs and would be consolidated under a single vendor if the cluster were merged." />
            </tr>
          </thead>
          <tbody>
            {dupeRows.map((r, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)", verticalAlign: "top" }}>
                <td style={td}>{i + 1}</td>
                <td style={{ ...td, fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
                  {(r.norm_vendors ?? []).map((v, j) => (
                    <div key={j}>{v}</div>
                  ))}
                </td>
                <td style={{ ...td, fontSize: "0.75rem" }}>
                  {(r.sample_names ?? []).slice(0, 4).map((n, j) => (
                    <div key={j} style={{ color: "var(--gc-text-secondary)" }}>{truncate(n, 42)}</div>
                  ))}
                  {(r.sample_names?.length ?? 0) > 4 && (
                    <div style={{ color: "var(--gc-text-secondary)", fontStyle: "italic" }}>
                      + {r.sample_names.length - 4} more
                    </div>
                  )}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                  {r.distinct_norm}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {r.variant_count}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--gc-accent)" }}>
                  {fmtDollars(Number(r.cluster_spend))}
                </td>
              </tr>
            ))}
            {dupeRows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: "1rem", textAlign: "center", color: "var(--gc-text-secondary)" }}>
                  No near-duplicate vendor-name clusters above the $1M threshold.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Section 5 — Full-market approximation (continuity) */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 5 — Full-Market Approximation (Services)
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Full-market approximation across <em>all</em> service contracts using normalized vendor names. Kept for continuity with earlier versions of this page. Top-50 vendors drive the treemap; overall shares and concentration below are computed from them against the full-market total.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <StatCard label="Service contracts scanned" value={totalContracts.toLocaleString()} />
        <StatCard label="Unique normalized vendors" value={uniqueVendorsFullMarket.toLocaleString()} />
        <StatCard label="Top 5 share (of full market)" value={`${fullMarketTop5Share.toFixed(1)}%`} accent />
        <StatCard label="Top 10 share (of full market)" value={`${fullMarketTop10Share.toFixed(1)}%`} accent />
      </div>
      <VendorTreemapChart treemapData={top20} barData={top10} />

      <h3 style={{ fontSize: "1rem", margin: "1.25rem 0 0.5rem" }}>
        Top 20 Vendors by Service Contract Value (full market)
      </h3>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <th style={th}>#</th>
              <SortableHeader columnKey="vendor" label="Vendor (normalized)" sort={sortVendor as any} align="left" defaultDir="asc" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort2: sp.sort2 as string, dir2: sp.dir2 as string }} />
              <SortableHeader columnKey="total_value" label="Total value" sort={sortVendor as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort2: sp.sort2 as string, dir2: sp.dir2 as string }} />
              <SortableHeader columnKey="share" label="Share" sort={sortVendor as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort2: sp.sort2 as string, dir2: sp.dir2 as string }} info="Vendor's share of total federal services-contract spending: vendor's total value divided by services-spending total across the full market." />
              <SortableHeader columnKey="contracts" label="Contracts" sort={sortVendor as any} align="right" style={th} preserve={{ sort1: sp.sort1 as string, dir1: sp.dir1 as string, sort2: sp.sort2 as string, dir2: sp.dir2 as string }} />
            </tr>
          </thead>
          <tbody>
            {allVendors.slice(0, 20).map((v, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                <td style={td}>{i + 1}</td>
                <td style={td}>{v.display_name ?? v.norm_vendor}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(v.total_value))}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    color: "var(--gc-accent)",
                  }}
                >
                  {((Number(v.total_value) / grandTotal) * 100).toFixed(2)}%
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {Number(v.contract_count).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.5rem 0.75rem", fontWeight: 600 };
const td: React.CSSProperties = { padding: "0.4rem 0.75rem", borderBottom: "1px solid var(--gc-border)" };

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      style={{
        background: accent ? "var(--gc-accent)" : "var(--gc-bg-secondary)",
        color: accent ? "white" : "var(--gc-text)",
        borderRadius: 8,
        padding: "1rem",
        textAlign: "center",
      }}
    >
      <div className="font-mono" style={{ fontSize: "1.5rem", fontWeight: 700, lineHeight: 1.2 }}>
        {value}
      </div>
      <div style={{ fontSize: "0.8125rem", marginTop: "0.25rem", opacity: 0.85 }}>{label}</div>
    </div>
  );
}
