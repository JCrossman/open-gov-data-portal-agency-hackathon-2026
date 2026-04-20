import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { T3010_METRIC_SCHEMA_NOTE } from "@/lib/metrics";
import { DefaultAzureCredential } from "@azure/identity";

const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-41";
const AZURE_OPENAI_API_VERSION = "2024-08-01-preview";

function getAzureOpenAIEndpoint(): string {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) throw new Error("AZURE_OPENAI_ENDPOINT env var is required");
  return endpoint;
}

const SCHEMA = `
Tables and columns (PostgreSQL):

contracts (1.26M rows): id, vendor_name, contract_value numeric, original_value numeric, amendment_value numeric, solicitation_procedure text (TN=sole source, TC=competitive, OB=open bid), owner_org_title text (department), contract_date date, commodity_type text (S=services, G=goods, C=construction), description_en text, instrument_type text, reference_number text, effective_value numeric, amendment_ratio numeric

grants (1.275M rows): id, recipient_legal_name text, recipient_business_number text, agreement_value numeric, agreement_type text, owner_org_title text (department), prog_name_en text (program), recipient_province text, recipient_city text, recipient_type text, agreement_start_date date, agreement_end_date date, description_en text

t3010_id (83K rows): id, bn text (business number), legal_name text, account_name text, category text, designation text, address text, city text, province text, postal_code text

t3010_financial (83K rows): id, bn text, total_revenue numeric (CRA Line 4200), total_expenditure numeric (CRA Line 5100), gov_funding_federal numeric (CRA Line 4120: self-reported revenue from selling goods/services to government — the ONLY column that reflects government revenue), gov_funding_provincial numeric (CRA Line 4130: INVESTMENT INCOME — NOT provincial government funding, misleading column name), gov_funding_other numeric (CRA Line 4140: OTHER REVENUE like unrealized gains — NOT municipal government funding, misleading column name), compensation numeric (CRA Line 4540 — total management/admin compensation), mgmt_admin_exp numeric (CRA Line 5010 — management/admin expenditure, use only as fallback when compensation is null), fpe date (fiscal period end — use this as the date column for any charity time-series; one row per charity per fiscal year)

t3010_directors (568K rows): id, bn text, last_name text, first_name text, position text, at_arms_length text, start_date text

t3010_transfers (344K rows): id, donor_bn text, donee_bn text, donee_name text, total_gifts numeric, associated text, city text, province text

t3010_compensation (42K rows): id, bn text, ft_employees numeric, pt_employees numeric

t3010_programs (95K rows): id, bn text, program_type text, description text

wrongdoing (228 rows): id, fiscal_year text (string like "2020-2021", NOT a date — never pass to EXTRACT), quarter text, owner_org text, owner_org_title text, raw_fields jsonb

Notes:
- contract_value, original_value, amendment_value, effective_value are stored as numeric
- solicitation_procedure: TN = sole source (non-competitive), TC = competitive, OB = open bidding
- commodity_type: S = services, G = goods, C = construction
- BN (business number) format: 9 digits + 'RR' + 4 digits (e.g., '123456789RR0001')
- Use ILIKE for case-insensitive text search
- agreement_value in grants is numeric
- For vendor/recipient name matching, use ILIKE '%pattern%'
- IMPORTANT: Some grants use placeholder recipient names like "batch report│rapport en lots" or "Batch report | rapport en lots" for aggregated bulk payments (e.g., Veterans Affairs disability pensions). These are NOT real recipients — they represent thousands of individual payments bundled into one row. When ranking top recipients, exclude them: AND recipient_legal_name NOT ILIKE '%batch report%'

CANONICAL FUNDING METRICS — must be used consistently:
${T3010_METRIC_SCHEMA_NOTE}
`;

