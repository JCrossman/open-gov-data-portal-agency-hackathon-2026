"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useClientSort } from "@/lib/use-client-sort";
import ClientSortableHeader from "@/components/ClientSortableHeader";

interface EntityDossier {
  entityName: string;
  businessNumber: string | null;
  grants: { total: number; topGrants: Array<{ value: number | null; department: string; program: string; date: string }> };
  contracts: { total: number; topContracts: Array<{ value: number | null; department: string; description: string; date: string; solicitation: string }> };
  charity: { found: boolean; legalName: string | null; category: string | null; selfReportedGovRevenuePct: number | null; verifiedGrantsAnnual: number | null; verifiedGrantsPct: number | null; yearsActive: number; compensationPct: number | null; directorCount: number } | null;
  transfersGiven: { total: number };
  transfersReceived: { total: number };
  warnings: string[];
}

function formatDollars(v: number | null): string {
  if (v === null) return "-";
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
}

export default function EntityProfilePage() {
  const params = useParams();
  const router = useRouter();
  const nameFromUrl = typeof params.name === "string" ? decodeURIComponent(params.name) : "";

  const [query, setQuery] = useState(nameFromUrl);
  const [loading, setLoading] = useState(false);
  const [dossier, setDossier] = useState<EntityDossier | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doSearch(name: string) {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    setDossier(null);
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(name.trim())}`);
      if (!res.ok) throw new Error("Entity not found");
      setDossier(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  // Auto-search when arriving from a link with a name in the URL
  useEffect(() => {
    if (nameFromUrl && nameFromUrl !== "search") {
      doSearch(nameFromUrl);
    }
  }, [nameFromUrl]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    // Update URL so it's shareable, then search
    router.push(`/entity/${encodeURIComponent(query.trim())}`);
    doSearch(query.trim());
  }

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>
        {nameFromUrl && nameFromUrl !== "search" ? `Entity Profile: ${nameFromUrl}` : "Entity Profile"}
      </h1>
      <p style={{ color: "var(--gc-text-secondary)", marginBottom: "1.5rem" }}>
        {dossier ? "Cross-referenced from grants, contracts, T3010 charity data, and transfer records" : "Search any organization to see their complete government funding dossier"}
      </p>

      <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem", marginBottom: "2rem" }}>
        <label htmlFor="entity-search" className="sr-only">Entity name</label>
        <input
          id="entity-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Canadian Red Cross, INDSPIRE, Deloitte..."
          style={{
            flex: 1,
            padding: "0.75rem 1rem",
            fontSize: "1rem",
            border: "2px solid var(--gc-border)",
            borderRadius: "6px",
          }}
          aria-describedby="search-hint"
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "0.75rem 1.5rem",
            background: "var(--gc-secondary)",
            color: "white",
            border: "none",
            borderRadius: "6px",
            fontSize: "1rem",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </form>
      <p id="search-hint" style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)", marginTop: "-1.5rem", marginBottom: "1.5rem" }}>
        Cross-references grants, contracts, T3010 charity data, and transfer records
      </p>

      {loading && (
        <div role="status" aria-live="polite" style={{ textAlign: "center", padding: "2rem", color: "var(--gc-text-secondary)" }}>
          Building dossier from 6 data sources...
        </div>
      )}

      {error && (
        <div role="alert" style={{ padding: "1rem", background: "#FEE2E2", borderRadius: "6px", color: "var(--risk-critical)" }}>
          {error}
        </div>
      )}

      {dossier && <DossierView dossier={dossier} />}
    </div>
  );
}

interface CharityProfile {
  bn: string;
  legalName: string;
  accountName: string;
  category: string;
  designation: string;
  address: string;
  city: string;
  province: string;
  postalCode: string;
  financials: {
    totalRevenue: number | null;
    totalExpenditure: number | null;
    governmentFunding: number | null;
    governmentFundingPct: number | null;
    otherRevenue: number | null;
    compensationTotal: number | null;
    compensationPct: number | null;
  } | null;
  directors: Array<{ lastName: string; firstName: string; position: string; atArmsLength: string }>;
  compensation: { fullTimeEmployees: number | null; partTimeEmployees: number | null; ranges: Array<{ range: string; count: number | null }> } | null;
  programs: Array<{ type: string; description: string }>;
  warnings: string[];
}

function DossierView({ dossier }: { dossier: EntityDossier }) {
  const [charityProfile, setCharityProfile] = useState<CharityProfile | null>(null);
  const [charityLoading, setCharityLoading] = useState(false);
  const riskLevel = getRiskLevel(dossier);

  // Sort state for grants table
  const grantsSort = useClientSort<typeof dossier.grants.topGrants[number], "value" | "department" | "program" | "date">(
    dossier.grants.topGrants ?? [],
    {
      value: (r) => Number(r.value ?? 0),
      department: (r) => r.department ?? "",
      program: (r) => r.program ?? "",
      date: (r) => r.date ? new Date(r.date) : null,
    },
    { key: "value", direction: "desc" }
  );

  // Sort state for contracts table
  const contractsSort = useClientSort<typeof dossier.contracts.topContracts[number], "value" | "department" | "description" | "date" | "method">(
    dossier.contracts.topContracts ?? [],
    {
      value: (r) => Number(r.value ?? 0),
      department: (r) => r.department ?? "",
      description: (r) => r.description ?? "",
      date: (r) => r.date ? new Date(r.date) : null,
      method: (r) => r.solicitation ?? "",
    },
    { key: "value", direction: "desc" }
  );

  // Sort state for directors table (unconditional hook, safe even if charityProfile is null)
  const directorsSort = useClientSort<CharityProfile["directors"][number], "name" | "position" | "atArmsLength">(
    charityProfile?.directors ?? [],
    {
      name: (r) => `${r.firstName} ${r.lastName}`,
      position: (r) => r.position ?? "",
      atArmsLength: (r) => r.atArmsLength ?? "",
    },
    { key: "name", direction: "asc" }
  );

  useEffect(() => {
    if (dossier.businessNumber) {
      setCharityLoading(true);
      fetch(`/api/charity/${encodeURIComponent(dossier.businessNumber)}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => setCharityProfile(data))
        .catch(() => {})
        .finally(() => setCharityLoading(false));
    }
  }, [dossier.businessNumber]);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
        <div>
          <h2 style={{ fontSize: "1.5rem", margin: 0 }}>{dossier.entityName}</h2>
          {dossier.businessNumber && (
            <span className="font-mono" style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)" }}>
              BN: {dossier.businessNumber}
            </span>
          )}
        </div>
        <RiskBadge level={riskLevel} />
      </div>

      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <StatCard label="Federal Grants" value={dossier.grants.total.toString()} />
        <StatCard label="Federal Contracts" value={dossier.contracts.total.toString()} />
        {dossier.charity?.found && (
          <>
            <StatCard label="Verified Grants/yr" value={dossier.charity.verifiedGrantsAnnual !== null ? formatDollars(dossier.charity.verifiedGrantsAnnual) : "-"} />
            <StatCard label="Gov Dependency" value={dossier.charity.verifiedGrantsPct !== null ? `${dossier.charity.verifiedGrantsPct.toFixed(0)}%` : (dossier.charity.selfReportedGovRevenuePct !== null ? `${dossier.charity.selfReportedGovRevenuePct.toFixed(0)}%*` : "-")} warn={((dossier.charity.verifiedGrantsPct ?? dossier.charity.selfReportedGovRevenuePct) ?? 0) > 70} />
            <StatCard label="Compensation" value={dossier.charity.compensationPct !== null ? `${dossier.charity.compensationPct.toFixed(0)}%` : "-"} />
            <StatCard label="Directors" value={dossier.charity.directorCount.toString()} />
          </>
        )}
        <StatCard label="Transfers Given" value={dossier.transfersGiven.total.toString()} />
        <StatCard label="Transfers Received" value={dossier.transfersReceived.total.toString()} />
      </div>

      {/* Grants table */}
      {dossier.grants.topGrants.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h3 style={{ fontSize: "1.125rem" }}>Federal Grants ({dossier.grants.total} records)</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <caption className="sr-only">Top federal grants for {dossier.entityName}</caption>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                  <ClientSortableHeader columnKey="value" label="Value" activeKey={grantsSort.key} direction={grantsSort.direction} onSort={grantsSort.toggle} align="right" defaultDir="desc" />
                  <ClientSortableHeader columnKey="department" label="Department" activeKey={grantsSort.key} direction={grantsSort.direction} onSort={grantsSort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="program" label="Program" activeKey={grantsSort.key} direction={grantsSort.direction} onSort={grantsSort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="date" label="Date" activeKey={grantsSort.key} direction={grantsSort.direction} onSort={grantsSort.toggle} align="left" defaultDir="desc" />
                </tr>
              </thead>
              <tbody>
                {grantsSort.rows.map((g, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                    <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{formatDollars(g.value)}</td>
                    <td style={{ padding: "0.5rem" }}>{g.department.split("|")[0]?.trim()}</td>
                    <td style={{ padding: "0.5rem" }}>{g.program.substring(0, 40)}</td>
                    <td style={{ padding: "0.5rem" }}>{g.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Contracts table */}
      {dossier.contracts.topContracts.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h3 style={{ fontSize: "1.125rem" }}>Federal Contracts ({dossier.contracts.total} records)</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <caption className="sr-only">Top federal contracts for {dossier.entityName}</caption>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                  <ClientSortableHeader columnKey="value" label="Value" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="right" defaultDir="desc" />
                  <ClientSortableHeader columnKey="department" label="Department" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="description" label="Description" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="date" label="Date" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="left" defaultDir="desc" />
                  <ClientSortableHeader columnKey="method" label="Method" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="left" defaultDir="asc" />
                </tr>
              </thead>
              <tbody>
                {contractsSort.rows.map((c, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                    <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{formatDollars(c.value)}</td>
                    <td style={{ padding: "0.5rem" }}>{c.department.split("|")[0]?.trim()}</td>
                    <td style={{ padding: "0.5rem" }}>{c.description.substring(0, 40)}</td>
                    <td style={{ padding: "0.5rem" }}>{c.date}</td>
                    <td style={{ padding: "0.5rem" }}>{c.solicitation === "TN" ? "Sole-source" : c.solicitation === "TC" ? "Competitive" : c.solicitation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Charity Profile */}
      {charityLoading && (
        <div style={{ padding: "1rem", color: "var(--gc-text-secondary)", fontSize: "0.875rem" }}>Loading charity profile...</div>
      )}
      {charityProfile && (
        <section style={{ marginBottom: "2rem" }}>
          <h3 style={{ fontSize: "1.25rem", marginBottom: "1rem", borderBottom: "2px solid var(--gc-primary)", paddingBottom: "0.5rem" }}>
            Charity Profile (T3010)
          </h3>

          {/* Identity */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem 2rem", marginBottom: "1.5rem", fontSize: "0.875rem" }}>
            <div><strong>Legal Name:</strong> {charityProfile.legalName}</div>
            <div><strong>Category:</strong> {charityProfile.category}</div>
            <div><strong>Location:</strong> {charityProfile.city}, {charityProfile.province} {charityProfile.postalCode}</div>
            <div><strong>Designation:</strong> {charityProfile.designation}</div>
            {charityProfile.address && <div><strong>Address:</strong> {charityProfile.address}</div>}
          </div>

          {/* Financials */}
          {charityProfile.financials && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h4 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Financial Summary</h4>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem" }}>
                <FinancialRow label="Total Revenue" value={charityProfile.financials.totalRevenue} />
                <FinancialRow label="Total Expenditure" value={charityProfile.financials.totalExpenditure} />
                <FinancialRow label="Gov Revenue (Self-Reported)" value={charityProfile.financials.governmentFunding} pct={charityProfile.financials.governmentFundingPct} warn={charityProfile.financials.governmentFundingPct !== null && charityProfile.financials.governmentFundingPct > 70} />
                {charityProfile.financials.otherRevenue !== null && (
                  <FinancialRow label="Other Revenue" value={charityProfile.financials.otherRevenue} />
                )}
                <FinancialRow label="Compensation" value={charityProfile.financials.compensationTotal} pct={charityProfile.financials.compensationPct} />
              </div>
            </div>
          )}

          {/* Employees */}
          {charityProfile.compensation && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h4 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Employees</h4>
              <div style={{ display: "flex", gap: "2rem", fontSize: "0.875rem" }}>
                <div><strong>Full-time:</strong> {charityProfile.compensation.fullTimeEmployees ?? "Not reported"}</div>
                <div><strong>Part-time:</strong> {charityProfile.compensation.partTimeEmployees !== null && charityProfile.compensation.partTimeEmployees > 500000 ? `${charityProfile.compensation.partTimeEmployees.toLocaleString()} (suspect data)` : charityProfile.compensation.partTimeEmployees ?? "Not reported"}</div>
              </div>
              {charityProfile.compensation.ranges.filter(r => r.count !== null && r.count > 0).length > 0 && (
                <div style={{ marginTop: "0.5rem", fontSize: "0.8125rem", color: "var(--gc-text-secondary)" }}>
                  Salary ranges: {charityProfile.compensation.ranges.filter(r => r.count !== null && r.count > 0).map(r => `${r.range}: ${r.count}`).join(" | ")}
                </div>
              )}
            </div>
          )}

          {/* Directors */}
          {charityProfile.directors.length > 0 && (
            <div style={{ marginBottom: "1.5rem" }}>
              <h4 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Directors/Officers ({charityProfile.directors.length})</h4>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
                  <caption style={{ position: "absolute", left: "-9999px" }}>Board of directors</caption>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                      <ClientSortableHeader columnKey="name" label="Name" activeKey={directorsSort.key} direction={directorsSort.direction} onSort={directorsSort.toggle} align="left" defaultDir="asc" />
                      <ClientSortableHeader columnKey="position" label="Position" activeKey={directorsSort.key} direction={directorsSort.direction} onSort={directorsSort.toggle} align="left" defaultDir="asc" />
                      <ClientSortableHeader columnKey="atArmsLength" label="At Arm's Length" activeKey={directorsSort.key} direction={directorsSort.direction} onSort={directorsSort.toggle} align="center" defaultDir="asc" />
                    </tr>
                  </thead>
                  <tbody>
                    {directorsSort.rows.slice(0, 20).map((d, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                        <td style={{ padding: "0.4rem 0.5rem" }}>{d.firstName} {d.lastName}</td>
                        <td style={{ padding: "0.4rem 0.5rem" }}>{d.position}</td>
                        <td style={{ padding: "0.4rem 0.5rem", textAlign: "center", color: d.atArmsLength === "N" ? "var(--risk-high)" : "inherit", fontWeight: d.atArmsLength === "N" ? 700 : 400 }}>
                          {d.atArmsLength === "N" ? "No" : d.atArmsLength === "Y" ? "Yes" : d.atArmsLength}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {charityProfile.directors.length > 20 && (
                  <p style={{ fontSize: "0.8125rem", color: "var(--gc-text-secondary)" }}>...and {charityProfile.directors.length - 20} more</p>
                )}
              </div>
            </div>
          )}

          {/* Programs */}
          {charityProfile.programs.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <h4 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Charitable Programs</h4>
              {charityProfile.programs.slice(0, 5).map((p, i) => (
                <div key={i} style={{ marginBottom: "0.5rem", fontSize: "0.8125rem", padding: "0.5rem 0.75rem", background: "var(--gc-bg-secondary)", borderRadius: "4px" }}>
                  <strong>{p.type}:</strong> {p.description.substring(0, 200)}{p.description.length > 200 ? "..." : ""}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Warnings */}
      {dossier.warnings.length > 0 && (
        <section style={{ marginTop: "1rem", padding: "1rem", background: "var(--gc-bg-secondary)", borderRadius: "6px", fontSize: "0.8125rem" }}>
          <h3 style={{ fontSize: "0.875rem", margin: "0 0 0.5rem" }}>Notes</h3>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {dossier.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

function getRiskLevel(d: EntityDossier): "critical" | "high" | "medium" | "low" {
  const hasGovRecords = d.grants.total > 0 || d.contracts.total > 0;
  const govPct = d.charity?.verifiedGrantsPct ?? d.charity?.selfReportedGovRevenuePct ?? 0;
  if (hasGovRecords && govPct > 90) return "critical";
  if (hasGovRecords && govPct > 70) return "high";
  if (!hasGovRecords) return "medium";
  return "low";
}

function RiskBadge({ level }: { level: "critical" | "high" | "medium" | "low" }) {
  const config = {
    critical: { bg: "var(--risk-critical)", text: "white", label: "Critical Risk", icon: "!" },
    high: { bg: "var(--risk-high)", text: "black", label: "High Risk", icon: "▲" },
    medium: { bg: "var(--risk-medium)", text: "black", label: "Medium", icon: "◆" },
    low: { bg: "var(--risk-low)", text: "white", label: "Low Risk", icon: "●" },
  };
  const c = config[level];
  return (
    <span
      role="img"
      aria-label={c.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35rem",
        background: c.bg,
        color: c.text,
        padding: "0.25rem 0.75rem",
        borderRadius: "4px",
        fontSize: "0.8125rem",
        fontWeight: 700,
      }}
    >
      <span aria-hidden="true">{c.icon}</span> {c.label}
    </span>
  );
}

function StatCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{
      background: warn ? "#FEF3C7" : "var(--gc-bg-secondary)",
      borderRadius: "6px",
      padding: "0.75rem",
      textAlign: "center",
      border: warn ? "1px solid var(--risk-high)" : "1px solid var(--gc-border)",
    }}>
      <div className="font-mono" style={{ fontSize: "1.5rem", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)" }}>{label}</div>
    </div>
  );
}

function FinancialRow({ label, value, pct, warn }: { label: string; value: number | null; pct?: number | null; warn?: boolean }) {
  return (
    <div style={{
      padding: "0.75rem",
      background: warn ? "#FEF3C7" : "var(--gc-bg-secondary)",
      borderRadius: "6px",
      border: warn ? "2px solid var(--risk-high)" : "1px solid var(--gc-border)",
    }}>
      <div style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)", marginBottom: "0.25rem" }}>{label}</div>
      <div className="font-mono" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
        {value !== null ? formatDollars(value) : "-"}
      </div>
      {pct !== null && pct !== undefined && (
        <div style={{ fontSize: "0.75rem", fontWeight: 600, color: warn ? "var(--risk-high)" : "var(--gc-text-secondary)", marginTop: "0.15rem" }}>
          {pct.toFixed(1)}%{warn ? " - HIGH" : ""}
        </div>
      )}
    </div>
  );
}
