import { NextRequest, NextResponse } from "next/server";
import { normalizeLang, type Lang } from "@/lib/i18n";

export const dynamic = "force-dynamic";

type TurnPayload = {
  question: string;
  narrative: string;
  sql: string;
  rowCount: number;
  rows: Record<string, unknown>[];
  self_check?: string | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtRow(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const s = String(v);
  return escapeHtml(s.length > 200 ? s.slice(0, 197) + "…" : s);
}

function renderNarrativeHtml(narrative: string): string {
  // Render [^N] markers as superscripts (unlinked in print)
  return escapeHtml(narrative).replace(
    /\[\^(\d+)\]/g,
    '<sup style="color:#0b3d68;font-weight:700">$1</sup>',
  );
}

function memoHtml(lang: Lang, turns: TurnPayload[]): string {
  const now = new Date().toLocaleString(lang === "fr" ? "fr-CA" : "en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const title =
    lang === "fr"
      ? "Note d'information — Analyse des données ouvertes"
      : "Briefing Memo — Open Data Accountability";
  const subtitle =
    lang === "fr"
      ? "Canada — Données fédérales ouvertes"
      : "Canada — Federal Open Data";
  const toc = lang === "fr" ? "Table des matières" : "Contents";
  const preparedOn = lang === "fr" ? "Préparé le" : "Prepared";
  const summary = lang === "fr" ? "Synthèse" : "Executive Summary";
  const findings = lang === "fr" ? "Constatations" : "Findings";
  const methodology = lang === "fr" ? "Méthodologie" : "Methodology";
  const sources = lang === "fr" ? "Sources" : "Sources";
  const print =
    lang === "fr"
      ? "Utiliser la fonction Imprimer (Cmd/Ctrl + P) pour enregistrer en PDF."
      : "Use your browser's Print (Cmd/Ctrl + P) to save as PDF.";
  const rowsLabel = lang === "fr" ? "lignes retournées" : "rows returned";
  const selfLabel = lang === "fr" ? "Vérification :" : "Double-check:";

  const tocEntries = turns
    .map(
      (t, i) =>
        `<li><a href="#q${i + 1}">${i + 1}. ${escapeHtml(t.question)}</a></li>`,
    )
    .join("\n");

  const body = turns
    .map((t, i) => {
      const cols = t.rows.length > 0 ? Object.keys(t.rows[0]) : [];
      const preview = t.rows.slice(0, 20);
      const tableHtml =
        cols.length > 0
          ? `<table>
              <thead><tr><th></th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
              <tbody>
                ${preview
                  .map(
                    (r, ri) =>
                      `<tr><td class="rownum">${ri + 1}</td>${cols
                        .map((c) => `<td>${fmtRow(r[c])}</td>`)
                        .join("")}</tr>`,
                  )
                  .join("")}
              </tbody>
            </table>`
          : "";
      return `
        <section id="q${i + 1}">
          <h2>${i + 1}. ${escapeHtml(t.question)}</h2>
          <p class="narrative">${renderNarrativeHtml(t.narrative || "")}</p>
          ${
            t.self_check
              ? `<p class="selfcheck"><strong>${selfLabel}</strong> ${escapeHtml(t.self_check)}</p>`
              : ""
          }
          <div class="meta">${t.rowCount.toLocaleString()} ${rowsLabel}</div>
          ${tableHtml}
          ${t.sql ? `<details class="sql"><summary>${lang === "fr" ? "Requête SQL" : "SQL query"}</summary><pre>${escapeHtml(t.sql)}</pre></details>` : ""}
        </section>`;
    })
    .join("\n");

  void methodology;

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  @page { size: Letter; margin: 1in; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; max-width: 8.5in; margin: 0 auto; padding: 1rem 1.25rem; line-height: 1.55; }
  header.cover { border-bottom: 3px double #0b3d68; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  header.cover h1 { font-size: 1.9rem; margin: 0 0 0.3rem 0; color: #0b3d68; }
  header.cover .sub { color: #555; font-size: 0.9rem; }
  header.cover .date { color: #888; font-size: 0.8rem; margin-top: 0.5rem; font-family: 'Helvetica Neue', Arial, sans-serif; }
  h2 { font-size: 1.15rem; color: #0b3d68; border-bottom: 1px solid #ccc; padding-bottom: 0.25rem; margin-top: 2rem; }
  .narrative { font-size: 1.05rem; }
  .selfcheck { background: #fff8dc; border-left: 4px solid #e0b000; padding: 0.5rem 0.75rem; font-size: 0.9rem; }
  .meta { color: #666; font-size: 0.8rem; margin-bottom: 0.5rem; font-family: 'Helvetica Neue', Arial, sans-serif; }
  table { width: 100%; border-collapse: collapse; font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 0.75rem; margin-bottom: 0.75rem; }
  th, td { padding: 0.3rem 0.5rem; text-align: left; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { background: #f0f2f5; font-weight: 700; border-bottom: 2px solid #0b3d68; }
  td.rownum { color: #888; font-weight: 700; width: 1.5rem; }
  .sql summary { color: #555; font-size: 0.8rem; cursor: pointer; }
  .sql pre { background: #0b3d68; color: #e0e0e0; padding: 0.6rem; border-radius: 3px; font-size: 0.7rem; white-space: pre-wrap; }
  .toc { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f7f7f7; padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; }
  .toc h3 { margin: 0 0 0.4rem 0; font-size: 0.85rem; text-transform: uppercase; color: #555; letter-spacing: 0.04em; }
  .toc ol { margin: 0; padding-left: 1.2rem; font-size: 0.85rem; }
  .toc a { color: #0b3d68; text-decoration: none; }
  .print-note { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 0.75rem; color: #888; text-align: center; padding: 1rem; }
  @media print { .print-note { display: none; } .sql { display: none; } }
  sup { font-size: 0.7em; vertical-align: super; }
</style>
</head>
<body>
  <header class="cover">
    <h1>${escapeHtml(title)}</h1>
    <div class="sub">${escapeHtml(subtitle)}</div>
    <div class="date">${escapeHtml(preparedOn)} ${now}</div>
  </header>

  <div class="toc">
    <h3>${escapeHtml(toc)}</h3>
    <ol>${tocEntries}</ol>
  </div>

  <h2>${escapeHtml(summary)}</h2>
  <p>${
    lang === "fr"
      ? "Cette note résume une conversation d'analyse contre 3,75 M de dossiers fédéraux (contrats, subventions, organismes de bienfaisance). Chaque constatation est appuyée par des requêtes SQL reproductibles contre open.canada.ca."
      : "This memo summarizes an analytical conversation against 3.75M federal records (contracts, grants, charities). Every finding is backed by reproducible SQL queries against open.canada.ca."
  }</p>

  <h2>${escapeHtml(findings)}</h2>
  ${body}

  <h2>${escapeHtml(sources)}</h2>
  <p>${
    lang === "fr"
      ? "Portail des données ouvertes du gouvernement du Canada — open.canada.ca"
      : "Government of Canada Open Data Portal — open.canada.ca"
  }</p>

  <div class="print-note">${escapeHtml(print)}</div>
  <script>setTimeout(() => { try { window.print(); } catch(e){} }, 250);</script>
</body>
</html>`;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      turns?: unknown;
      lang?: string;
    };
    const lang = normalizeLang(body.lang);
    if (!Array.isArray(body.turns) || body.turns.length === 0) {
      return NextResponse.json({ error: "turns required" }, { status: 400 });
    }
    const turns: TurnPayload[] = body.turns.slice(0, 20).map((raw) => {
      const t = raw as Record<string, unknown>;
      return {
        question: typeof t.question === "string" ? t.question : "",
        narrative: typeof t.narrative === "string" ? t.narrative : "",
        sql: typeof t.sql === "string" ? t.sql : "",
        rowCount: typeof t.rowCount === "number" ? t.rowCount : 0,
        rows: Array.isArray(t.rows)
          ? (t.rows as Record<string, unknown>[]).slice(0, 50)
          : [],
        self_check:
          typeof t.self_check === "string" ? t.self_check : null,
      };
    });
    const html = memoHtml(lang, turns);
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message?.slice(0, 200) ?? "Unknown error" },
      { status: 500 },
    );
  }
}
