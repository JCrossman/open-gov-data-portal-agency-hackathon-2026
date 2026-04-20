export const dynamic = "force-dynamic";
import { queryWithStatus } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";

function fmtDollars(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000_000) return `${v < 0 ? "-" : ""}$${Math.abs(v / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(v) >= 1_000_000) return `${v < 0 ? "-" : ""}$${Math.abs(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${v < 0 ? "-" : ""}$${Math.abs(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

const COMMODITY_LABELS: Record<string, string> = {
  S: "Services",
  G: "Goods",
  C: "Construction",
  "*ALL*": "All contracts",
};

const SOLICITATION_LABELS: Record<string, string> = {
  TN: "Sole Source (TN)",
  TC: "Competitive (TC)",
  OB: "Open Bidding (OB)",
};

interface CategoryRow {
  code: string;
  count: number;
  total_value: number;
}
interface YearlyRow {
  fiscal_year: number;
  code: string;
  contract_count: number;
  total_value: number;
  unique_vendors: number;
  distinct_departments: number;
}
interface GrowthRow {
  commodity_type: string;
  fiscal_year: number;
  total_value: number;
  total_prev: number | null;
  delta_total: number | null;
  yoy_pct: number | null;
  volume_component: number | null;
  unit_cost_component: number | null;
  hhi: number | null;
  hhi_prev: number | null;
  concentration_change: number | null;
}
interface BucketYoYRow {
  fiscal_year: number;
  owner_org_title: string;
  commodity_type: string;
  contract_count: number;
  total_value: number;
  avg_value: number;
  vendor_count: number;
  hhi: number | null;
  total_prev: number | null;
  count_prev: number | null;
  avg_prev: number | null;
  hhi_prev: number | null;
  delta_total_pct: number | null;
  delta_count_pct: number | null;
  delta_avg_pct: number | null;
  delta_hhi: number | null;
}

function shortDept(name: string): string {
  return name.split(" | ")[0];
}

export default async function ContractIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // Helper to safely extract string values from searchParams
  const toStr = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  // Table 1: Growth decomposition (topGrowth) - sort1/dir1
  const sort1 = parseSort(
    sp,
    {
      category: "commodity_type",
      fiscal_year: "fiscal_year",
      total_value: "total_value",
      delta_total: "delta_total",
      yoy_pct: "yoy_pct",
      volume_component: "volume_component",
      unit_cost_component: "unit_cost_component",
      concentration_change: "concentration_change",
    },
    "delta_total",
    "desc",
    "sort1",
    "dir1"
  );

  // Table 2: Annual volume (recentYears) - sort2/dir2
  const sort2 = parseSort(
    sp,
    {
      fiscal_year: "fiscal_year",
      contract_count: "contract_count",
      total_value: "total_value",
      unique_vendors: "unique_vendors",
      distinct_departments: "distinct_departments",
    },
    "fiscal_year",
    "desc",
    "sort2",
    "dir2"
  );

  // Table 3: Commodity type - sort3/dir3
  const sort3 = parseSort(
    sp,
    { code: "code", count: "count", total_value: "total_value", share: "total_value" },
    "total_value",
    "desc",
    "sort3",
    "dir3"
  );

  // Table 4: Solicitation procedure - sort4/dir4
  const sort4 = parseSort(
    sp,
    { code: "code", count: "count", total_value: "total_value", share: "total_value" },
    "total_value",
    "desc",
    "sort4",
    "dir4"
  );

  // Table 5: Bucket-level YoY decomposition (top 30 dept × commodity_type)
  const sort5 = parseSort(
    sp,
    {
      bucket: "owner_org_title",
      fiscal_year: "fiscal_year",
      total_value: "total_value",
      delta_total_pct: "delta_total_pct",
      delta_count_pct: "delta_count_pct",
      delta_avg_pct: "delta_avg_pct",
      delta_hhi: "delta_hhi",
    },
    "delta_total_pct",
    "desc",
    "sort5",
    "dir5"
  );

  const [totalRes, commodityRes, solicitationRes, yearlyRes, growthRes, bucketRes, bucketLatestRes] = await Promise.all([
    queryWithStatus<{ n: number }>(`SELECT n FROM mv_table_counts WHERE tbl = 'contracts'`),
    queryWithStatus<CategoryRow>(`SELECT * FROM mv_contract_commodity ORDER BY ${sort3.orderBySql}`),
    queryWithStatus<CategoryRow>(`SELECT * FROM mv_contract_solicitation ORDER BY ${sort4.orderBySql}`),
    queryWithStatus<YearlyRow>(
      `SELECT * FROM mv_contract_yearly WHERE fiscal_year BETWEEN 2004 AND 2026 ORDER BY fiscal_year, code`,
    ),
    queryWithStatus<GrowthRow>(
      `SELECT * FROM mv_contract_growth_decomposition WHERE fiscal_year BETWEEN 2005 AND 2025 ORDER BY commodity_type, fiscal_year`,
    ),
    queryWithStatus<BucketYoYRow>(
      `SELECT * FROM mv_contract_yoy_decomposition WHERE delta_total_pct IS NOT NULL ORDER BY owner_org_title, commodity_type, fiscal_year`,
    ),
    queryWithStatus<{ y: number }>(
      `SELECT MAX(fiscal_year)::int AS y FROM mv_contract_yoy_decomposition WHERE total_prev IS NOT NULL AND fiscal_year < EXTRACT(YEAR FROM CURRENT_DATE)`,
    ),
  ]);

  const header = (
    <>
      <a
        href="/challenges"
        style={{ color: "var(--gc-secondary)", textDecoration: "none", fontSize: "0.875rem" }}
      >
        &larr; Back to Challenges
      </a>
      <h1 style={{ fontSize: "2rem", marginTop: "0.75rem", marginBottom: "0.5rem" }}>
        Challenge 9: Contract Intelligence
      </h1>
    </>
  );

  if (!totalRes.ok || !commodityRes.ok || !solicitationRes.ok || !yearlyRes.ok || !growthRes.ok || !bucketRes.ok || !bucketLatestRes.ok) {
    const err = [totalRes, commodityRes, solicitationRes, yearlyRes, growthRes, bucketRes, bucketLatestRes].find((r) => !r.ok)!;
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        {header}
        <DataUnavailableBanner
          scope="Contract-intelligence findings (mv_contract_commodity / _solicitation / _yearly / _growth_decomposition / _yoy_decomposition)"
          error={err.ok ? undefined : err.error}
        />
      </div>
    );
  }

  const totalContracts = totalRes.rows[0]?.n ?? 0;
  const commodityRows = commodityRes.rows;
  const solicitationRows = solicitationRes.rows;
  const yearlyRows = yearlyRes.rows;
  const growthRows = growthRes.rows;

  const commodityContracts = commodityRows.reduce((s, r) => s + Number(r.count), 0);
  const commodityTotal = commodityRows.reduce((s, r) => s + Number(r.total_value), 0);
  const solicitationContracts = solicitationRows.reduce((s, r) => s + Number(r.count), 0);
  const solicitationTotal = solicitationRows.reduce((s, r) => s + Number(r.total_value), 0);

  const soleSourceRow = solicitationRows.find((r) => r.code === "TN");
  const soleSourcePct = solicitationTotal > 0 && soleSourceRow
    ? (Number(soleSourceRow.total_value) / solicitationTotal) * 100
    : 0;

  const commodityCoveragePct = totalContracts > 0 ? (commodityContracts / totalContracts) * 100 : 0;
  const solicitationCoveragePct = totalContracts > 0 ? (solicitationContracts / totalContracts) * 100 : 0;

  // Top 10 growth events - sort in JS
  const getSortValue1 = (row: GrowthRow): number | string => {
    const key = sort1.key as string;
    switch (key) {
      case "category": return row.commodity_type;
      case "fiscal_year": return row.fiscal_year;
      case "total_value": return Number(row.total_value);
      case "delta_total": return Number(row.delta_total ?? 0);
      case "yoy_pct": return Number(row.yoy_pct ?? 0);
      case "volume_component": return Number(row.volume_component ?? 0);
      case "unit_cost_component": return Number(row.unit_cost_component ?? 0);
      case "concentration_change": return Number(row.concentration_change ?? 0);
      default: return 0;
    }
  };

  const topGrowth = growthRows
    .filter((g) => g.delta_total !== null)
    .slice()
    .sort((a, b) => {
      const aVal = getSortValue1(a);
      const bVal = getSortValue1(b);
      if (sort1.direction === "asc") {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
      }
    })
    .slice(0, 10);

  // Year totals - sort in JS
  const getSortValue2 = (row: YearlyRow): number => {
    const key = sort2.key as string;
    switch (key) {
      case "fiscal_year": return row.fiscal_year;
      case "contract_count": return Number(row.contract_count);
      case "total_value": return Number(row.total_value);
      case "unique_vendors": return Number(row.unique_vendors);
      case "distinct_departments": return Number(row.distinct_departments);
      default: return 0;
    }
  };

  const yearAllRows = yearlyRows.filter((r) => r.code === "*ALL*");
  const sortedYearRows = yearAllRows.slice().sort((a, b) => {
    const aVal = getSortValue2(a);
    const bVal = getSortValue2(b);
    if (sort2.direction === "asc") {
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    } else {
      return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
    }
  });
  const recentYears = sortedYearRows.slice(-8);

  // Bucket-level YoY decomposition (top 30 dept × commodity_type buckets)
  const bucketRows = bucketRes.rows;
  const latestYoYYear = bucketLatestRes.rows[0]?.y ?? 0;
  const latestBuckets = bucketRows.filter(
    (r) => r.fiscal_year === latestYoYYear && r.delta_total_pct !== null,
  );

  const getSortValue5 = (row: BucketYoYRow): number | string => {
    const key = sort5.key as string;
    switch (key) {
      case "bucket": return `${row.owner_org_title}|${row.commodity_type}`;
      case "fiscal_year": return row.fiscal_year;
      case "total_value": return Number(row.total_value);
      case "delta_total_pct": return Number(row.delta_total_pct ?? 0);
      case "delta_count_pct": return Number(row.delta_count_pct ?? 0);
      case "delta_avg_pct": return Number(row.delta_avg_pct ?? 0);
      case "delta_hhi": return Number(row.delta_hhi ?? 0);
      default: return 0;
    }
  };
  const sortedBuckets = latestBuckets.slice().sort((a, b) => {
    const aVal = getSortValue5(a);
    const bVal = getSortValue5(b);
    if (sort5.direction === "asc") {
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    } else {
      return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
    }
  });

  // Highlight rules
  // - unit-cost driven: total grew (delta_total_pct > 5) but count fell (delta_count_pct < 0)
  // - concentration driven: HHI rose materially (delta_hhi > 200)
  const isUnitCostDriven = (r: BucketYoYRow) =>
    Number(r.delta_total_pct ?? 0) > 5 && Number(r.delta_count_pct ?? 0) < 0;
  const isConcentrationDriven = (r: BucketYoYRow) =>
    Number(r.delta_hhi ?? 0) > 200;

  const preserveBucket = {
    sort1: toStr(sp.sort1), dir1: toStr(sp.dir1),
    sort2: toStr(sp.sort2), dir2: toStr(sp.dir2),
    sort3: toStr(sp.sort3), dir3: toStr(sp.dir3),
    sort4: toStr(sp.sort4), dir4: toStr(sp.dir4),
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      {header}

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
        What is Canada actually buying, and is it paying more over time? This page
        pairs the composition snapshot (what share goes to services, goods,
        construction, and sole-source procedures) with a year-over-year growth
        decomposition: for each category-year we separate Δspend into a volume
        component (more contracts) and a unit-cost component (higher average
        price), plus a structural change in vendor concentration (ΔHHI). Window
        restricted to 2004–2026 to exclude ingest artefacts.
      </blockquote>

      {/* PRIMARY: where is Canada paying more over time */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 1 — Where is Canada paying more over time?
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_contract_growth_decomposition</code>. Bennet decomposition: ΔTotal = Volume × avg(P) + ΔP × avg(Q). Top 10 category-years by absolute Δtotal.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <SortableHeader columnKey="category" label="Category" sort={sort1 as any} preserve={{sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="fiscal_year" label="Fiscal year" sort={sort1 as any} preserve={{sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="total_value" label="Total" sort={sort1 as any} align="right" preserve={{sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="delta_total" label="Δ total" sort={sort1 as any} align="right" defaultDir="desc" preserve={{sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} info="Year-over-year change in total contract dollars for this category. Positive = spending grew; negative = spending shrank versus the previous fiscal year." />
              <SortableHeader columnKey="yoy_pct" label="YoY %" sort={sort1 as any} align="right" preserve={{sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} info="Year-over-year percentage change in total spending for this category — Δ total divided by the prior year's total." />
              <SortableHeader columnKey="volume_component" label="Volume comp." sort={sort1 as any} align="right" preserve={{sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} info="Portion of the year-over-year change attributable to buying more (or fewer) contracts at the prior year's average unit price. Bennet decomposition: (Q − Q_prev) × (P + P_prev) / 2." />
              <SortableHeader columnKey="unit_cost_component" label="Unit-cost comp." sort={sort1 as any} align="right" preserve={{sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} info="Portion of the year-over-year change attributable to higher (or lower) average price per contract, holding volume constant. Bennet decomposition: (P − P_prev) × (Q + Q_prev) / 2. Volume + unit-cost components add up to Δ total." />
              <SortableHeader columnKey="concentration_change" label="Δ HHI" sort={sort1 as any} align="right" preserve={{sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} info="Year-over-year change in the Herfindahl-Hirschman Index of vendor shares within this category. Positive = market became more concentrated; negative = more competitive." />
            </tr>
          </thead>
          <tbody>
            {topGrowth.map((g, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                <td style={td}>
                  <strong>{g.commodity_type}</strong> — {COMMODITY_LABELS[g.commodity_type] ?? g.commodity_type}
                </td>
                <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{g.fiscal_year}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(g.total_value))}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 700,
                    color: Number(g.delta_total ?? 0) > 0 ? "var(--gc-accent)" : "inherit",
                  }}
                >
                  {fmtDollars(Number(g.delta_total ?? 0))}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {g.yoy_pct === null ? "—" : `${Number(g.yoy_pct).toFixed(1)}%`}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(g.volume_component ?? 0))}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(g.unit_cost_component ?? 0))}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {g.concentration_change === null ? "—" : Number(g.concentration_change).toFixed(0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 2 — Cost growth decomposition by buyer × category (top 30 buckets, latest complete year {latestYoYYear})
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_contract_yoy_decomposition</code>. For each (department × commodity type) bucket
        we compare {latestYoYYear} to {latestYoYYear - 1}: total spend (Δtotal&nbsp;%), volume (Δcount&nbsp;%),
        unit‑cost proxy (Δavg&nbsp;%), and vendor concentration (ΔHHI on normalized vendor shares × 10,000).
        Highlighted rows: <span style={{ background: "rgba(241, 196, 15, 0.25)", padding: "0 4px" }}>amber</span> = total grew
        but contract count fell (unit‑cost driven);
        <span style={{ background: "rgba(231, 76, 60, 0.18)", padding: "0 4px", marginLeft: 4 }}>red</span> = HHI rose by
        more than 200 points (market concentrated). Buckets ranked by total {latestYoYYear} spend.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <SortableHeader columnKey="bucket" label="Department × type" sort={sort5 as any} preserve={preserveBucket} />
              <SortableHeader columnKey="fiscal_year" label="Year" sort={sort5 as any} preserve={preserveBucket} />
              <SortableHeader columnKey="total_value" label="Total $" sort={sort5 as any} align="right" defaultDir="desc" preserve={preserveBucket} />
              <SortableHeader columnKey="delta_total_pct" label="YoY total %" sort={sort5 as any} align="right" defaultDir="desc" preserve={preserveBucket} info="Year-over-year percentage change in total contract dollars for this bucket." />
              <SortableHeader columnKey="delta_count_pct" label="YoY count %" sort={sort5 as any} align="right" preserve={preserveBucket} info="Volume signal: year-over-year percentage change in number of contracts. Negative count + positive total = growth driven by larger individual contracts." />
              <SortableHeader columnKey="delta_avg_pct" label="YoY avg $ %" sort={sort5 as any} align="right" preserve={preserveBucket} info="Unit-cost proxy: year-over-year percentage change in average contract value (total / count) for this bucket." />
              <SortableHeader columnKey="delta_hhi" label="YoY HHI Δ" sort={sort5 as any} align="right" preserve={preserveBucket} info="Absolute change in the Herfindahl–Hirschman Index of vendor shares (×10,000) within this bucket. Positive = market concentrated; negative = more competitive." />
            </tr>
          </thead>
          <tbody>
            {sortedBuckets.length === 0 && (
              <tr><td colSpan={7} style={{ ...td, textAlign: "center", fontStyle: "italic" }}>No bucket-level YoY data available for {latestYoYYear}.</td></tr>
            )}
            {sortedBuckets.map((r, i) => {
              const unitCost = isUnitCostDriven(r);
              const concDriven = isConcentrationDriven(r);
              let bg: string = i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)";
              if (concDriven) bg = "rgba(231, 76, 60, 0.18)";
              else if (unitCost) bg = "rgba(241, 196, 15, 0.25)";
              return (
                <tr key={`${r.owner_org_title}-${r.commodity_type}-${r.fiscal_year}`} style={{ background: bg }}>
                  <td style={td}>
                    <strong>{shortDept(r.owner_org_title)}</strong>{" "}
                    <span style={{ color: "var(--gc-text-secondary)" }}>
                      ({COMMODITY_LABELS[r.commodity_type] ?? r.commodity_type})
                    </span>
                  </td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{r.fiscal_year}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {fmtDollars(Number(r.total_value))}
                  </td>
                  <td
                    style={{
                      ...td,
                      textAlign: "right",
                      fontFamily: "var(--font-mono)",
                      fontWeight: 700,
                      color: Number(r.delta_total_pct ?? 0) > 0 ? "var(--gc-accent)" : "inherit",
                    }}
                  >
                    {r.delta_total_pct === null ? "—" : `${Number(r.delta_total_pct).toFixed(1)}%`}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {r.delta_count_pct === null ? "—" : `${Number(r.delta_count_pct).toFixed(1)}%`}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {r.delta_avg_pct === null ? "—" : `${Number(r.delta_avg_pct).toFixed(1)}%`}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {r.delta_hhi === null ? "—" : Number(r.delta_hhi).toFixed(0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 3 — Annual Contract Volume &amp; Spend (all categories)
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_contract_yearly</code>. Last 8 fiscal years in the 2004–2026 window (<code className="font-mono">code = &apos;*ALL*&apos;</code>).
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <SortableHeader columnKey="fiscal_year" label="Fiscal year" sort={sort2 as any} preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="contract_count" label="Contracts" sort={sort2 as any} align="right" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="total_value" label="Total value" sort={sort2 as any} align="right" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="unique_vendors" label="Unique vendors" sort={sort2 as any} align="right" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="distinct_departments" label="Distinct departments" sort={sort2 as any} align="right" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
            </tr>
          </thead>
          <tbody>
            {recentYears.map((y, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{y.fiscal_year}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {Number(y.contract_count).toLocaleString()}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(y.total_value))}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {Number(y.unique_vendors).toLocaleString()}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {Number(y.distinct_departments).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* SECONDARY: existing composition snapshot */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 4 — Composition Snapshot (all-time)
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
          marginBottom: "1rem",
        }}
      >
        <StatCard label="Contracts scanned (all)" value={totalContracts.toLocaleString()} />
        <StatCard
          label="Total value (commodity-classified subset)"
          value={fmtDollars(commodityTotal)}
        />
        <StatCard label="Commodity types observed" value={commodityRows.length.toString()} />
        <StatCard
          label="Sole-source share (of contracts with procedure recorded)"
          value={`${soleSourcePct.toFixed(1)}%`}
        />
      </div>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 1.5rem" }}>
        Coverage: commodity classification is present on {commodityContracts.toLocaleString()} contracts ({commodityCoveragePct.toFixed(1)}% of all); solicitation procedure on {solicitationContracts.toLocaleString()} ({solicitationCoveragePct.toFixed(1)}%). Shares below are computed within each coverage subset, not the full contracts table.
      </p>

      <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
        Commodity type
      </h3>
      <div style={{ overflowX: "auto", marginBottom: "1.5rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
              <SortableHeader columnKey="code" label="Code" sort={sort3 as any} preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Category</th>
              <SortableHeader columnKey="count" label="Contracts" sort={sort3 as any} align="right" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="total_value" label="Total value" sort={sort3 as any} align="right" defaultDir="desc" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} />
              <SortableHeader columnKey="share" label="Share (of classified)" sort={sort3 as any} align="right" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort4:toStr(sp.sort4),dir4:toStr(sp.dir4)}} info="This commodity type's share of total contract value across all rows that carry a commodity classification (S/G/C). Excludes contracts with no commodity_type recorded." />
            </tr>
          </thead>
          <tbody>
            {commodityRows.map((r, i) => {
              const share = commodityTotal > 0 ? (Number(r.total_value) / commodityTotal) * 100 : 0;
              return (
                <tr key={r.code} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                  <td className="font-mono" style={{ padding: "0.5rem", fontWeight: 600 }}>{r.code}</td>
                  <td style={{ padding: "0.5rem" }}>{COMMODITY_LABELS[r.code] ?? r.code}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>
                    {Number(r.count).toLocaleString()}
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>
                    {fmtDollars(Number(r.total_value))}
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem", fontWeight: 700 }}>
                    {share.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
        Solicitation procedure
      </h3>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
              <SortableHeader columnKey="code" label="Code" sort={sort4 as any} preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3)}} />
              <th scope="col" style={{ textAlign: "left", padding: "0.5rem" }}>Procedure</th>
              <SortableHeader columnKey="count" label="Contracts" sort={sort4 as any} align="right" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3)}} />
              <SortableHeader columnKey="total_value" label="Total value" sort={sort4 as any} align="right" defaultDir="desc" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3)}} />
              <SortableHeader columnKey="share" label="Share (of recorded)" sort={sort4 as any} align="right" preserve={{sort1:toStr(sp.sort1),dir1:toStr(sp.dir1),sort2:toStr(sp.sort2),dir2:toStr(sp.dir2),sort3:toStr(sp.sort3),dir3:toStr(sp.dir3)}} info="This solicitation procedure's share of total contract value across all rows that carry a solicitation_procedure code. Excludes contracts where the procedure was not recorded." />
            </tr>
          </thead>
          <tbody>
            {solicitationRows.map((r, i) => {
              const share = solicitationTotal > 0 ? (Number(r.total_value) / solicitationTotal) * 100 : 0;
              return (
                <tr key={r.code} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                  <td className="font-mono" style={{ padding: "0.5rem", fontWeight: 600 }}>{r.code}</td>
                  <td style={{ padding: "0.5rem" }}>{SOLICITATION_LABELS[r.code] ?? r.code}</td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>
                    {Number(r.count).toLocaleString()}
                  </td>
                  <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>
                    {fmtDollars(Number(r.total_value))}
                  </td>
                  <td
                    className="font-mono"
                    style={{
                      textAlign: "right",
                      padding: "0.5rem",
                      fontWeight: 700,
                      color: r.code === "TN" ? "var(--gc-accent)" : "inherit",
                    }}
                  >
                    {share.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.5rem 0.75rem", fontWeight: 600 };
const td: React.CSSProperties = { padding: "0.4rem 0.75rem", borderBottom: "1px solid var(--gc-border)" };

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--gc-bg-secondary)",
        borderRadius: "8px",
        padding: "1rem",
        textAlign: "center",
        border: "1px solid var(--gc-border)",
      }}
    >
      <div className="font-mono" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
        {value}
      </div>
      <div style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)" }}>{label}</div>
    </div>
  );
}
