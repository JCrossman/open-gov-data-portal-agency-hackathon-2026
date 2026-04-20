import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { T3010_METRIC_SCHEMA_NOTE } from "@/lib/metrics";
import { DefaultAzureCredential } from "@azure/identity";
import type { Lang } from "@/lib/i18n";

const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-41";
const AZURE_OPENAI_API_VERSION = "2024-08-01-preview";

function getAzureOpenAIEndpoint(): string {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) throw new Error("AZURE_OPENAI_ENDPOINT env var is required");
  return endpoint;
}

const SCHEMA = `
Tables and columns (PostgreSQL):

contracts (1.26M rows): id, vendor_name, contract_value numeric, original_value numeric, amendment_value numeric, solicitation_procedure text (TN=sole source, TC=competitive, OB=open bid), owner_org_title text (department — bilingual "English | Français"), contract_date date, commodity_type text (S=services, G=goods, C=construction), description_en text, description_fr text (French translation of description — populated via templated join, may be NULL for uncommon descriptions; use COALESCE(description_fr, description_en) when answering French questions), instrument_type text, reference_number text, effective_value numeric, amendment_ratio numeric

grants (1.275M rows): id, recipient_legal_name text, recipient_business_number text, agreement_value numeric, agreement_type text, owner_org_title text (bilingual "English | Français"), prog_name_en text, prog_name_fr text (French program name — may be NULL, use COALESCE(prog_name_fr, prog_name_en)), recipient_province text, recipient_city text, recipient_type text, agreement_start_date date, agreement_end_date date, description_en text, description_fr text (French description — may be NULL, use COALESCE), prog_purpose_en text, prog_purpose_fr text, agreement_title_en text, agreement_title_fr text


t3010_id (83K rows): id, bn text (business number), legal_name text, account_name text, category text, designation text, address text, city text, province text, postal_code text

t3010_financial (83K rows): id, bn text, total_revenue numeric (CRA Line 4200), total_expenditure numeric (CRA Line 5100), gov_funding_federal numeric (CRA Line 4120: self-reported revenue from selling goods/services to government — the ONLY column that reflects government revenue), gov_funding_provincial numeric (CRA Line 4130: INVESTMENT INCOME — NOT provincial government funding, misleading column name), gov_funding_other numeric (CRA Line 4140: OTHER REVENUE like unrealized gains — NOT municipal government funding, misleading column name), compensation numeric (CRA Line 4540 — total management/admin compensation), mgmt_admin_exp numeric (CRA Line 5010 — management/admin expenditure, use only as fallback when compensation is null), fpe date (fiscal period end — use this as the date column for any charity time-series; one row per charity per fiscal year)

t3010_directors (568K rows): id, bn text, last_name text, first_name text, position text, at_arms_length text, start_date text

t3010_transfers (344K rows): id, donor_bn text, donee_bn text, donee_name text, total_gifts numeric, associated text, city text, province text

t3010_compensation (42K rows): id, bn text, ft_employees numeric, pt_employees numeric

t3010_programs (95K rows): id, bn text, program_type text, description text

wrongdoing (228 rows): id, fiscal_year text (string like "2020-2021", NOT a date — never pass to EXTRACT), quarter text, owner_org text, owner_org_title text, raw_fields jsonb

mv_policy_alignment (8 rows — PRE-COMPUTED POLICY COMMITMENT TRACKER): id text, name text (e.g. 'Canada-Wide Early Learning and Child Care (CWELCC)', 'National Housing Strategy', 'Canadian Dental Care Plan', 'National Pharmacare (Bill C-64, Phase 1)', 'Defence Policy: Our North, Strong and Free', 'Net Zero Accelerator (Strategic Innovation Fund)', 'Working Together to Improve Health Care for Canadians', 'Indigenous Priorities & Reconciliation (Budget 2021 envelope)'), department text, announced_year int, total_commitment_cad numeric, period_years int, annual_target numeric (total/period_years), annual_actual numeric (actual annual disbursement from grants matching the commitment's keywords/regex), annual_gap numeric (target − actual), gap_pct numeric (annual_gap / annual_target × 100; can be negative when actual exceeds target), grant_count int, years_observed int, delivery_note text, source_url text, description text.

adverse_media (3,584 rows): id, recipient_name text, signal_type text (sanction | enforcement | filing_lapse), source text, event_date date, severity int, description text
adverse_media_matches (369 rows): id, adverse_media_id int, recipient_legal_name text, bn text, matched_funding numeric, latest_funding_date date

mv_zombie_recipients (PRE-COMPUTED — use this for "ceased operations / deregistered / disappeared / zombie" questions): bn text (9-digit BN prefix), legal_name text, designation text, category text, total_revenue numeric, last_fpe date (last T3010 filing fiscal period end), last_list_year int (last year the charity appeared on the CRA List of Charities; NULL or old ⇒ deregistered), gov_funding_annual numeric (annualized federal grants), total_grants_2020p numeric (total federal grants 2020+), grant_count int, years_active int, last_grant_date date, grants_3yr_pre_fpe numeric (grants received in 3y before last filing), gov_pct numeric (0–100, capped), fpe_age_months numeric (months since last filing), cohort text ('cessation' = disappeared/deregistered after funding; 'dependency_risk' = still active but ≥70% government-funded).

mv_ghost_capacity (PRE-COMPUTED — use for "no capacity / no employees / pass-through / ghost" questions): keyed by bn text; rank with ORDER BY ghost_score DESC. If unsure which columns are available for projection, SELECT *.

mv_amendment_creep (PRE-COMPUTED — use for "sole-source / amendment / contract grew" questions): keyed by contract_key text with vendor_name, owner_org_title, original_value, effective_value, amendment_count, amendment_ratio. If unsure, SELECT *.

mv_vendor_concentration_by_category / mv_vendor_concentration_by_department (PRE-COMPUTED — use for "vendor concentration / market share / monopoly / top supplier" questions): keyed by segment text (category or department) with display_name (vendor), total_value, contract_count, share_pct, rnk. If unsure, SELECT *.

mv_funding_reciprocals / mv_funding_triangles / mv_funding_chains_4 / mv_funding_loop_classification (PRE-COMPUTED — use for "circular money / charity loops / reciprocal gifts" questions). If unsure which columns are needed, SELECT *.

mv_purpose_cluster (PRE-COMPUTED — use for "duplicative funding / multi-department overlap" questions): columns include purpose_cluster, n_departments, n_programs, grant_count, total_value, departments, programs. If unsure, SELECT *.

mv_contract_yoy_decomposition (PRE-COMPUTED — use for "cost growth / contract spending over time / price vs volume" questions). If unsure which columns are available, SELECT *.

policy_targets (8 rows — source table for mv_policy_alignment): same columns as the MV minus the derived ones.

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
18. POLICY COMMITMENT QUESTIONS — always query mv_policy_alignment, never a LIKE against grants:
    When the user asks about any named federal policy commitment, target, or announced envelope (e.g. CWELCC, National Housing Strategy, Canadian Dental Care Plan, National Pharmacare, Defence Policy / Our North Strong and Free, Net Zero Accelerator, Working Together to Improve Health Care / health transfers, Indigenous Priorities / reconciliation envelope), query mv_policy_alignment directly — it already contains the matched actual spending, annual target, gap, and delivery note. Match on name ILIKE (the short-name acronym is usually in parentheses in the name column).
    GOOD:  SELECT name, department, annual_target, annual_actual, annual_gap, gap_pct, delivery_note FROM mv_policy_alignment WHERE name ILIKE '%CWELCC%';
    BAD:   SELECT SUM(agreement_value) FROM grants WHERE prog_name_en ILIKE '%canada-wide early learning%'; -- will return null because the match logic is in the MV, not this literal string.
19. CHART HINT (optional, advisory only): After the final SQL semicolon, you MAY append a single line of the form:
    -- CHART: {"type":"<bar|line|kpi|stacked_bar|grouped_bar|multi_line>","x":"<column_alias>","y":"<numeric_column_alias>","series":"<optional_second_category_alias>","title":"<short title>"}
   Pick the type that best fits the shape you are returning:
   • bar — one categorical (x) + one numeric (y), short list.
   • line — one temporal (x) + one numeric (y).
   • stacked_bar — one categorical (x) + one second categorical (series) + one numeric (y); bars split by series.
   • grouped_bar — same shape as stacked_bar but when comparing series side-by-side is clearer.
   • multi_line — one temporal (x) + one categorical (series) + one numeric (y); one line per series.
   • kpi — exactly one row, one numeric.
   Omit the hint entirely if no chart type fits (e.g., rows are individual records, free-text columns, multiple unrelated metrics). The client will fall back to its own heuristic or render a table.
20. BN COLUMN NAMES — do NOT assume a single column name across tables. The business-number column is named differently per table and using the wrong name will raise "column does not exist":
    • grants.recipient_business_number          (long form)
    • contracts.vendor_name (NO bn column)
    • t3010_id.bn, t3010_financial.bn, t3010_directors.bn, t3010_compensation.bn, t3010_programs.bn, t3010_transfers.donor_bn / donee_bn
    • adverse_media_matches.bn                  (short — NOT recipient_business_number)
    • mv_zombie_recipients.bn, mv_ghost_capacity.bn
    When joining across tables, always take the 9-digit prefix: substr(grants.recipient_business_number, 1, 9) = amm.bn
21. ROUTE CHALLENGE QUESTIONS TO THE PRE-COMPUTED MV — never re-derive these from base tables:
    • "ceased / deregistered / disappeared / went bankrupt / zombie" → mv_zombie_recipients WHERE cohort = 'cessation'
    • "gov-dependent / relies on government / would collapse without funding" → mv_zombie_recipients WHERE cohort = 'dependency_risk'
    • "no employees / no capacity / pass-through / ghost" → mv_ghost_capacity ORDER BY ghost_score DESC
    • "sole-source / amendment creep / contract grew" → mv_amendment_creep. NOTE: mv_amendment_creep.contract_date is stored as text, not date — to filter by year use substring(contract_date, 1, 4)::int = 2025 or contract_date >= '2025-01-01' (string comparison works because values are ISO YYYY-MM-DD). Never call EXTRACT(YEAR FROM contract_date) on it; never cast contract_key to date.
    • "vendor concentration / market share / top supplier" → mv_vendor_concentration_by_category or _by_department
    • "circular money / funding loops / reciprocal gifts" → mv_funding_reciprocals / _triangles / _chains_4
    • "duplicative / multi-department overlap" → mv_purpose_cluster
    • "contract cost growth / procurement trends over time" → mv_contract_yoy_decomposition
    • Named policy commitment (CWELCC, NHS, CDCP, etc.) → mv_policy_alignment (see rule 18)
    These MVs already handle the correctness gotchas (government-entity exclusion, BN-prefix matching, annualization, capping, dedup). Re-deriving the answer with raw joins is slower AND usually wrong.
`;

