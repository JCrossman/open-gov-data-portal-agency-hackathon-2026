/**
 * Safe, whitelist-based sort-parameter parsing for server-side ORDER BY.
 *
 * Usage:
 *   const ALLOWED = {
 *     name: "legal_name",
 *     revenue: "total_revenue",
 *     pct: "gov_pct",
 *   } as const;
 *   const sort = parseSort(searchParams, ALLOWED, "revenue", "desc", "sort");
 *   // sort.key    -> "revenue" (or default if invalid)
 *   // sort.direction -> "asc" | "desc"
 *   // sort.orderBySql -> "total_revenue DESC NULLS LAST"
 *
 * The returned orderBySql is always constructed from the mapped column
 * expression in `allowed` + a hard-coded direction literal, so it is safe to
 * inline into a SQL template.
 */

export type SortDirection = "asc" | "desc";

export interface SortResult<K extends string> {
  key: K;
  direction: SortDirection;
  /** Safe SQL fragment, e.g. "total_revenue DESC NULLS LAST" */
  orderBySql: string;
  /** Build a ?sort=…&dir=… query string for a given column, toggling direction. */
  hrefFor: (
    column: K,
    defaultDir?: SortDirection,
    preserve?: Record<string, string | undefined>,
  ) => string;
}

function pickParam(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!searchParams) return undefined;
  const v = searchParams[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

export function parseSort<
  A extends Readonly<Record<string, string>>,
  // Second type arg preserved for backward-compat with callers that pass it;
  // ignored — the return type always spans every key in `allowed`.
  _K extends Extract<keyof A, string> = Extract<keyof A, string>,
>(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  allowed: A,
  defaultKey: Extract<keyof A, string>,
  defaultDir: SortDirection = "desc",
  sortParam: string = "sort",
  dirParam: string = "dir",
): SortResult<Extract<keyof A, string>> {
  type K = Extract<keyof A, string>;
  const rawSort = pickParam(searchParams, sortParam);
  const rawDir = pickParam(searchParams, dirParam);

  const key: K = (rawSort && rawSort in allowed ? (rawSort as K) : defaultKey);
  const direction: SortDirection =
    rawDir === "asc" || rawDir === "desc" ? rawDir : defaultDir;

  const col = allowed[key];
  const dirSql = direction === "asc" ? "ASC NULLS LAST" : "DESC NULLS LAST";
  const orderBySql = `${col} ${dirSql}`;

  const hrefFor = (
    column: K,
    colDefault: SortDirection = "desc",
    preserve: Record<string, string | undefined> = {},
  ): string => {
    // If clicking the already-active column, toggle direction.
    // Otherwise, start at the column's natural default direction.
    const nextDir: SortDirection =
      column === key ? (direction === "asc" ? "desc" : "asc") : colDefault;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(preserve)) {
      if (v !== undefined && v !== "") params.set(k, v);
    }
    params.set(sortParam, column);
    params.set(dirParam, nextDir);
    return `?${params.toString()}`;
  };

  return { key, direction, orderBySql, hrefFor };
}