const SYSTEM_PROMPT = `You are a SQL query generator for a Canadian government accountability database. Given a natural language question, generate a PostgreSQL SELECT query that answers it.

${SCHEMA}

Rules:
1. ONLY generate SELECT queries — never INSERT, UPDATE, DELETE, DROP, ALTER, or any DDL/DML.
2. Always LIMIT results to at most 100 rows unless the user specifically asks for more.
3. Use meaningful column aliases for readability.
4. Format monetary values as-is (the frontend will format them).
5. When unsure which table to query, prefer the most relevant one.
6. For department names, use owner_org_title with ILIKE.
7. Return ONLY the SQL query followed optionally by a single chart-hint line. No explanations, no markdown fences, no other comments.
8. If the question cannot be answered with the available data, return: SELECT 'This question cannot be answered with the available data.' AS error;
9. For contract monetary values, prefer effective_value over contract_value (effective_value is the most current/accurate amount).
10. Always add NULLS LAST to ORDER BY when sorting by numeric columns to avoid NULLs appearing first.
11. When summing monetary values, use COALESCE(column, 0) to handle NULLs.
12. For province filtering, the grants table uses abbreviations (AB, BC, ON, QC, etc.) in recipient_province.
13. When querying by date or year, exclude dates before 1990 — a small number of records have artifact dates (1899-12-30) from data import errors. Add a filter like: WHERE date_column >= '1990-01-01' or EXTRACT(YEAR FROM ...) >= 1990. Real data starts around 1997.
14. When the AI generates a "year" column via EXTRACT(YEAR ...), cast it to integer: EXTRACT(YEAR FROM date)::int.
15. CANADIAN PROVINCES ONLY: recipient_province in grants, and province in t3010_id/t3010_transfers, contain non-Canadian codes (US state codes like WV/WI, placeholder codes like ZZ/Z9/Z7, blanks, and nulls) because the datasets include foreign recipients and data-entry artifacts. When a question refers to "provinces", "province-level", or any geographic ranking across Canada, always filter to canonical Canadian province/territory codes: recipient_province IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'). Use the same list for t3010_id.province. Only include other codes if the user explicitly asks about foreign or non-Canadian recipients.
16. CONVERSATIONAL CONTEXT: You may receive prior turns as "Previous question" / "Previous SQL" messages. Use them to resolve follow-up references like "that", "those", "the same", "now by year", "drill into <row>". Generate a fresh SELECT that stands alone — do not reference prior results, only reuse structure and filters.
17. DATE COLUMNS — only use EXTRACT/date functions on real DATE/TIMESTAMP columns:
    • grants.agreement_start_date, grants.agreement_end_date
    • contracts.contract_date
    • t3010_financial.fpe (fiscal period end — use this for charity time-series)
    Do NOT call EXTRACT on integer columns (like a pre-computed "year" alias) or on text columns (wrongdoing.fiscal_year is text like "2020-2021"; if you need a year from it use: substring(fiscal_year, 1, 4)::int). When the prior SQL returned a "year" alias as ::int, reference that alias directly — do NOT re-wrap it in EXTRACT.
18. CHART HINT (optional, advisory only): After the final SQL semicolon, you MAY append a single line of the form:
    -- CHART: {"type":"<bar|line|kpi|stacked_bar|grouped_bar|multi_line>","x":"<column_alias>","y":"<numeric_column_alias>","series":"<optional_second_category_alias>","title":"<short title>"}
   Pick the type that best fits the shape you are returning:
   • bar — one categorical (x) + one numeric (y), short list.
   • line — one temporal (x) + one numeric (y).
   • stacked_bar — one categorical (x) + one second categorical (series) + one numeric (y); bars split by series.
   • grouped_bar — same shape as stacked_bar but when comparing series side-by-side is clearer.
   • multi_line — one temporal (x) + one categorical (series) + one numeric (y); one line per series.
   • kpi — exactly one row, one numeric.
   Omit the hint entirely if no chart type fits (e.g., rows are individual records, free-text columns, multiple unrelated metrics). The client will fall back to its own heuristic or render a table.
`;

async function getAzureOpenAIToken(): Promise<string> {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  return token.token;
}

