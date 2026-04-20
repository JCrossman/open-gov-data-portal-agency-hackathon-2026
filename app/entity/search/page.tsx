"use client";

import { useState } from "react";
import { useClientSort } from "@/lib/use-client-sort";
import ClientSortableHeader from "@/components/ClientSortableHeader";

interface EntityDossier {
  entityName: string;
  businessNumber: string | null;
  grants: { total: number; topGrants: Array<{ value: number | null; department: string; program: string; date: string }> };
  contracts: { total: number; topContracts: Array<{ value: number | null; department: string; description: string; date: string; solicitation: string }> };
  charity: { found: boolean; legalName: string | null; category: string | null; governmentFundingPct: number | null; compensationPct: number | null; directorCount: number } | null;
  transfersGiven: { total: number };
  transfersReceived: { total: number };
  warnings: string[];
}

function formatDollars(v: number | null): string {
  if (v === null) return "-";
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
}

export default function EntitySearchPage() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [dossier, setDossier] = useState<EntityDossier | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setDossier(null);
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(query.trim())}`);
      if (!res.ok) throw new Error("Entity not found");
      setDossier(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>Entity Lookup</h1>
      <p style={{ color: "var(--gc-text-secondary)", marginBottom: "1.5rem" }}>
        Search any organization to see their complete government funding dossier across grants, contracts, T3010 charity data, and transfer records.
      </p>

      <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem", marginBottom: "2rem" }}>
        <label htmlFor="entity-search" style={{ position: "absolute", left: "-9999px" }}>Entity name</label>
        <input
          id="entity-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Canadian Red Cross, INDSPIRE, Deloitte..."
          style={{ flex: 1, padding: "0.75rem 1rem", fontSize: "1rem", border: "2px solid var(--gc-border)", borderRadius: "6px" }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{ padding: "0.75rem 1.5rem", background: "var(--gc-secondary)", color: "white", border: "none", borderRadius: "6px", fontSize: "1rem", fontWeight: 600, cursor: loading ? "wait" : "pointer" }}
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {loading && (
        <div role="status" aria-live="polite" style={{ textAlign: "center", padding: "2rem", color: "var(--gc-text-secondary)" }}>
          Building dossier from 6 data sources...
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "1rem", background: "#FEE2E2", borderRadius: "6px", color: "var(--risk-critical)" }}>{error}</div>
      )}
      {dossier && <DossierView dossier={dossier} />}
    </div>
  );
}

function DossierView({ dossier }: { dossier: EntityDossier }) {
  const govPct = dossier.charity?.governmentFundingPct ?? null;
  const riskLevel = govPct !== null && govPct > 90 ? "critical" : govPct !== null && govPct > 70 ? "high" : dossier.grants.total === 0 && dossier.contracts.total === 0 ? "medium" : "low";
  const riskConfig = { critical: { bg: "#D3080C", text: "white", label: "Critical Risk" }, high: { bg: "#EE7100", text: "black", label: "High Risk" }, medium: { bg: "#F0C808", text: "black", label: "Medium" }, low: { bg: "#278400", text: "white", label: "Low Risk" } };
  const rc = riskConfig[riskLevel];

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

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
        <div>
          <h2 style={{ fontSize: "1.5rem", margin: 0 }}>{dossier.entityName}</h2>
          {dossier.businessNumber && <span className="font-mono" style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)" }}>BN: {dossier.businessNumber}</span>}
        </div>
        <span role="img" aria-label={rc.label} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", background: rc.bg, color: rc.text, padding: "0.25rem 0.75rem", borderRadius: "4px", fontSize: "0.8125rem", fontWeight: 700 }}>
          {rc.label}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <Stat label="Federal Grants" value={dossier.grants.total.toString()} />
        <Stat label="Federal Contracts" value={dossier.contracts.total.toString()} />
        {dossier.charity?.found && <>
          <Stat label="Gov Funding" value={govPct !== null ? `${govPct.toFixed(0)}%` : "-"} warn={govPct !== null && govPct > 70} />
          <Stat label="Compensation" value={dossier.charity.compensationPct !== null ? `${dossier.charity.compensationPct.toFixed(0)}%` : "-"} />
          <Stat label="Directors" value={dossier.charity.directorCount.toString()} />
        </>}
        <Stat label="Transfers Given" value={dossier.transfersGiven.total.toString()} />
        <Stat label="Transfers Received" value={dossier.transfersReceived.total.toString()} />
      </div>

      {dossier.grants.topGrants.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h3 style={{ fontSize: "1.125rem" }}>Federal Grants ({dossier.grants.total} records)</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <caption style={{ position: "absolute", left: "-9999px" }}>Top federal grants</caption>
              <thead><tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                <ClientSortableHeader columnKey="value" label="Value" activeKey={grantsSort.key} direction={grantsSort.direction} onSort={grantsSort.toggle} align="right" defaultDir="desc" />
                <ClientSortableHeader columnKey="department" label="Department" activeKey={grantsSort.key} direction={grantsSort.direction} onSort={grantsSort.toggle} align="left" defaultDir="asc" />
                <ClientSortableHeader columnKey="program" label="Program" activeKey={grantsSort.key} direction={grantsSort.direction} onSort={grantsSort.toggle} align="left" defaultDir="asc" />
                <ClientSortableHeader columnKey="date" label="Date" activeKey={grantsSort.key} direction={grantsSort.direction} onSort={grantsSort.toggle} align="left" defaultDir="desc" />
              </tr></thead>
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

      {dossier.contracts.topContracts.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h3 style={{ fontSize: "1.125rem" }}>Federal Contracts ({dossier.contracts.total} records)</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <caption style={{ position: "absolute", left: "-9999px" }}>Top federal contracts</caption>
              <thead><tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                <ClientSortableHeader columnKey="value" label="Value" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="right" defaultDir="desc" />
                <ClientSortableHeader columnKey="department" label="Department" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="left" defaultDir="asc" />
                <ClientSortableHeader columnKey="description" label="Description" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="left" defaultDir="asc" />
                <ClientSortableHeader columnKey="date" label="Date" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="left" defaultDir="desc" />
                <ClientSortableHeader columnKey="method" label="Method" activeKey={contractsSort.key} direction={contractsSort.direction} onSort={contractsSort.toggle} align="left" defaultDir="asc" />
              </tr></thead>
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

      {dossier.warnings.length > 0 && (
        <section style={{ padding: "1rem", background: "var(--gc-bg-secondary)", borderRadius: "6px", fontSize: "0.8125rem" }}>
          <h3 style={{ fontSize: "0.875rem", margin: "0 0 0.5rem" }}>Notes</h3>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {dossier.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ background: warn ? "#FEF3C7" : "var(--gc-bg-secondary)", borderRadius: "6px", padding: "0.75rem", textAlign: "center", border: warn ? "1px solid var(--risk-high)" : "1px solid var(--gc-border)" }}>
      <div className="font-mono" style={{ fontSize: "1.5rem", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--gc-text-secondary)" }}>{label}</div>
    </div>
  );
}
