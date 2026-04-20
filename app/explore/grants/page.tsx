"use client";

import { useState, useCallback } from "react";
import { useClientSort } from "@/lib/use-client-sort";
import ClientSortableHeader from "@/components/ClientSortableHeader";

interface Grant {
  recipient: string;
  businessNumber: string;
  value: number | null;
  agreementType: string;
  department: string;
  program: string;
  province: string;
  startDate: string;
}

interface GrantsResponse {
  total: number;
  showing: number;
  sortedBy: string;
  grants: Grant[];
}

function formatDollars(v: number | null): string {
  if (v === null) return "—";
  return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
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

export default function GrantsExplorePage() {
  const [recipient, setRecipient] = useState("");
  const [department, setDepartment] = useState("");
  const [recipientType, setRecipientType] = useState("");
  const [province, setProvince] = useState("");
  const [sortBy, setSortBy] = useState("value");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<GrantsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (recipient.trim()) params.set("recipient", recipient.trim());
    if (department.trim()) params.set("department", department.trim());
    if (recipientType) params.set("recipientType", recipientType);
    if (province.trim()) params.set("province", province.trim());
    params.set("sortBy", sortBy);
    params.set("limit", "20");

    try {
      const res = await fetch(`/api/grants?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [recipient, department, recipientType, province, sortBy]);

  const sort = useClientSort<
    Grant,
    "recipient" | "businessNumber" | "value" | "department" | "program" | "province" | "startDate" | "agreementType"
  >(data?.grants ?? [], {
    recipient: (r) => r.recipient ?? "",
    businessNumber: (r) => r.businessNumber ?? "",
    value: (r) => Number(r.value ?? 0),
    department: (r) => r.department ?? "",
    program: (r) => r.program ?? "",
    province: (r) => r.province ?? "",
    startDate: (r) => r.startDate ? new Date(r.startDate) : null,
    agreementType: (r) => r.agreementType ?? "",
  }, { key: "value", direction: "desc" });

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>Explore Grants</h1>
      <p style={{ color: "var(--gc-text-secondary)", marginBottom: "1.5rem" }}>
        Search and filter federal government grants and contributions
      </p>

      <form onSubmit={handleSearch} style={{ marginBottom: "2rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          <div>
            <label htmlFor="recipient" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Recipient Name
            </label>
            <input id="recipient" type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="e.g. Red Cross" style={{ ...inputStyle, width: "100%" }} />
          </div>
          <div>
            <label htmlFor="dept" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Department
            </label>
            <input id="dept" type="text" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Health Canada" style={{ ...inputStyle, width: "100%" }} />
          </div>
          <div>
            <label htmlFor="recipientType" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Recipient Type
            </label>
            <select id="recipientType" value={recipientType} onChange={(e) => setRecipientType(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
              <option value="">All</option>
              <option value="N">Nonprofit (N)</option>
              <option value="A">Indigenous (A)</option>
              <option value="S">Academic (S)</option>
              <option value="P">Private (P)</option>
              <option value="G">Government (G)</option>
            </select>
          </div>
          <div>
            <label htmlFor="province" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Province
            </label>
            <input id="province" type="text" value={province} onChange={(e) => setProvince(e.target.value)} placeholder="e.g. ON" style={{ ...inputStyle, width: "100%" }} />
          </div>
          <div>
            <label htmlFor="sortBy" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.25rem", color: "var(--gc-text-secondary)" }}>
              Sort By
            </label>
            <select id="sortBy" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ ...selectStyle, width: "100%" }}>
              <option value="value">Value</option>
              <option value="date">Date</option>
            </select>
          </div>
        </div>
        <button type="submit" disabled={loading} style={{ ...buttonStyle, cursor: loading ? "wait" : "pointer" }}>
          {loading ? "Searching…" : "Search Grants"}
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
                Federal government grants and contributions search results
              </caption>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--gc-primary)" }}>
                  <ClientSortableHeader columnKey="recipient" label="Recipient" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="businessNumber" label="BN" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="value" label="Value" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="right" defaultDir="desc" />
                  <ClientSortableHeader columnKey="department" label="Department" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="program" label="Program" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="province" label="Province" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                  <ClientSortableHeader columnKey="startDate" label="Start Date" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="desc" />
                  <ClientSortableHeader columnKey="agreementType" label="Type" activeKey={sort.key} direction={sort.direction} onSort={sort.toggle} align="left" defaultDir="asc" />
                </tr>
              </thead>
              <tbody>
                {sort.rows.map((g, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--gc-bg-stripe)", background: i % 2 === 0 ? "var(--gc-bg)" : "var(--gc-bg-secondary)" }}>
                    <td style={{ padding: "0.5rem", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.recipient}</td>
                    <td className="font-mono" style={{ padding: "0.5rem", fontSize: "0.8125rem", whiteSpace: "nowrap" }}>{g.businessNumber || "—"}</td>
                    <td className="font-mono" style={{ textAlign: "right", padding: "0.5rem" }}>{formatDollars(g.value)}</td>
                    <td style={{ padding: "0.5rem", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.department}</td>
                    <td style={{ padding: "0.5rem", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.program}</td>
                    <td style={{ padding: "0.5rem" }}>{g.province}</td>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>{g.startDate}</td>
                    <td style={{ padding: "0.5rem" }}>{g.agreementType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sort.rows.length === 0 && (
            <p style={{ textAlign: "center", padding: "2rem", color: "var(--gc-text-secondary)" }}>No grants matched your filters.</p>
          )}
        </section>
      )}
    </div>
  );
}