async function getAzureOpenAIToken(): Promise<string> {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  return token.token;
}

async function generateSQL(
  question: string,
  history: { question: string; sql: string }[] = [],
  lang: Lang = "en",
): Promise<{ sql: string; hint: ChartHint | null }> {
  const token = await getAzureOpenAIToken();
  const url = `${getAzureOpenAIEndpoint()}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;

  const bilingualNote =
    lang === "fr"
      ? "\n\nBILINGUAL MODE: The user is asking in French. When your SELECT list includes descriptive text columns that have French siblings (description_en/description_fr, prog_name_en/prog_name_fr, prog_purpose_en/prog_purpose_fr, agreement_title_en/agreement_title_fr), always prefer the French via COALESCE, e.g. COALESCE(description_fr, description_en) AS description. For owner_org_title (already bilingual 'EN | FR'), leave as-is. Column names in WHERE clauses must stay English."
      : "";

  const messages: { role: string; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT + bilingualNote },
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
  let body: {
    question?: string;
    history?: unknown;
    lang?: string;
    agent?: boolean;
    stream?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const lang: Lang = body.lang === "fr" ? "fr" : "en";
  const agentMode = body.agent === true;
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

  if (!question) {
    return NextResponse.json({ error: "Please provide a question." }, { status: 400 });
  }
  if (question.length > 500) {
    return NextResponse.json({ error: "Question too long (max 500 chars)." }, { status: 400 });
  }

  // Streaming SSE response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // downstream closed
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        send("status", { phase: "understanding" });

        // Plan step (agent mode only)
        if (agentMode) {
          send("status", { phase: "planning" });
          const plan = await generatePlan(question, history, lang);
          send("plan", { steps: plan });
          // Run each step; aggregate rows
          const allRows: Record<string, unknown>[][] = [];
          const stepResults: { purpose: string; sql: string; rowCount: number }[] = [];
          for (let i = 0; i < plan.length; i++) {
            const step = plan[i];
            send("status", {
              phase: "running_step",
              step: i + 1,
              total: plan.length,
              purpose: step.purpose,
            });
            const validation = validateSQL(step.sql);
            if (!validation.valid) {
              send("step_error", { step: i + 1, error: validation.error });
              stepResults.push({ ...step, rowCount: 0 });
              allRows.push([]);
              continue;
            }
            try {
              const rows = await query(step.sql);
              allRows.push(rows);
              stepResults.push({ ...step, rowCount: rows.length });
              send("step_result", {
                step: i + 1,
                purpose: step.purpose,
                sql: step.sql,
                rowCount: rows.length,
                preview: rows.slice(0, 5),
              });
            } catch (e) {
              send("step_error", { step: i + 1, error: (e as Error).message });
              stepResults.push({ ...step, rowCount: 0 });
              allRows.push([]);
            }
          }
          // Use the last non-empty result as the "primary" for charting
          const primaryIdx = [...allRows].reverse().findIndex((r) => r.length > 0);
          const primaryRows =
            primaryIdx >= 0 ? allRows[allRows.length - 1 - primaryIdx] : [];
          send("rows", {
            rows: primaryRows,
            rowCount: primaryRows.length,
            elapsed: 0,
          });

          send("status", { phase: "summarizing" });
          // Synthesize a narrative across all steps
          const narrative = await streamAgentNarrative(
            question,
            stepResults,
            allRows,
            lang,
            send,
          );
          send("status", { phase: "checking" });
          const extras = await generateSuggestionsAndSelfCheck(
            question,
            stepResults[stepResults.length - 1]?.sql ?? "",
            primaryRows,
            narrative,
            lang,
          );
          send("suggestions", { suggestions: extras.suggestions });
          if (extras.self_check) send("self_check", { note: extras.self_check });
          send("done", {});
          close();
          return;
        }

        // Non-agent mode
        send("status", { phase: "writing" });
        const { sql, hint } = await generateSQL(question, history, lang);
        const validation = validateSQL(sql);
        if (!validation.valid) {
          send("error", { error: validation.error, sql });
          close();
          return;
        }
        send("sql", { sql, chart_hint: hint });

        send("status", { phase: "running" });
        const start = Date.now();
        let rows: Record<string, unknown>[] = [];
        try {
          rows = await query(sql);
        } catch (e) {
          const errMsg = (e as Error).message;
          // Friendly recovery: ask the model to rewrite the SQL using the
          // actual live schema. We try up to TWO recovery rounds because the
          // first error is often a cast/format issue that reveals a column
          // mismatch only on the next attempt.
          let prevSql = sql;
          let prevErr = errMsg;
          let recovered = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            const recovery = await attemptRecovery(question, prevSql, prevErr, lang);
            if (!recovery) break;
            send("sql", {
              sql: recovery.sql,
              chart_hint: recovery.hint,
              recovered: true,
            });
            try {
              rows = await query(recovery.sql);
              recovered = true;
              break;
            } catch (e2) {
              prevSql = recovery.sql;
              prevErr = (e2 as Error).message;
            }
          }
          if (!recovered) {
            send("error", {
              error: `I couldn't run that query. (${prevErr.slice(0, 140)})`,
              sql: prevSql,
            });
            close();
            return;
          }
        }
        const elapsed = Date.now() - start;
        send("rows", { rows, rowCount: rows.length, elapsed });

        if (rows.length > 0) {
          send("status", { phase: "summarizing" });
          const narrative = await streamNarrative(
            question,
            sql,
            rows,
            lang,
            send,
          );

          send("status", { phase: "checking" });
          const extras = await generateSuggestionsAndSelfCheck(
            question,
            sql,
            rows,
            narrative,
            lang,
          );
          send("suggestions", { suggestions: extras.suggestions });
          if (extras.self_check) send("self_check", { note: extras.self_check });
        }

        send("done", {});
        close();
      } catch (e) {
        console.error("[/api/ask stream]", e);
        send("error", { error: (e as Error).message?.slice(0, 300) ?? "Unknown error" });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** ============================================================
 *  Narrative, suggestions, self-check, agent planning, recovery
 *  ============================================================ */

function langInstruction(lang: Lang): string {
  return lang === "fr"
    ? "Always respond in Canadian French (français). Use Canadian French spellings and idioms."
    : "Always respond in English.";
}

function bilingualColumnHint(lang: Lang): string {
  return lang === "fr"
    ? "When the SELECT list includes descriptive text (description, program name, title), prefer COALESCE(*_fr, *_en) so French users see French text when available."
    : "";
}

async function streamNarrative(
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
  lang: Lang,
  send: (event: string, data: unknown) => void,
): Promise<string> {
  const preview = JSON.stringify(rows.slice(0, 20), null, 0);
  const system = `You are a Canadian government-accountability data analyst. Given the user's question, the SQL you ran, and up to 20 result rows, write 1–3 short, specific sentences that directly answer the question. Cite concrete numbers from the rows. When you reference a specific row, add a footnote marker like [^1] (1-indexed, matching the row order). Never invent numbers not in the rows. Do not repeat the question or start with "The query shows…". ${langInstruction(
    lang,
  )}`;
  const user = `Question: ${question}\n\nSQL:\n${sql}\n\nRows (first 20 as JSON):\n${preview}\n\nAnswer:`;
  let full = "";
  await streamChat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    (delta) => {
      full += delta;
      send("narrative_token", { t: delta });
    },
    { temperature: 0.2, max_tokens: 350 },
  );
  return full;
}

