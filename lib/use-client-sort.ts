"use client";

import { useMemo, useState } from "react";

export type ClientSortDirection = "asc" | "desc";
export type ClientSortState<K extends string> = {
  key: K;
  direction: ClientSortDirection;
};

export type SortValueGetter<T> = (row: T) => string | number | Date | null | undefined;

/**
 * Client-side sort hook for in-memory row arrays.
 *
 * Usage:
 *   const sort = useClientSort(rows, {
 *     name: (r) => r.name,
 *     value: (r) => r.value,
 *     date: (r) => r.date,
 *   }, { key: "value", direction: "desc" });
 *
 *   {sort.rows.map(...)}
 *   <ClientSortableHeader columnKey="value" ... sort={sort} />
 */
export function useClientSort<T, K extends string>(
  rows: readonly T[],
  getters: Record<K, SortValueGetter<T>>,
  initial: ClientSortState<K>,
) {
  const [state, setState] = useState<ClientSortState<K>>(initial);

  const sortedRows = useMemo(() => {
    const getter = getters[state.key];
    if (!getter) return [...rows];
    const mul = state.direction === "asc" ? 1 : -1;

    const valOf = (r: T): string | number => {
      const v = getter(r);
      if (v == null) return state.direction === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      if (v instanceof Date) return v.getTime();
      if (typeof v === "number") return v;
      return String(v).toLowerCase();
    };

    return [...rows].sort((a, b) => {
      const va = valOf(a);
      const vb = valOf(b);
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * mul;
      }
      return String(va).localeCompare(String(vb)) * mul;
    });
  }, [rows, getters, state]);

  const toggle = (key: K, defaultDir: ClientSortDirection = "desc") => {
    setState((s) =>
      s.key === key
        ? { key, direction: s.direction === "asc" ? "desc" : "asc" }
        : { key, direction: defaultDir },
    );
  };

  return {
    key: state.key,
    direction: state.direction,
    rows: sortedRows,
    toggle,
  };
}

export type ClientSortResult<K extends string> = ReturnType<typeof useClientSort<unknown, K>>;
