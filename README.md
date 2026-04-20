# Open Gov Data Portal — Government of Alberta AI Hackathon 2026

A government accountability platform that combines a Next.js web application
and a Claude Desktop MCP server to query **3.75 million+** federal records —
contracts, grants, charity (T3010) filings, sanctions, and regulatory actions —
to answer ten public-interest challenges about who really gets public money,
who can actually deliver, and where the rhetoric does not match the spending.

> **Built for the Government of Alberta AI Hackathon 2026.** Hackathon
> prototype, not a production system. Data is sourced from
> [open.canada.ca](https://open.canada.ca).

---

## The 10 Challenges

| # | Challenge | What it answers |
|---|---|---|
| 1 | **Zombie Recipients** | Who got large public funding and then disappeared (deregistered, dissolved, stopped filing)? |
| 2 | **Ghost Capacity** | Who is funded but shows no employees, no programs, no real address — just compensation and pass-through transfers? |
| 3 | **Funding Loops** | Where does money flow in circles between charities, and which loops are structural vs suspicious? |
| 4 | **Sole Source & Amendment Creep** | Which contracts started small and competitive but grew through sole-source amendments? |
| 5 | **Vendor Concentration** | In which categories has incumbency replaced competition? |
| 6 | **Related Parties** | Who controls the entities receiving public money, and do they also control each other? |
| 7 | **Policy Misalignment** | Does the spending pattern match stated federal priorities (NHS, CWELCC, Net Zero, defence, …)? |
| 8 | **Duplicative Funding & Gaps** | Where are multiple levels of government funding the same purpose — or none of them are? |
| 9 | **Contract Intelligence** | Where are taxpayers getting less for more (cost growth driven by volume, unit cost, or concentration)? |
| 10 | **Adverse Media** | Which funded recipients have serious adverse signals — sanctions, enforcement actions, filing lapses? |

Each challenge has its own page that surfaces the top findings from
pre-computed materialized views; an AI chat (`/ask`) lets users explore the
underlying data conversationally.

### Additional capabilities

- **Conversational Ask-the-Data** (`/ask`) — natural-language questions → GPT-4.1
  generates SQL → live database → findings rendered as cards + charts + follow-up
  suggestions. Streams tokens via SSE, remembers conversation context, and offers
  an **Investigate Mode** that pivots a suggested question into a deeper
  challenge-level analysis.
- **Self-healing AI retry** — when GPT's SQL fails, the server queries
  `information_schema.columns` for the referenced tables and feeds real schema
  back to the model (up to two retries) so hallucinated column names and type
  mistakes are caught and corrected automatically.
- **Bilingual EN / FR site-wide** — a single header toggle translates every page,
  AI response, chart label, and tooltip on the fly. French-mode Ask queries work
  end to end.
- **Access-code login screen** (`/access`) — users without a code see a clean,
  accessible entry form instead of a raw 401.
- **Entity profile pages** (`/entity/[name]`) — one URL per recipient that
  cross-references contracts, grants, T3010 filings, directors, transfers, and
  adverse media.
- **Daily briefing, shareable findings, and text-to-speech** — `/api/briefing`,
  `/api/share`, and `/api/tts` turn standout findings into narrated summaries and
  signed shareable links.

---

## Architecture

```
┌──────────────────┐     ┌────────────────────────────┐     ┌───────────────────┐
│  Web app         │     │  Azure PostgreSQL          │     │  Azure OpenAI     │
│  Next.js 16      │◀───▶│  (Flexible Server, GP)     │◀───▶│  GPT-4.1 + ada    │
│  Container Apps  │     │  3.75M rows · 38 MVs       │     │  embeddings       │
└──────────────────┘     └────────────────────────────┘     └───────────────────┘
        ▲                         ▲
        │ HTTPS + access cookie   │ pg over TLS
        │                         │
   end users                CKAN API ETL
                       (open.canada.ca DataStore)
```

### Stack

- **Web**: [Next.js 16](https://nextjs.org) (App Router, RSC, force-dynamic rendering on DB-backed pages), TypeScript, [Recharts](https://recharts.org)
- **Database**: PostgreSQL 16 + [pgvector](https://github.com/pgvector/pgvector)
- **AI**: Azure OpenAI (GPT-4.1 for natural-language → SQL and on-the-fly translation, `text-embedding-3-small` for fuzzy entity matching)
- **Bilingual**: `components/AutoTranslate.tsx` + `/api/translate` wrap server-rendered content; `lib/i18n.ts` + `lib/lang.ts` persist the user's language choice
- **Tests**: [Playwright](https://playwright.dev) audit suite
- **Hosting**: Azure Container Apps + Azure Container Registry
- **MCP server**: `src/index.ts` ships an stdio MCP server with 22 tools and 10 prompt templates for Claude Desktop

### Data sources (all CKAN datasets on open.canada.ca)

| Dataset | Rows |
|---|---|
| Federal contracts | 1,261,467 |
| Grants & contributions | 1,275,964 |
| T3010 charity returns (id, financial, directors, transfers, compensation, programs) | 1,217,911 |
| Acts of founded wrongdoing | 228 |
| Sanctions / regulatory actions / filing lapses (composite adverse-media table) | 3,584 |
| **Total** | **3,755,570** |

---

## Repository layout

```
app/                 Next.js routes (challenge pages, /ask, /access, /share, API routes)
components/          UI components (charts, navigation, SiteHeader, AutoTranslate,
                     LanguageToggle, banner)
lib/                 Database client, metrics, chart selection, i18n/lang helpers,
                     ask-stream SSE helper
scripts/             ETL, materialized-view definitions, embeddings, ingest,
                     backfill-french-descriptions
src/                 MCP server (Claude Desktop integration)
tests/audit/         Playwright tests that assert challenge findings
                     against the underlying tables
middleware.ts        Access-cookie gate
Dockerfile           Multi-stage build for Azure Container Apps
```

---

## Local development

### Prerequisites
- Node.js 20+
- A PostgreSQL 16 database (Azure Flexible Server or local) with **pgvector**
- An Azure OpenAI resource (GPT-4.1 + `text-embedding-3-small` deployments)

### Setup

```bash
git clone https://github.com/JCrossman/open-gov-data-portal-agency-hackathon-2026.git
cd open-gov-data-portal-agency-hackathon-2026
npm install
cp .env.example .env.local            # edit with your real credentials
```

### Load data and build materialized views

```bash
# Stream all CKAN datasets into Postgres (long: 1–2h on a fresh DB)
npx tsx scripts/ingest-api.ts

# Build the 38 materialized views
npx tsx scripts/optimize-db.ts

# Generate pgvector embeddings for entity matching
npx tsx scripts/generate-embeddings.ts
```

### Run the web app

```bash
npm run dev          # http://localhost:3000
```

The app is access-gated. Visit `http://localhost:3000/?code=YOUR_ACCESS_CODE`
once to set the cookie (where `YOUR_ACCESS_CODE` matches the `ACCESS_CODE` env
var you set in `.env.local`).

### Run the audit suite

```bash
npx playwright install
BASE_URL=http://localhost:3000 ACCESS_CODE=your_code npx playwright test tests/audit/
```

---

## Engineering principles

This is an accountability platform — every number must be traceable to its
source. A few rules baked into the codebase:

- **Materialized views are the single source of truth.** Page queries read from
  MVs that are explicitly defined in `scripts/optimize-db.ts`. Pages must not
  re-derive the same metric with different logic.
- **BN matching uses 9-digit prefix** (`substr(bn, 1, 9)`) to bridge name
  variations between the grants table and T3010 filings.
- **BN column names are inconsistent across tables** (this is a permanent schema
  gotcha): `grants.recipient_business_number` (long form) vs.
  `adverse_media_matches.bn`, `t3010_*.bn`, and all `mv_*` MVs (short form);
  `t3010_transfers` uses `donor_bn` / `donee_bn`; `contracts` has no BN column.
- **The misleadingly-named CRA T3010 columns** `gov_funding_provincial` (Line
  4130 = investment income) and `gov_funding_other` (Line 4140 = other revenue)
  are **not** government funding. Only Line 4120 (`gov_funding_federal`)
  reflects self-reported government revenue, and the `grants` table is the
  authoritative record of actual federal disbursements.
- **Public-sector entities** (universities, health authorities, government
  departments) are explicitly excluded from "ghost" and "zombie" findings via
  name-pattern filters in the MV definitions.
- **DB-backed pages render per request.** Pages that query the database use
  `export const dynamic = "force-dynamic"` — ISR is intentionally disabled on
  data-driven views to prevent build-time errors from being cached for an hour.

---

## Security

- Access to the deployed instance is gated by a per-deployment access code.
- All credentials are sourced from environment variables; no fallback secrets
  are committed.
- CodeQL, Dependabot, and secret scanning run on every PR.
- The `main` branch is protected — see `CONTRIBUTING.md` and `CODEOWNERS`.

Found a vulnerability? Please follow [`SECURITY.md`](SECURITY.md) — do **not**
open a public issue.

---

## License

[MIT](LICENSE) © 2026 Jeremy Crossman. Built with public open data; the data
itself is governed by the [Open Government Licence — Canada](https://open.canada.ca/en/open-government-licence-canada).