async function streamAgentNarrative(
  question: string,
  steps: { purpose: string; sql: string; rowCount: number }[],
  allRows: Record<string, unknown>[][],
  lang: Lang,
  send: (event: string, data: unknown) => void,
): Promise<string> {
  const stepDigest = steps
    .map((s, i) => {
      const rows = allRows[i] ?? [];
      const preview = JSON.stringify(rows.slice(0, 5), null, 0);
      return `Step ${i + 1} — ${s.purpose}\nRows returned: ${s.rowCount}\nPreview: ${preview}`;
    })
    .join("\n\n");
  const system = `You are a Canadian government-accountability data analyst. You just ran a multi-step investigation. Synthesize the findings in 2–4 short sentences that directly answer the user's original question. Cite concrete numbers. Use footnote markers [^N] where N refers to the step that produced the evidence. Never invent numbers not in the rows. ${langInstruction(
    lang,
  )}`;
  const user = `Original question: ${question}\n\n${stepDigest}\n\nSynthesis:`;
  let full = "";
  await streamChat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    (delta) => {
      full += delta;
      send("narrative_token", { t: delta });
    },
    { temperature: 0.3, max_tokens: 400 },
  );
  return full;
}

async function generateSuggestionsAndSelfCheck(
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
  narrative: string,
  lang: Lang,
): Promise<{ suggestions: string[]; self_check: string | null }> {
  const preview = JSON.stringify(rows.slice(0, 10), null, 0);
  const system = `You are a Canadian government-accountability data analyst. You just answered a question. Return a compact JSON object with two fields:
  1. "suggestions": an array of exactly 3 short (≤9 word) follow-up questions the user might naturally ask next. Phrase them as the user would type them. Make them genuinely useful — drill-downs, time comparisons, cross-references.
  2. "self_check": one short sentence (≤25 words) flagging any real caveat about this specific query: quarterly-snapshot duplicates, excluded placeholder recipients, date artifacts (pre-1990), ambiguous name matching, non-Canadian provinces, or missing data. If there is no material caveat, return null.
Respond with JSON only, no prose, no markdown fences. ${langInstruction(lang)}`;
  const user = `Question: ${question}\nSQL:\n${sql}\nAnswer just given: ${narrative}\nRow sample: ${preview}`;

  const raw = await chatOnce(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.4, max_tokens: 400 },
  );
  try {
    const cleaned = raw.replace(/^```json\n?|\n?```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      suggestions?: unknown;
      self_check?: unknown;
    };
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
          .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length < 120)
          .slice(0, 3)
      : [];
    const self_check =
      typeof parsed.self_check === "string" && parsed.self_check.length > 0
        ? parsed.self_check.slice(0, 240)
        : null;
    return { suggestions, self_check };
  } catch {
    return { suggestions: [], self_check: null };
  }
}

