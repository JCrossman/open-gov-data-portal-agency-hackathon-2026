export const revalidate = 3600;
import { queryWithStatus } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import AmendmentCreepChart from "@/components/charts/AmendmentCreepChart";
import type { AmendmentDatum } from "@/components/charts/AmendmentCreepChart";
import { parseSort } from "@/lib/sort-params";
import SortableHeader from "@/components/SortableHeader";

function fmtDollars(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

interface ContinuityRow {
  vendor_name: string;
  normalized_vendor: string;
  original_value: number | null;
  effective_value: number | null;
  amendment_ratio: number | null;
  owner_org_title: string;
  contract_date: string;
}
interface C2SSRow {
  contract_key: string;
  normalized_vendor: string;
  owner_org_title: string;
  first_reported: string;
  last_reported: string;
  original_value: number | null;
  max_effective_value: number | null;
  amendment_count: number;
  initial_solicitation_procedure: string;
  final_solicitation_procedure: string;
  status_transitions: string;
}
interface ThresholdRow {
  normalized_vendor: string;
  owner_org_title: string;
  label: string;
  contracts_in_window: number;
  total_in_window: number | null;
  window_start: string;
}
interface FollowOnRow {
  contract_key: string;
  normalized_vendor: string;
  owner_org_title: string;
  win_date: string;
  competitive_value: number | null;
  followon_tn_count: number;
  followon_tn_value: number | null;
}

const SORT_ALLOWED = {
  vendor: "normalized_vendor",
  original_value: "original_value",
  effective_value: "effective_value",
  amendment_ratio: "amendment_ratio",
  department: "owner_org_title",
} as const;

type SortKey = keyof typeof SORT_ALLOWED;

export default async function AmendmentCreepPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const sort = parseSort(sp, SORT_ALLOWED, "amendment_ratio", "desc") as any as import("@/lib/sort-params").SortResult<SortKey>;

  const [scannedRes, flaggedRes, c2ssRes, thresholdRes, followOnRes] = await Promise.all([
    queryWithStatus<{ n: number }>(`SELECT * FROM mv_sole_source_count`),
    queryWithStatus<ContinuityRow>(
      `SELECT * FROM mv_amendment_creep ORDER BY ${sort.orderBySql}`,
    ),
    queryWithStatus<C2SSRow>(
      `SELECT * FROM mv_competitive_to_sole_source ORDER BY max_effective_value DESC NULLS LAST LIMIT 30`,
    ),
    queryWithStatus<ThresholdRow>(
      `SELECT * FROM mv_threshold_splitting ORDER BY contracts_in_window DESC LIMIT 30`,
    ),
    queryWithStatus<FollowOnRow>(
      `SELECT * FROM mv_same_vendor_followon ORDER BY followon_tn_value DESC NULLS LAST LIMIT 30`,
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
        Challenge 4: Sole Source &amp; Amendment Creep
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
        Which contracts started small and competitive but grew large through
        sole-source amendments? This page reconstructs per-contract history
        across quarterly amendment snapshots and surfaces four complementary
        signals: amendment creep on sole-source contracts, competitive → sole-
        source procedure drift, threshold splitting, and follow-on sole-source
        work after a competitive win. Amendment ratios alone are not evidence
        of abuse — these are leads for review.
      </blockquote>
    </>
  );

  if (!scannedRes.ok || !flaggedRes.ok || !c2ssRes.ok || !thresholdRes.ok || !followOnRes.ok) {
    const err = [scannedRes, flaggedRes, c2ssRes, thresholdRes, followOnRes]
      .find((r) => !r.ok)!;
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
        {header}
        <DataUnavailableBanner
          scope="Amendment-creep findings (mv_amendment_creep / mv_competitive_to_sole_source / mv_threshold_splitting / mv_same_vendor_followon)"
          error={err.ok ? undefined : err.error}
        />
      </div>
    );
  }

  const totalScanned = scannedRes.rows[0]?.n ?? 0;
  const flagged = flaggedRes.rows;
  const c2ss = c2ssRes.rows;
  const threshold = thresholdRes.rows;
  const followOn = followOnRes.rows;

  const top15 = flagged.slice(0, 15);
  const chartData: AmendmentDatum[] = top15.map((c) => ({
    vendor: truncate(c.vendor_name ?? "", 20),
    amendmentRatio: Number(c.amendment_ratio) || 0,
    originalValue: Number(c.original_value) || 0,
    effectiveValue: Number(c.effective_value) || 0,
  }));

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      {header}

      {/* Top-level stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        <StatCard label="Sole-source contract snapshots (TN)" value={totalScanned.toLocaleString()} />
        <StatCard
          label="Continuity-flagged relationships (ratio > 2×, value > $500K)"
          value={flagged.length.toLocaleString()}
          accent
        />
        <StatCard
          label="Competitive → sole-source transitions"
          value={c2ss.length > 0 ? `${c2ss.length}+ (top 30 shown)` : "0"}
          accent
        />
        <StatCard
          label="Threshold-split vendor-dept pairs"
          value={threshold.length > 0 ? `${threshold.length}+ (top 30 shown)` : "0"}
        />
      </div>

      {/* Section 1: Continuity-deduped flagged relationships (existing) */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 1 — Continuity-deduped Flagged Vendor-Department Relationships
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_amendment_creep</code>. Sole-source (TN) contracts with amendment ratio &gt; 2× and effective value &gt; $500K, deduplicated across quarterly amendment snapshots by (normalized vendor, department, original value) and keeping the largest observed effective value.
      </p>
      <figure style={{ margin: "0 0 1.5rem" }}>
        <figcaption style={{ fontWeight: 600, fontSize: "1rem", marginBottom: "0.5rem", color: "var(--gc-primary)" }}>
          Top 15 by Amendment Ratio
        </figcaption>
        <AmendmentCreepChart data={chartData} />
      </figure>
      <div style={{ overflowX: "auto", marginBottom: "2.5rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <th style={th}>#</th>
              <SortableHeader
                columnKey="vendor"
                label="Vendor (normalized)"
                sort={sort}
                align="left"
                defaultDir="asc"
                style={th}
              />
              <SortableHeader
                columnKey="original_value"
                label="Original"
                sort={sort}
                align="right"
                defaultDir="desc"
                style={th}
                info="Original contract value as awarded — i.e. the dollar amount of the initial competitive bid before any amendments."
              />
              <SortableHeader
                columnKey="effective_value"
                label="Effective"
                sort={sort}
                align="right"
                defaultDir="desc"
                style={th}
                info="Latest reported total contract value after all amendments, change orders, and option exercises. The dollar amount the government has actually committed."
              />
              <SortableHeader
                columnKey="amendment_ratio"
                label="Ratio"
                sort={sort}
                align="right"
                defaultDir="desc"
                style={th}
                info="Effective value divided by original value. A ratio of 5× means the contract grew to five times its original awarded amount through amendments. Only contracts where the ratio is above 2× and the effective value exceeds $500K are shown."
              />
              <SortableHeader
                columnKey="department"
                label="Department"
                sort={sort}
                align="left"
                defaultDir="asc"
                style={th}
              />
            </tr>
          </thead>
          <tbody>
            {flagged.slice(0, 20).map((c, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                <td style={td}>{i + 1}</td>
                <td style={td}>{c.normalized_vendor ?? c.vendor_name}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(c.original_value))}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(c.effective_value))}
                </td>
                <td style={{ ...td, textAlign: "right", fontWeight: 700, color: "var(--gc-accent)", fontFamily: "var(--font-mono)" }}>
                  {Number(c.amendment_ratio)?.toFixed(1)}×
                </td>
                <td style={td}>{truncate(c.owner_org_title ?? "", 40)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Section 2: Competitive → TN transitions */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 2 — Competitive → Sole-Source Procedure Drift
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_competitive_to_sole_source</code>. Contracts whose earliest observed solicitation procedure was competitive (TC / TO / AC / OB) but whose latest observed procedure is TN, OR whose amendment history introduces TN after a competitive code. Filtered to max effective value &gt; $100K.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2.5rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <th style={th}>#</th>
              <th style={th}>Contract Key</th>
              <th style={th}>Vendor</th>
              <th style={th}>Department</th>
              <th style={th}>Initial → Final</th>
              <th style={{ ...th, textAlign: "right" }}>Amendments</th>
              <th style={{ ...th, textAlign: "right" }}>Effective</th>
            </tr>
          </thead>
          <tbody>
            {c2ss.slice(0, 15).map((r, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                <td style={td}>{i + 1}</td>
                <td style={{ ...td, fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
                  {truncate(r.contract_key, 28)}
                </td>
                <td style={td}>{r.normalized_vendor}</td>
                <td style={td}>{truncate(r.owner_org_title ?? "", 32)}</td>
                <td style={{ ...td, fontFamily: "var(--font-mono)" }}>
                  {r.initial_solicitation_procedure} → {r.final_solicitation_procedure}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>{r.amendment_count}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(r.max_effective_value))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Section 3: Threshold splitting */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 3 — Threshold-Splitting Leads
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_threshold_splitting</code>. Vendor–department pairs with 3+ contracts in any rolling 12-month window whose original value falls within 20% below a common procurement threshold (~$25K, ~$40K, ~$400K). These are leads, not findings: <code className="font-mono">limited_tendering_reason</code> and <code className="font-mono">country_of_vendor</code> are not loaded in the current ETL, so we cannot filter out legitimate trade-agreement exclusions.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2.5rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <th style={th}>#</th>
              <th style={th}>Vendor</th>
              <th style={th}>Department</th>
              <th style={th}>Threshold</th>
              <th style={{ ...th, textAlign: "right" }}>Contracts in 12 mo</th>
              <th style={{ ...th, textAlign: "right" }}>Window total</th>
              <th style={th}>Window start</th>
            </tr>
          </thead>
          <tbody>
            {threshold.slice(0, 15).map((r, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                <td style={td}>{i + 1}</td>
                <td style={td}>{r.normalized_vendor}</td>
                <td style={td}>{truncate(r.owner_org_title ?? "", 32)}</td>
                <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{r.label}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                  {r.contracts_in_window}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(r.total_in_window))}
                </td>
                <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{r.window_start}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Section 4: Same-vendor follow-on sole-source */}
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
        Section 4 — Same-Vendor Follow-On Sole-Source Work
      </h2>
      <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", margin: "0 0 0.75rem" }}>
        Source: <code className="font-mono">mv_same_vendor_followon</code>. For each competitive win (TC / TO / AC / OB, value ≥ $100K), this shows whether the same vendor received TN contracts from the same department within the following 24 months. Incumbency is not inherently problematic, but concentrated follow-on TN work is a procurement-relationship signal worth reviewing.
      </p>
      <div style={{ overflowX: "auto", marginBottom: "2.5rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
          <thead>
            <tr style={{ background: "var(--gc-primary)", color: "white", textAlign: "left" }}>
              <th style={th}>#</th>
              <th style={th}>Vendor</th>
              <th style={th}>Department</th>
              <th style={th}>Competitive win</th>
              <th style={{ ...th, textAlign: "right" }}>Win value</th>
              <th style={{ ...th, textAlign: "right" }}>Follow-on TN #</th>
              <th style={{ ...th, textAlign: "right" }}>Follow-on TN $</th>
            </tr>
          </thead>
          <tbody>
            {followOn.slice(0, 15).map((r, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-stripe)" }}>
                <td style={td}>{i + 1}</td>
                <td style={td}>{r.normalized_vendor}</td>
                <td style={td}>{truncate(r.owner_org_title ?? "", 32)}</td>
                <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{r.win_date}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(r.competitive_value))}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                  {r.followon_tn_count}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                  {fmtDollars(Number(r.followon_tn_value))}
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
