// Pure, client-safe chart-selection heuristic for the Ask-the-Data page.
// Consumes the rows returned by /api/ask and an optional LLM-provided chart
// hint, returns a ChartSpec the AutoChart component can render. No React, no
// browser APIs — trivially unit-testable.

export type ChartType =
  | "bar"
  | "line"
  | "kpi"
  | "stacked_bar"
  | "grouped_bar"
  | "multi_line";

export interface ChartHint {
  type: ChartType;
  x?: string;
  y?: string;
  series?: string;
  title?: string;
}

export interface ChartSpec {
  type: ChartType;
  xKey: string;
  yKey: string;
  seriesKey?: string;
  orientation: "vertical" | "horizontal";
  isDollar: boolean;
  title: string;
  caption?: string;
  summary: string; // human-readable aria-label text
  data: Record<string, unknown>[];
  seriesValues?: string[];
}

const DOLLAR_HINTS =
  /value|spending|funding|cost|amount|revenue|expenditure|salary|compensation|total_?grant|total_?contract|agreement|budget/i;
const TEMPORAL_HINTS = /year|date|fiscal|quarter|month/i;

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type Classification = "numeric" | "temporal" | "categorical" | "empty";

function classifyColumn(
  rows: Record<string, unknown>[],
  col: string,
): Classification {
  let numericHits = 0;
  let nonNull = 0;
  let yearHits = 0;
  const sample = rows.slice(0, 200);

  for (const r of sample) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    nonNull++;
    const n = toNumber(v);
    if (n !== null) {
      numericHits++;
      if (Number.isInteger(n) && n >= 1990 && n <= 2035) {
        yearHits++;
      }
    }
  }

  if (nonNull === 0) return "empty";

  const allNumeric = numericHits === nonNull;
  const nameLooksTemporal = TEMPORAL_HINTS.test(col);

  // Temporal: name looks like year/date AND either values are year-like
  // integers, or the column is fully numeric but small range, or all values
  // parse as dates.
  if (nameLooksTemporal && (yearHits === nonNull || allNumeric)) {
    return "temporal";
  }
  if (nameLooksTemporal) return "temporal";

  if (allNumeric) return "numeric";
  return "categorical";
}

