import pg from "pg";

const RAW_DATABASE_URL = process.env.DATABASE_URL;
// Only used as a last-resort placeholder so that Next.js type-checking and
// build-time imports don't crash. If this value is ever actually handed to
// pg.Pool, getPool() throws below — we never do DNS on the literal "HOST".
const PLACEHOLDER_URL =
  "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require";
const DATABASE_URL = RAW_DATABASE_URL ?? PLACEHOLDER_URL;

// Connection pool (reused across requests in Next.js)
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    if (!RAW_DATABASE_URL || DATABASE_URL === PLACEHOLDER_URL) {
      throw new Error(
        "DATABASE_URL is not configured. Set it in the runtime environment; " +
          "do not attempt to connect using the placeholder connection string."
      );
    }
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      ssl: { rejectUnauthorized: false },
    });
    pool.on("error", () => {
      // Prevent unhandled pool errors from crashing the process
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

/**
 * Same as query() but returns empty array on any DB error.
 * Use in pages where a DB failure should produce empty/fallback UI, not a crash.
 *
 * WARNING: Prefer queryWithStatus() for any read that drives a headline KPI,
 * a findings table, or any factual claim. querySafe() makes DB failures look
 * like zero results, which on this platform is a correctness risk.
 */
export async function querySafe<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  try {
    return await query<T>(sql, params);
  } catch (err) {
    console.error("[db.querySafe] query failed:", (err as Error)?.message ?? err);
    return [];
  }
}

export type QueryStatus<T> =
  | { ok: true; rows: T[] }
  | { ok: false; error: string };

/**
 * Critical-path query. Returns {ok:true, rows} on success, or {ok:false, error}
 * on failure. Callers MUST branch on `ok` and render an explicit unavailable
 * state when false — never fall through to zero-result UI, since a failing MV
 * would otherwise be indistinguishable from a real empty result.
 */
export async function queryWithStatus<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<QueryStatus<T>> {
  try {
    const rows = await query<T>(sql, params);
    return { ok: true, rows };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error("[db.queryWithStatus] query failed:", message);
    return { ok: false, error: message };
  }
}

export async function queryOne<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function count(table: string, where?: string, params?: unknown[]): Promise<number> {
  const sql = where ? `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}` : `SELECT COUNT(*)::int AS n FROM ${table}`;
  const row = await queryOne<{ n: number }>(sql, params);
  return row?.n ?? 0;
}
