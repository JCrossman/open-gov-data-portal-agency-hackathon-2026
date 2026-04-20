"use client";

import { useState, useCallback } from "react";
import { useClientSort } from "@/lib/use-client-sort";
import ClientSortableHeader from "@/components/ClientSortableHeader";

interface Contract {
  vendor: string;
  effectiveValue: number | null;
  originalValue: number | null;
  amendmentValue: number | null;
  amendmentRatio: number | null;
  department: string;
  date: string;
  solicitation: string;
  commodityType: string;
  description: string;
}

interface ContractsResponse {
  total: number;
  showing: number;
  sortedBy: string;
  contracts: Contract[];
}

function formatDollars(v: number | null): string {
  if (v === null) return "—";
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
}

function formatRatio(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(2)}×`;
}

function describeSolicitation(code: string): string {
  const labels: Record<string, string> = { TN: "Sole-source", TC: "Competitive", TO: "Advance notice" };
  return labels[code] ?? code;
}

const inputStyle: React.CSSProperties = {
  padding: "0.75rem",
  fontSize: "0.9375rem",
  border: "2px solid var(--gc-border)",
  borderRadius: "6px",
  minWidth: 0,
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  background: "var(--gc-bg)",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.75rem 1.5rem",
  background: "var(--gc-secondary)",
  color: "white",
  border: "none",
  borderRadius: "6px",
  fontSize: "1rem",
  fontWeight: 600,
  cursor: "pointer",
};

export default function ContractsExplorePage() {
  const [vendor, setVendor] = useState("");
  const [department, setDepartment] = useState("");
  const [solicitation, setSolicitation] = useState("");
  const [commodity, setCommodity] = useState("");
  const [sortBy, setSortBy] = useState("value");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ContractsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (vendor.trim()) params.set("vendor", vendor.trim());
    if (department.trim()) params.set("department", department.trim());
    if (solicitation) params.set("solicitation", solicitation);
    if (commodity) params.set("commodity", commodity);
    params.set("sortBy", sortBy);
    params.set("limit", "20");

    try {
      const res = await fetch(`/api/contracts?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [vendor, department, solicitation, commodity, sortBy]);

  const sort = useClientSort<
    Contract,
    "vendor" | "effectiveValue" | "originalValue" | "amendmentValue" | "amendmentRatio" | "department" | "date" | "solicitation"
  >(data?.contracts ?? [], {
    vendor: (r) => r.vendor ?? "",
    effectiveValue: (r) => Number(r.effectiveValue ?? 0),
    originalValue: (r) => Number(r.originalValue ?? 0),
    amendmentValue: (r) => Number(r.amendmentValue ?? 0),
    amendmentRatio: (r) => Number(r.amendmentRatio ?? 0),
    department: (r) => r.department ?? "",
    date: (r) => r.date ? new Date(r.date) : null,
    solicitation: (r) => r.solicitation ?? "",
  }, { key: "effectiveValue", direction: "desc" });

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>Explore Contracts</h1>
      <p style={{ color: "var(--gc-text-secondary)", marginBottom: "1.5rem" }}>
        Search and filter federal government procurement contracts
      </p>

      <form onSubmit={handleSearch} style={{ marginBottom: "2rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          <div>
            <label htmlFor="vendor" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Vendor Name
            </label>
            <input id="vendor" type="text" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. Deloitte" style={{ ...inputStyle, width: "100%" }} />
          </div>
          <div>
            <label htmlFor="department" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Department
            </label>
            <input id="department" type="text" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Public Works" style={{ ...inputStyle, width: "100%" }} />
          </div>
          <div>
            <label htmlFor="solicitation" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Solicitation
            </label>
            <select id="solicitation" value={solicitation} onChange={(e) => setSolicitation(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
              <option value="">All</option>
              <option value="TN">Sole Source (TN)</option>
              <option value="TC">Competitive (TC)</option>
            </select>
          </div>
          <div>
            <label htmlFor="commodity" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Commodity
            </label>
            <select id="commodity" value={commodity} onChange={(e) => setCommodity(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
              <option value="">All</option>
              <option value="S">Services (S)</option>
              <option value="G">Goods (G)</option>
              <option value="C">Construction (C)</option>
            </select>
          </div>
          <div>
            <label htmlFor="sortBy" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Sort By
            </label>
            <select id="sortBy" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
              <option value="value">Value</option>
              <option value="amendment_ratio">Amendment Ratio</option>
              <option value="date">Date</option>
            </select>
          </div>
        </div>
        <button type="submit" disabled={loading} style={{ ...buttonStyle, cursor: loading ? "wait" : "pointer" }}>
          {loading ? "Searching…" : "Search Contracts"}
        </button>
      </form>

      {loading && (
        <div role="status" aria-live="polite" style={{ textAlign: "center", padding: "2rem", color: "var(--gc-text-secondary)" }}>
          Loading…
        </div>
      )}

      {error && (
        <div role="alert" style={{ padding: "1rem", background: "#FEE2E2", borderRadius: "6px", color: "var(--risk-critical)", marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {data && (
        <section>
          <p style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)", marginBottom: "0.75rem" }}>
            <strong>{new Intl.NumberFormat("en-US").format(data.total)}</strong> total records &middot; Showing <strong>{data.showing}</strong> &middot; Sorted by {data.sortedBy}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <caption style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0,0,0,0)" }}>
                Federal government contracts search results
              </caption>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                  <ClientSortableHeader columnKey="vendor" label="Vendor" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="effectiveValue" label="Effective Value" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="right" defaultDir="desc" />
                  <ClientSortableHeader columnKey="originalValue" label="Original" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="right" defaultDir="desc" />
                  <ClientSortableHeader columnKey="amendmentValue" label="Amendment" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="right" defaultDir="desc" />
                  <ClientSortableHeader columnKey="amendmentRatio" label="Ratio" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="right" defaultDir="desc" />
                  <ClientSortableHeader columnKey="department" label="Department" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="date" label="Date" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="desc" />
                  <ClientSortableHeader columnKey="solicitation" label="Solicitation" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                </tr>
              </thead>
              <tbody>
                {sort.rows.map((c, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                    <td style={{ padding: "0.5rem", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.vendor}</td>
                    <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{formatDollars(c.effectiveValue)}</td>
                    <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{formatDollars(c.originalValue)}</td>
                    <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{formatDollars(c.amendmentValue)}</td>
                    <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{formatRatio(c.amendmentRatio)}</td>
                    <td style={{ padding: "0.5rem", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.department.split("|")[0]?.trim()}</td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>{c.date}</td>
                    <td style={{ padding: "0.5rem" }}>{describeSolicitation(c.solicitation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sort.rows.length === 0 && (
            <p style={{ textAlign: "center", padding: "2rem", color: "var(--gc-text-secondary)" }}>No contracts matched your filters.</p>
          )}
        </section>
      )}
    </div>
  );
}