function fmtShort(n: number, isDollar: boolean): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const unit = (val: number, suf: string) =>
    `${sign}${isDollar ? "$" : ""}${val.toFixed(val >= 100 ? 0 : 1)}${suf}`;
  if (abs >= 1e12) return unit(abs / 1e12, "T");
  if (abs >= 1e9) return unit(abs / 1e9, "B");
  if (abs >= 1e6) return unit(abs / 1e6, "M");
  if (abs >= 1e3)
    return `${sign}${isDollar ? "$" : ""}${Math.round(abs / 1e3).toLocaleString()}K`;
  return `${sign}${isDollar ? "$" : ""}${abs.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
}

function humanize(col: string): string {
  return col.replace(/_/g, " ");
}

// Build the aria-label summary from top-N rows.
function buildSummary(
  type: ChartType,
  data: Record<string, unknown>[],
  xKey: string,
  yKey: string,
  isDollar: boolean,
  seriesKey?: string,
): string {
  if (data.length === 0) return "Empty chart";
  if (type === "kpi") {
    const n = toNumber(data[0][yKey]);
    return `${humanize(yKey)}: ${n === null ? "—" : fmtShort(n, isDollar)}`;
  }

  const verb =
    type === "line" || type === "multi_line" ? "time series" : "bar chart";
  if (seriesKey) {
    const seriesSet = Array.from(
      new Set(data.map((r) => String(r[seriesKey] ?? "—"))),
    ).slice(0, 6);
    return `${verb} of ${humanize(yKey)} by ${humanize(xKey)} and ${humanize(seriesKey)}. Series: ${seriesSet.join(", ")}. ${data.length} rows.`;
  }

  const sorted = [...data]
    .map((r) => ({ x: String(r[xKey] ?? "—"), y: toNumber(r[yKey]) ?? 0 }))
    .sort((a, b) => b.y - a.y);
  const top = sorted.slice(0, 3);
  const parts = top.map((t) => `${t.x} at ${fmtShort(t.y, isDollar)}`);
  const total = sorted.reduce((acc, r) => acc + r.y, 0);
  return `${verb} of ${humanize(yKey)} by ${humanize(xKey)}. Top: ${parts.join("; ")}. ${data.length} rows, total ${fmtShort(total, isDollar)}.`;
}

// Narrow a too-wide series-set to top-N + "Other".
function coalesceSeries(
  data: Record<string, unknown>[],
  xKey: string,
  yKey: string,
  seriesKey: string,
  maxSeries = 8,
): { data: Record<string, unknown>[]; seriesValues: string[] } {
  const totals = new Map<string, number>();
  for (const r of data) {
    const s = String(r[seriesKey] ?? "—");
    const n = toNumber(r[yKey]) ?? 0;
    totals.set(s, (totals.get(s) ?? 0) + n);
  }
  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const keep = new Set(ranked.slice(0, maxSeries - 1));
  const seriesValues: string[] = ranked.slice(0, maxSeries - 1);

  const remapped = data.map((r) => {
    const s = String(r[seriesKey] ?? "—");
    return keep.has(s) ? r : { ...r, [seriesKey]: "Other" };
  });
  if (ranked.length > maxSeries - 1) seriesValues.push("Other");
  return { data: remapped, seriesValues };
}

export function pickChart(
  rows: Record<string, unknown>[],
  hint?: ChartHint | null,
): ChartSpec | null {
  if (!rows || rows.length === 0) return null;
  const cols = Object.keys(rows[0] ?? {});
  if (cols.length < 1) return null;

  // Classify every column once.
  const kinds = new Map<string, Classification>();
  for (const c of cols) kinds.set(c, classifyColumn(rows, c));

  const numericCols = cols.filter((c) => kinds.get(c) === "numeric");
  const temporalCols = cols.filter((c) => kinds.get(c) === "temporal");
  const categoricalCols = cols.filter((c) => kinds.get(c) === "categorical");

  // Helper to check hint compatibility.
  const hintColExists = (name?: string) => !!name && cols.includes(name);

  // ---- KPI ----
  if (rows.length === 1 && numericCols.length === 1) {
    const yKey = numericCols[0];
    const isDollar = DOLLAR_HINTS.test(yKey);
    return {
      type: "kpi",
      xKey: "",
      yKey,
      orientation: "vertical",
      isDollar,
      title: hint?.title ?? humanize(yKey),
      summary: buildSummary("kpi", rows, "", yKey, isDollar),
      data: rows.slice(0, 1),
    };
  }

  // ---- Two-dimensional: temporal + categorical + numeric → multi_line ----
  if (
    temporalCols.length === 1 &&
    categoricalCols.length >= 1 &&
    numericCols.length === 1 &&
    rows.length >= 2
  ) {
    const xKey = temporalCols[0];
    const yKey = numericCols[0];
    const seriesKey =
      hint?.type === "multi_line" && hintColExists(hint.series)
        ? (hint!.series as string)
        : categoricalCols[0];
    const isDollar = DOLLAR_HINTS.test(yKey);
    const { data, seriesValues } = coalesceSeries(rows, xKey, yKey, seriesKey);
    return {
      type: "multi_line",
      xKey,
      yKey,
      seriesKey,
      orientation: "vertical",
      isDollar,
      title: hint?.title ?? `${humanize(yKey)} by ${humanize(xKey)}`,
      summary: buildSummary("multi_line", data, xKey, yKey, isDollar, seriesKey),
      data,
      seriesValues,
    };
  }

  // ---- Two categoricals + numeric → stacked/grouped bar ----
  if (
    temporalCols.length === 0 &&
    categoricalCols.length >= 2 &&
    numericCols.length === 1 &&
    rows.length >= 2
  ) {
    const xKey = categoricalCols[0];
    const yKey = numericCols[0];
    const seriesKey = categoricalCols[1];
    const type: ChartType =
      hint?.type === "grouped_bar" ? "grouped_bar" : "stacked_bar";
    const isDollar = DOLLAR_HINTS.test(yKey);
    const { data, seriesValues } = coalesceSeries(rows, xKey, yKey, seriesKey, 6);
    return {
      type,
      xKey,
      yKey,
      seriesKey,
      orientation: "vertical",
      isDollar,
      title: hint?.title ?? `${humanize(yKey)} by ${humanize(xKey)}`,
      summary: buildSummary(type, data, xKey, yKey, isDollar, seriesKey),
      data,
      seriesValues,
    };
  }

  // ---- Temporal + numeric → line ----
  if (
    temporalCols.length === 1 &&
    numericCols.length === 1 &&
    rows.length >= 2
  ) {
    const xKey = temporalCols[0];
    const yKey = numericCols[0];
    const isDollar = DOLLAR_HINTS.test(yKey);
    // Filter artifact years when the column is an integer-year column.
    const filtered = rows.filter((r) => {
      const v = r[xKey];
      const n = toNumber(v);
      if (n === null) return true;
      if (Number.isInteger(n)) {
        const thisYear = new Date().getFullYear();
        return n >= 1990 && n <= thisYear + 2;
      }
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      const av = toNumber(a[xKey]) ?? 0;
      const bv = toNumber(b[xKey]) ?? 0;
      return av - bv;
    });
    return {
      type: "line",
      xKey,
      yKey,
      orientation: "vertical",
      isDollar,
      title: hint?.title ?? `${humanize(yKey)} by ${humanize(xKey)}`,
      summary: buildSummary("line", sorted, xKey, yKey, isDollar),
      data: sorted,
    };
  }

  // ---- Categorical + numeric → bar ----
  if (
    categoricalCols.length >= 1 &&
    numericCols.length === 1 &&
    rows.length >= 2
  ) {
    const xKey = categoricalCols[0];
    const yKey = numericCols[0];
    const isDollar = DOLLAR_HINTS.test(yKey);
    const maxLabel = rows.reduce(
      (acc, r) => Math.max(acc, String(r[xKey] ?? "").length),
      0,
    );
    const orientation: "vertical" | "horizontal" =
      maxLabel > 14 ? "horizontal" : "vertical";
    let data = [...rows].sort((a, b) => {
      const av = toNumber(a[yKey]) ?? 0;
      const bv = toNumber(b[yKey]) ?? 0;
      return bv - av;
    });
    let caption: string | undefined;
    if (data.length > 25) {
      caption = `Showing top 25 of ${data.length}`;
      data = data.slice(0, 25);
    }
    return {
      type: "bar",
      xKey,
      yKey,
      orientation,
      isDollar,
      title: hint?.title ?? `${humanize(yKey)} by ${humanize(xKey)}`,
      caption,
      summary: buildSummary("bar", data, xKey, yKey, isDollar),
      data,
    };
  }

  return null;
}

export function formatChartValue(n: number, isDollar: boolean): string {
  return fmtShort(n, isDollar);
}
