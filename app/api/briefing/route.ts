import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { normalizeLang, type Lang } from "@/lib/i18n";

// Cache for 6 hours — the "overnight analysis" feel without a cron job.
export const revalidate = 21600;
export const dynamic = "force-dynamic";

type Finding = {
  id: string;
  emoji: string;
  headline: string;
  detail: string;
  cta: string;
  seed_question: string;
};

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

async function zombieFinding(lang: Lang): Promise<Finding | null> {
  const rows = (await query(
    `SELECT legal_name, bn, gov_funding, last_grant_date, last_list_year
       FROM mv_zombie_recipients
      WHERE cohort = 'ceased'
        AND gov_funding IS NOT NULL
        AND legal_name IS NOT NULL
      ORDER BY gov_funding DESC NULLS LAST
      LIMIT 1`,
  )) as {
    legal_name: string;
    bn: string;
    gov_funding: string | number;
    last_grant_date: string | null;
    last_list_year: number | null;
  }[];
  if (!rows.length) return null;
  const r = rows[0];
  const amt = Number(r.gov_funding);
  const name = r.legal_name;
  const year = r.last_list_year ?? "—";
  if (lang === "fr") {
    return {
      id: "zombie",
      emoji: "🧟",
      headline: `${name} a reçu ${fmtMoney(amt)} en financement public, puis a cessé ses activités.`,
      detail: `Dernier dépôt T3010 : ${year}. Aucune activité déclarée depuis.`,
      cta: "Enquêter →",
      seed_question: `Pourquoi ${name} a-t-il reçu ${fmtMoney(amt)} alors qu'il a cessé de produire ses déclarations ?`,
    };
  }
  return {
    id: "zombie",
    emoji: "🧟",
    headline: `${name} received ${fmtMoney(amt)} in public funding, then stopped operating.`,
    detail: `Last T3010 filing: ${year}. No reported activity since.`,
    cta: "Investigate →",
    seed_question: `Why did ${name} receive ${fmtMoney(amt)} in federal funding after it stopped filing?`,
  };
}

async function amendmentFinding(lang: Lang): Promise<Finding | null> {
  const rows = (await query(
    `SELECT vendor_name, owner_org_title, original_value, effective_value, amendment_ratio, amendment_count
       FROM mv_amendment_creep
      WHERE amendment_ratio IS NOT NULL
        AND original_value >= 100000
        AND amendment_count >= 5
      ORDER BY amendment_ratio DESC NULLS LAST
      LIMIT 1`,
  )) as {
    vendor_name: string;
    owner_org_title: string;
    original_value: string | number;
    effective_value: string | number;
    amendment_ratio: string | number;
    amendment_count: number;
  }[];
  if (!rows.length) return null;
  const r = rows[0];
  const ratio = Number(r.amendment_ratio);
  const orig = Number(r.original_value);
  const eff = Number(r.effective_value);
  const dept = r.owner_org_title ? r.owner_org_title.split("|")[0].trim() : "";
  if (lang === "fr") {
    return {
      id: "amendment",
      emoji: "📄",
      headline: `Un contrat de ${r.vendor_name} est passé de ${fmtMoney(orig)} à ${fmtMoney(eff)} par avenants (${(ratio * 100).toFixed(0)} %).`,
      detail: `${r.amendment_count} avenants. Ministère : ${dept}.`,
      cta: "Enquêter →",
      seed_question: `Montre les contrats ${r.vendor_name} dont le ratio d'avenants dépasse 200 %`,
    };
  }
  return {
    id: "amendment",
    emoji: "📄",
    headline: `A ${r.vendor_name} contract grew from ${fmtMoney(orig)} to ${fmtMoney(eff)} through amendments (${(ratio * 100).toFixed(0)}%).`,
    detail: `${r.amendment_count} amendments. Department: ${dept}.`,
    cta: "Investigate →",
    seed_question: `Show ${r.vendor_name} contracts with amendment ratios above 200%`,
  };
}

async function policyFinding(lang: Lang): Promise<Finding | null> {
  const rows = (await query(
    `SELECT name, department, annual_target, annual_actual, gap_pct
       FROM mv_policy_alignment
      WHERE annual_target IS NOT NULL
        AND gap_pct IS NOT NULL
      ORDER BY gap_pct DESC NULLS LAST
      LIMIT 1`,
  )) as {
    name: string;
    department: string;
    annual_target: string | number;
    annual_actual: string | number;
    gap_pct: string | number;
  }[];
  if (!rows.length) return null;
  const r = rows[0];
  const gap = Number(r.gap_pct);
  const target = Number(r.annual_target);
  const actual = Number(r.annual_actual);
  if (lang === "fr") {
    return {
      id: "policy",
      emoji: "🎯",
      headline: `${r.name} : dépenses réelles à ${(100 - gap).toFixed(0)} % de la cible annoncée.`,
      detail: `Cible : ${fmtMoney(target)}/an. Réel : ${fmtMoney(actual)}/an. Écart : ${gap.toFixed(0)} %.`,
      cta: "Enquêter →",
      seed_question: `Comment les dépenses de ${r.name} se comparent-elles à l'engagement fédéral ?`,
    };
  }
  return {
    id: "policy",
    emoji: "🎯",
    headline: `${r.name}: actual spending is only ${(100 - gap).toFixed(0)}% of the announced target.`,
    detail: `Target: ${fmtMoney(target)}/yr. Actual: ${fmtMoney(actual)}/yr. Gap: ${gap.toFixed(0)}%.`,
    cta: "Investigate →",
    seed_question: `How does ${r.name} spending compare to the federal commitment?`,
  };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const lang = normalizeLang(
    url.searchParams.get("lang") ??
      request.cookies.get("lang")?.value ??
      request.headers.get("accept-language"),
  );

  try {
    const findings = (
      await Promise.all([
        zombieFinding(lang),
        amendmentFinding(lang),
        policyFinding(lang),
      ])
    ).filter((f): f is Finding => f !== null);
    return NextResponse.json(
      { lang, findings, generated_at: new Date().toISOString() },
      {
        headers: {
          "Cache-Control":
            "public, s-maxage=21600, stale-while-revalidate=3600",
        },
      },
    );
  } catch (e) {
    console.error("[/api/briefing]", e);
    return NextResponse.json(
      { error: (e as Error).message?.slice(0, 200) ?? "Unknown error", findings: [] },
      { status: 500 },
    );
  }
}