async function generateSQL(
  question: string,
  history: { question: string; sql: string }[] = [],
): Promise<{ sql: string; hint: ChartHint | null }> {
  const token = await getAzureOpenAIToken();
  const url = `${getAzureOpenAIEndpoint()}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;

  const messages: { role: string; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  // Include up to the last 4 prior turns as conversational context so the
  // model can resolve follow-up references ("those", "same by year", etc.).
  const recent = history.slice(-4);
  for (const turn of recent) {
    messages.push({ role: "user", content: turn.question });
    if (turn.sql) {
      messages.push({ role: "assistant", content: turn.sql });
    }
  }
  messages.push({ role: "user", content: question });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages,
      temperature: 0,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Azure OpenAI error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  let raw = data.choices?.[0]?.message?.content?.trim() ?? "";

  // Strip markdown fences if present
  raw = raw.replace(/^```sql\n?/i, "").replace(/\n?```$/i, "").trim();

  // Extract optional CHART hint line(s). Hint line looks like:
  //   -- CHART: {"type":"bar","x":"province","y":"total_grant_funding", ...}
  let hint: ChartHint | null = null;
  const hintRegex = /^\s*--\s*CHART\s*:\s*(\{[\s\S]*?\})\s*$/gim;
  const hintMatches = [...raw.matchAll(hintRegex)];
  if (hintMatches.length > 0) {
    const last = hintMatches[hintMatches.length - 1];
    try {
      const parsed = JSON.parse(last[1]);
      hint = validateHint(parsed);
    } catch {
      hint = null;
    }
    // Remove hint line(s) from SQL payload.
    raw = raw.replace(hintRegex, "").trim();
  }

  return { sql: raw, hint };
}

type ChartHint = {
  type:
    | "bar"
    | "line"
    | "kpi"
    | "stacked_bar"
    | "grouped_bar"
    | "multi_line";
  x?: string;
  y?: string;
  series?: string;
  title?: string;
};

const CHART_TYPES = new Set<ChartHint["type"]>([
  "bar",
  "line",
  "kpi",
  "stacked_bar",
  "grouped_bar",
  "multi_line",
]);

function validateHint(parsed: unknown): ChartHint | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const type = typeof p.type === "string" ? (p.type as ChartHint["type"]) : null;
  if (!type || !CHART_TYPES.has(type)) return null;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 && v.length < 200 ? v : undefined;
  return {
    type,
    x: str(p.x),
    y: str(p.y),
    series: str(p.series),
    title: str(p.title),
  };
}

function validateSQL(sql: string): { valid: boolean; error?: string } {
  const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const upper = stripped.toUpperCase();

  // Block anything that's not a SELECT
  const dangerous = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXECUTE|EXEC)\b/;
  if (dangerous.test(upper)) {
    return { valid: false, error: "Only SELECT queries are allowed." };
  }

  if (!upper.trimStart().startsWith("SELECT")) {
    return { valid: false, error: "Query must start with SELECT." };
  }

  // Reject queries that misuse CRA T3010 columns 4130 / 4140 as if they were
  // government funding. Those columns are investment income and other
  // revenue respectively (column names are misleading). Verified federal
  // disbursements live in the `grants` table.
  const lower = stripped.toLowerCase();
  const usesProv = /gov_funding_provincial/.test(lower);
  const usesOther = /gov_funding_other/.test(lower);
  // Pattern 1: SUM/AVG containing one of those columns.
  const inAggregate = /\b(sum|avg|max|min)\s*\([^)]*gov_funding_(provincial|other)/i.test(stripped);
  // Pattern 2: arithmetic addition of those columns to gov_funding_federal.
  const summedWithFederal =
    /gov_funding_federal\s*\+\s*gov_funding_(provincial|other)/i.test(stripped) ||
    /gov_funding_(provincial|other)\s*\+\s*gov_funding_federal/i.test(stripped) ||
    /gov_funding_provincial\s*\+\s*gov_funding_other/i.test(stripped);
  // Pattern 3: aliased as government funding / total.
  const aliasedAsGov = /gov_funding_(provincial|other)[\s\S]{0,120}\bAS\s+["'`]?(total_)?(government|gov)_?(funding|revenue)/i.test(stripped);

  if (inAggregate || summedWithFederal || aliasedAsGov) {
    return {
      valid: false,
      error:
        "Query treats t3010_financial.gov_funding_provincial (Line 4130, investment income) " +
        "or gov_funding_other (Line 4140, other revenue) as government funding. Those columns " +
        "are misleadingly named and do NOT represent government funding. For verified federal " +
        "disbursements, query the grants table joined by substr(recipient_business_number,1,9) " +
        "= substr(t3010_id.bn,1,9). For self-reported government revenue, use " +
        "t3010_financial.gov_funding_federal (CRA Line 4120) only.",
    };
  }

  // Standalone reference (e.g. SELECTing the column) is allowed but only when
  // labelled correctly — never silently summed into a "government funding"
  // total.
  if ((usesProv || usesOther) && /gov(ernment)?[_ ](funding|revenue)/i.test(stripped) && !/investment[_ ]income|other[_ ]revenue/i.test(stripped)) {
    return {
      valid: false,
      error:
        "Query references gov_funding_provincial / gov_funding_other in a context that " +
        "labels them as government funding. Those columns are CRA Line 4130 (investment " +
        "income) and Line 4140 (other revenue). Use the grants table for verified federal " +
        "disbursements, or gov_funding_federal alone for self-reported government revenue.",
    };
  }

  return { valid: true };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const question = body.question?.trim();
    const historyInput = Array.isArray(body.history) ? body.history : [];
    const history = historyInput
      .filter(
        (h: unknown): h is { question: string; sql: string } =>
          !!h &&
          typeof h === "object" &&
          typeof (h as { question?: unknown }).question === "string" &&
          typeof (h as { sql?: unknown }).sql === "string",
      )
      .map((h: { question: string; sql: string }) => ({
        question: h.question.slice(0, 500),
        sql: h.sql.slice(0, 2000),
      }));

    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "Please provide a question." }, { status: 400 });
    }

    if (question.length > 500) {
      return NextResponse.json({ error: "Question too long (max 500 chars)." }, { status: 400 });
    }

    // Generate SQL from the question
    const { sql, hint } = await generateSQL(question, history);
    const validation = validateSQL(sql);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error, sql }, { status: 400 });
    }

    // Execute the query
    const start = Date.now();
    const rows = await query(sql);
    const elapsed = Date.now() - start;

    return NextResponse.json({
      question,
      sql,
      rows,
      rowCount: rows.length,
      elapsed,
      chart_hint: hint,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "Unknown error";
    console.error("[/api/ask]", msg);
    return NextResponse.json({ error: msg.substring(0, 300) }, { status: 500 });
  }
}