async function generatePlan(
  question: string,
  history: { question: string; sql: string }[],
  lang: Lang,
): Promise<{ purpose: string; sql: string }[]> {
  const system = `${SYSTEM_PROMPT}

---
AGENT MODE: Decompose the user's question into 2–4 steps that build on each other to produce a thorough, investigative answer. Each step is one SELECT. Return JSON only:
{"steps":[{"purpose":"<one short sentence of what this step establishes>","sql":"<single SELECT ending in ;>"}, ...]}
Each SQL must still obey every rule above (LIMIT, NULLS LAST, no joins to prior results, etc.). Do not include CHART hints inside steps. ${langInstruction(
    lang,
  )} ${bilingualColumnHint(lang)}`;

  const messages: { role: string; content: string }[] = [
    { role: "system", content: system },
  ];
  for (const t of history.slice(-2)) {
    messages.push({ role: "user", content: t.question });
    messages.push({ role: "assistant", content: t.sql });
  }
  messages.push({ role: "user", content: question });
  const raw = await chatOnce(messages, { temperature: 0.2, max_tokens: 1500 });
  try {
    const cleaned = raw.replace(/^```json\n?|\n?```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as { steps?: unknown };
    if (!Array.isArray(parsed.steps)) return [];
    return parsed.steps
      .filter(
        (s): s is { purpose: string; sql: string } =>
          !!s &&
          typeof s === "object" &&
          typeof (s as { purpose?: unknown }).purpose === "string" &&
          typeof (s as { sql?: unknown }).sql === "string",
      )
      .slice(0, 5)
      .map((s) => ({
        purpose: s.purpose.slice(0, 200),
        sql: s.sql.replace(/^```sql\n?|\n?```$/g, "").trim(),
      }));
  } catch {
    return [];
  }
}

/**
 * Given a failed SQL + Postgres error message, fetch the actual column list
 * for every table referenced in the SQL. Returned as a plain-text block that
 * can be pasted into a correction prompt so the model self-corrects against
 * the live schema instead of hallucinating again.
 */
async function buildSchemaSnapshot(
  failedSql: string,
  _errorMsg: string,
): Promise<string | null> {
  const known = new Set([
    "contracts",
    "grants",
    "t3010_id",
    "t3010_id_history",
    "t3010_financial",
    "t3010_directors",
    "t3010_transfers",
    "t3010_compensation",
    "t3010_programs",
    "wrongdoing",
    "adverse_media",
    "adverse_media_sources",
    "adverse_media_matches",
    "policy_targets",
    "mv_table_counts",
    "mv_zombie_recipients",
    "mv_ghost_capacity",
    "mv_amendment_creep",
    "mv_competitive_to_sole_source",
    "mv_threshold_splitting",
    "mv_same_vendor_followon",
    "mv_sole_source_count",
    "mv_vendor_concentration",
    "mv_vendor_concentration_by_category",
    "mv_vendor_concentration_by_department",
    "mv_vendor_name_dupes",
    "mv_funding_stats",
    "mv_funding_reciprocals",
    "mv_funding_top_transfers",
    "mv_funding_triangles",
    "mv_funding_chains_4",
    "mv_funding_loop_classification",
    "mv_related_parties",
    "mv_governance_flow_links",
    "mv_director_board_links",
    "mv_director_multi_board",
    "mv_policy_alignment",
    "mv_policy_buckets",
    "mv_purpose_cluster",
    "mv_purpose_overlap",
    "mv_duplicative_funding",
    "mv_grants_summary",
    "mv_contract_yoy_decomposition",
    "mv_contract_bucket_yearly",
    "mv_contract_growth_decomposition",
    "mv_contract_commodity",
    "mv_contract_solicitation",
    "mv_contract_yearly",
    "mv_contract_history",
    "mv_service_contracts_count",
  ]);

  const tokens = failedSql.toLowerCase().match(/[a-z_][a-z0-9_]+/g) ?? [];
  const referenced = Array.from(new Set(tokens.filter((t) => known.has(t))));

  const errMatch = _errorMsg.match(/relation "([^"]+)"|table "([^"]+)"/i);
  if (errMatch) {
    const t = (errMatch[1] || errMatch[2] || "").toLowerCase();
    if (t && known.has(t) && !referenced.includes(t)) referenced.push(t);
  }

  if (referenced.length === 0) return null;

  try {
    const rows = await query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ANY($1::text[])
         ORDER BY table_name, ordinal_position`,
      [referenced],
    );
    if (rows.length === 0) return null;
    const byTable = new Map<string, string[]>();
    for (const r of rows) {
      const list = byTable.get(r.table_name) ?? [];
      list.push(`${r.column_name} ${r.data_type}`);
      byTable.set(r.table_name, list);
    }
    return Array.from(byTable.entries())
      .map(([t, cols]) => `- ${t}: ${cols.join(", ")}`)
      .join("\n");
  } catch {
    return null;
  }
}

async function attemptRecovery(
  question: string,
  failedSql: string,
  errorMsg: string,
  lang: Lang,
): Promise<{ sql: string; hint: ChartHint | null } | null> {
  const schemaSnapshot = await buildSchemaSnapshot(failedSql, errorMsg);

  const system = `${SYSTEM_PROMPT}

---
The previous SQL you generated failed with this Postgres error:
${errorMsg.slice(0, 400)}
${schemaSnapshot ? `\nACTUAL COLUMNS of the tables you referenced (from the live database — trust this over any assumption):\n${schemaSnapshot}\n` : ""}
Rewrite a single corrected SELECT that answers the original question. Same rules as before. If the error was "column X does not exist", pick a real column from the list above (or change tables). Return the SQL only (no explanations), optionally followed by a CHART hint line. ${langInstruction(
    lang,
  )}`;
  try {
    const raw = await chatOnce(
      [
        { role: "system", content: system },
        { role: "user", content: question },
        { role: "assistant", content: failedSql },
        { role: "user", content: "Please fix it and try again." },
      ],
      { temperature: 0, max_tokens: 1000 },
    );
    return parseSqlAndHint(raw);
  } catch {
    return null;
  }
}

/** ============================================================
 *  Azure OpenAI low-level helpers (streaming + non-streaming)
 *  ============================================================ */

async function chatOnce(
  messages: { role: string; content: string }[],
  opts: { temperature?: number; max_tokens?: number } = {},
): Promise<string> {
  const token = await getAzureOpenAIToken();
  const url = `${getAzureOpenAIEndpoint()}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.max_tokens ?? 800,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Azure OpenAI ${res.status}: ${err.substring(0, 200)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

async function streamChat(
  messages: { role: string; content: string }[],
  onDelta: (chunk: string) => void,
  opts: { temperature?: number; max_tokens?: number } = {},
): Promise<void> {
  const token = await getAzureOpenAIToken();
  const url = `${getAzureOpenAIEndpoint()}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 400,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => "");
    throw new Error(`Azure OpenAI stream ${res.status}: ${err.substring(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const obj = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) onDelta(delta);
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

function parseSqlAndHint(raw: string): { sql: string; hint: ChartHint | null } {
  let sql = raw.replace(/^```sql\n?/i, "").replace(/\n?```$/i, "").trim();
  let hint: ChartHint | null = null;
  const hintRegex = /^\s*--\s*CHART\s*:\s*(\{[\s\S]*?\})\s*$/gim;
  const hintMatches = [...sql.matchAll(hintRegex)];
  if (hintMatches.length > 0) {
    try {
      hint = validateHint(JSON.parse(hintMatches[hintMatches.length - 1][1]));
    } catch {
      hint = null;
    }
    sql = sql.replace(hintRegex, "").trim();
  }
  return { sql, hint };
}
