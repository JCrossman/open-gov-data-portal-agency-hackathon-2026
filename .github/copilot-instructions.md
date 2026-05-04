# Copilot Instructions — Open Gov Data Portal

## Build, Test, and Run

```bash
npm install              # install dependencies
npm run dev              # local dev server at http://localhost:3000
npm run build            # production build (Next.js standalone output)
npm run build:mcp        # compile the MCP server (tsc → dist/)
```

### Tests

The test suite is Playwright-based, running against a live (local or deployed) site:

```bash
# Run all audit tests
npx playwright test tests/audit/ --reporter=list

# Run a single test file
npx playwright test tests/audit/challenge-truth.spec.ts

# Run a specific test by name
npx playwright test -g "Zombie Recipients"
```

Tests require `ACCESS_CODE` and `BASE_URL` env vars (see `.env.example`). Playwright config injects the access cookie automatically.

There is no linter or type-check script in `package.json`. Use `npx tsc --noEmit` to type-check.

### Docker (for deployment)

```bash
docker build --platform linux/amd64 -t opengovacr.azurecr.io/opengov-app:<tag> -f Dockerfile .
docker push opengovacr.azurecr.io/opengov-app:<tag>
az containerapp update --subscription <sub-1-id> --name opengov-app \
  --resource-group rg-opengov-accountability --image opengovacr.azurecr.io/opengov-app:<tag>
```

Always build with `--platform linux/amd64` — the dev machine is ARM Mac but Container Apps requires amd64.

## Architecture

This is a **dual-purpose repo**: a Next.js 16 web app (App Router) and a Claude Desktop MCP server, sharing the same `package.json`.

### Web App (Next.js)

- **Pages**: `app/` — App Router with `force-dynamic` on all DB-backed pages (no ISR/SSG for data pages)
- **API routes**: `app/api/` — the `/api/ask` route is the most complex (natural language → GPT-4.1 → SQL → streaming SSE → self-healing retry with schema introspection)
- **Database**: PostgreSQL via `lib/db.ts` — singleton `pg.Pool`, accessed through `query()`, `querySafe()`, `queryWithStatus()`, and `queryOne()` helpers
- **AI**: Azure OpenAI via `@azure/identity` `DefaultAzureCredential` (managed identity in Azure, API key locally)
- **Auth**: Cookie-based access code checked in `middleware.ts`; all routes except `/access` require the `opengov_access` cookie
- **Bilingual**: EN/FR via `components/AutoTranslate.tsx` (client-side DOM translation through `/api/translate`) + `lib/i18n.ts` (server-side language detection from cookie/Accept-Language)

### MCP Server (Claude Desktop)

- **Source**: `src/` — compiled to `dist/` via `tsconfig.mcp.json`
- **Entry**: `src/index.ts` → `dist/index.js` (stdio transport)
- **22 tools, 10 prompt templates** for querying open.canada.ca CKAN DataStore API

### Database Layer

- **38 materialized views** are the single source of truth for all challenge page analytics
- MV definitions live in `scripts/optimize-db.ts` — this is the canonical reference. Pages must not re-derive metrics with different logic
- After modifying an MV: run `scripts/optimize-db.ts --force` to rebuild, then spot-check benchmark entities
- ETL pipeline: `scripts/ingest-api.ts` (CKAN API → PostgreSQL, auto-refreshes MVs after load)

## Key Conventions

### Data Accuracy is Non-Negotiable

This is a government accountability platform. Every displayed number must be correct and consistent across all views. Before deploying changes that affect data display:

1. Run validation queries against the live database
2. Verify at least 3 benchmark entities (S.U.C.C.E.S.S., Mastercard Foundation, Sobey Foundation, Canadian Red Cross, GOUVERNEMENT DU QUÉBEC) across 2+ views
3. Ensure the same entity shows identical numbers on challenge pages, entity profiles, and AI queries

### Misleading Column Names

The `t3010_financial` table has **critically misleading column names**:

| Column | Actual CRA Field | What It Really Is |
|--------|-----------------|-------------------|
| `gov_funding_federal` | Line 4120 | Self-reported gov revenue (any level) — the ONLY gov revenue column |
| `gov_funding_provincial` | Line 4130 | **Investment income** — NOT provincial gov funding |
| `gov_funding_other` | Line 4140 | **Other revenue** (unrealized gains) — NOT municipal gov funding |

**Never** sum 4120 + 4130 + 4140 as "total government funding." Use the `grants` table for verified federal disbursements. All metric computation must go through `lib/metrics.ts`.

### BN (Business Number) Matching

Always use `substr(bn, 1, 9)` prefix matching when cross-referencing between `grants` and T3010 tables. Name-based `ILIKE` matching misses recipient name variations and under-counts.

### Dependency Percentages

Annualize multi-year grants: `SUM(agreement_value) / COUNT(DISTINCT years) / annual_revenue`. Cap at 100%. Use `lib/metrics.ts` — never recompute these independently.

### DB Query Patterns

- Use `queryWithStatus()` for any read that drives headline KPIs or factual claims — it distinguishes DB failures from empty results
- Use `querySafe()` only for non-critical fallback UI
- Challenge pages read from materialized views, never from base tables directly

### No Internal References in UI

Never reference `CLAUDE.md`, `ChallengePrompts.md`, or any internal filename in user-facing text (page copy, API responses, tooltips, error messages). Describe methodologies in plain language.

### Hackathon Mode

This is a hackathon entry — ship the complete, correct solution in every session. No "follow-up", "future work", "TODO later", or deferral language. If a real fix is identified mid-task, implement it immediately.

## Deployment

- **Azure Container Apps** in Canada Central (subscription: ME-MngEnvMCAP516709-jcrossman-1)
- **Azure OpenAI** with Entra ID managed identity (no API keys in production)
- **ACR**: `opengovacr.azurecr.io/opengov-app`
- All DB-backed pages use `force-dynamic` — no ISR caching
- Env vars: see `.env.example` for the full list

## Regression Gates

These Playwright tests are the permanent quality gates — never remove or weaken them:

- `challenge-truth.spec.ts` — row-level verification of all 10 challenge findings against raw tables
- `pages.spec.ts` — page structure, required sections, accessibility
- `benchmarks.spec.ts` — benchmark entity validation
- `data-integrity.mjs` — cross-table row count sanity checks

## Reference

The comprehensive project constitution is in `CLAUDE.md` at the repo root. It contains the full challenge definitions, challenge-specific guardrails, all 38 MV definitions, data quality issues, and resolved bugs. Consult it for any domain-specific question.
