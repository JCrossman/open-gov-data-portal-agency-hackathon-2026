export const dynamic = "force-dynamic";
import { queryWithStatus } from "@/lib/db";
import DataUnavailableBanner from "@/components/DataUnavailableBanner";
import { getChallengeFindings } from "@/lib/findings";

async function getKPIs(): Promise<
  | { ok: true; contractCount: number; grantCount: number; charityCount: number; wrongdoingCount: number }
  | { ok: false; error: string }
> {
  const res = await queryWithStatus<{ tbl: string; n: number }>(
    `SELECT tbl, n FROM mv_table_counts`
  );
  if (!res.ok) return { ok: false, error: res.error };
  const counts = Object.fromEntries(res.rows.map((r) => [r.tbl, r.n]));
  return {
    ok: true,
    contractCount: counts.contracts ?? 0,
    grantCount: counts.grants ?? 0,
    charityCount: counts.t3010_id ?? 0,
    wrongdoingCount: counts.wrongdoing ?? 0,
  };
}

const challenges: Array<{ slug: string; num: number; title: string; desc: string }> = [
  { slug: "zombie-recipients", num: 1, title: "Zombie Recipients", desc: "Funded entities that ceased operations" },
  { slug: "ghost-capacity", num: 2, title: "Ghost Capacity", desc: "Funded orgs with no delivery capacity" },
  { slug: "funding-loops", num: 3, title: "Funding Loops", desc: "Circular money flows between charities" },
  { slug: "amendment-creep", num: 4, title: "Amendment Creep", desc: "Contracts that quietly outgrew justification" },
  { slug: "vendor-concentration", num: 5, title: "Vendor Concentration", desc: "Monopolistic procurement patterns" },
  { slug: "related-parties", num: 6, title: "Related Parties", desc: "Governance network overlaps" },
  { slug: "policy-misalignment", num: 7, title: "Policy Misalignment", desc: "Spending vs stated priorities" },
  { slug: "duplicative-funding", num: 8, title: "Duplicative Funding", desc: "Multi-department overlap" },
  { slug: "contract-intelligence", num: 9, title: "Contract Intelligence", desc: "Procurement trends and cost growth" },
  { slug: "adverse-media", num: 10, title: "Adverse Media", desc: "Red flag screening" },
];

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

export default async function DashboardPage() {
  const [kpis, findings] = await Promise.all([getKPIs(), getChallengeFindings()]);

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>
        Government Accountability Dashboard
      </h1>
      <p style={{ color: "var(--gc-text-secondary)", marginBottom: "2rem" }}>
        Querying 3M+ federal records in real time from{" "}
        <a href="https://open.canada.ca" style={{ color: "#0b3d68", textDecoration: "underline", fontWeight: 600 }}>
          open.canada.ca
        </a>
      </p>

      {/* Ask AI Banner now rendered globally from app/layout.tsx */}

      {/* KPI Cards */}
      <section aria-label="Key metrics">
        {kpis.ok ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "1rem",
              marginBottom: "2.5rem",
            }}
          >
            <KPICard label="Federal Contracts" value={formatNumber(kpis.contractCount)} />
            <KPICard label="Grants & Contributions" value={formatNumber(kpis.grantCount)} />
            <KPICard label="Registered Charities" value={formatNumber(kpis.charityCount)} />
            <KPICard
              label="Wrongdoing Cases"
              value={kpis.wrongdoingCount.toString()}
              accent
            />
          </div>
        ) : (
          <DataUnavailableBanner scope="Top-of-page KPI counts (mv_table_counts)" error={kpis.error} />
        )}
      </section>

      {/* Challenge Cards */}
      <section aria-label="Accountability challenges">
        <h2 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
          10 Accountability Challenges
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            gap: "1rem",
          }}
        >
          {challenges.map((c) => (
            <ChallengeCard
              key={c.slug}
              {...c}
              finding={findings[c.slug] ?? "Data unavailable"}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function KPICard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        background: accent ? "var(--gc-accent)" : "var(--gc-bg-secondary)",
        color: accent ? "white" : "var(--gc-text)",
        borderRadius: "8px",
        padding: "1.25rem",
        textAlign: "center",
      }}
    >
      <div
        className="font-mono"
        style={{ fontSize: "2rem", fontWeight: 700, lineHeight: 1.2 }}
        aria-live="polite"
      >
        {value}
      </div>
      <div style={{ fontSize: "0.875rem", marginTop: "0.25rem", opacity: 0.85 }}>
        {label}
      </div>
    </div>
  );
}

function ChallengeCard({
  num,
  title,
  desc,
  finding,
  slug,
}: {
  num: number;
  title: string;
  desc: string;
  finding: string;
  slug: string;
}) {
  return (
    <a
      href={`/challenges/${slug}`}
      style={{
        display: "block",
        background: "var(--gc-bg-secondary)",
        borderRadius: "8px",
        padding: "1.25rem",
        textDecoration: "none",
        color: "var(--gc-text)",
        border: "1px solid var(--gc-border)",
        transition: "box-shadow 0.15s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <span
          className="font-mono"
          style={{
            background: "var(--gc-primary)",
            color: "white",
            borderRadius: "4px",
            padding: "0.1rem 0.5rem",
            fontSize: "0.75rem",
            fontWeight: 700,
          }}
        >
          {num}
        </span>
        <h3 style={{ fontSize: "1.125rem", margin: 0, color: "var(--gc-primary)" }}>
          {title}
        </h3>
      </div>
      <p style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)", margin: "0.5rem 0 0.75rem" }}>
        {desc}
      </p>
      <div
        style={{
          fontSize: "0.8125rem",
          fontWeight: 600,
          color: "var(--gc-secondary)",
          borderTop: "1px solid var(--gc-border)",
          paddingTop: "0.75rem",
        }}
      >
        {finding}
      </div>
    </a>
  );
}
