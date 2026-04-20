"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

export interface PolicyDatum {
  bucket: string;
  value: number;
  count: number;
  color: string;
  share: number;
}

function fmtDollars(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PolicyDatum }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #ccc",
        borderRadius: 6,
        padding: "0.75rem",
        fontSize: "0.8125rem",
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 700, color: d.color }}>{d.bucket}</div>
      <div>Total Value: {fmtDollars(d.value)}</div>
      <div>Grant Count: {d.count.toLocaleString()}</div>
    </div>
  );
}

export default function PolicyChart({ data }: { data: PolicyDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(340, data.length * 52)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 10, right: 40, bottom: 10, left: 170 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
        <XAxis
          type="number"
          tickFormatter={(v: number) => fmtDollars(v)}
          tick={{ fontSize: 11 }}
        />
        <YAxis
          type="category"
          dataKey="bucket"
          width={160}
          tick={{ fontSize: 12, fontWeight: 500 }}
        />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
