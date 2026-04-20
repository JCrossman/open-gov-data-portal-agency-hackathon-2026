// Registry of named, measurable federal policy commitments with public sources.
// Each commitment is matched against the grants table via keyword rules to
// compute allocated vs committed dollars over the stated target window.
//
// Caveats displayed in the UI:
//   - Dollar totals from grants only. Federal-provincial transfers, tax
//     expenditures, and statutory spending are not loaded and therefore not
//     counted. For commitments delivered primarily through transfers (e.g.
//     CWELCC), allocated-via-grants will understate fulfillment.
//   - Keyword matching can include/exclude programs at the margin; methodology
//     note for each commitment documents what is captured.

export interface PolicyCommitment {
  id: string;
  name: string;
  targetAmountCad: number;          // committed dollars in CAD
  targetStart: string;              // ISO date (inclusive)
  targetEnd: string;                // ISO date (exclusive)
  source: string;                   // plain-text citation
  sourceUrl?: string;
  keywordSql: string;               // SQL WHERE clause (without leading AND)
  notes: string;                    // methodology / caveats
  deliveryNote?: string;            // flag if primary delivery is NOT via grants
}

export const POLICY_COMMITMENTS: PolicyCommitment[] = [
  {
    id: "nhs-2017",
    name: "National Housing Strategy (NHS)",
    targetAmountCad: 82_000_000_000,
    targetStart: "2017-04-01",
    targetEnd: "2028-04-01",
    source: "Canada’s National Housing Strategy — 10-year, $82B+ envelope (CMHC, placecanada.ca)",
    sourceUrl: "https://www.placetocallhome.ca/",
    keywordSql: `prog_name_en ILIKE '%housing%' OR prog_name_en ILIKE '%National Housing Strategy%'
      OR prog_name_en ILIKE '%affordable housing%' OR prog_name_en ILIKE '%CMHC%'
      OR prog_name_en ILIKE '%rapid housing%' OR prog_name_en ILIKE '%homeless%'
      OR prog_name_en ILIKE '%Reaching Home%'`,
    notes: "Matches grant programs whose name or keywords reference housing, affordable housing, CMHC programs, Reaching Home, or homelessness. NHS is delivered through a mix of grants, loans, and federal-provincial agreements; only the grant portion is captured here.",
    deliveryNote: "Grants are only one delivery channel. CMHC loans and bilateral housing agreements fall outside the grants dataset."
  },
  {
    id: "cwelcc-2021",
    name: "Canada-Wide Early Learning & Child Care (CWELCC)",
    targetAmountCad: 30_000_000_000,
    targetStart: "2021-04-01",
    targetEnd: "2026-04-01",
    source: "Budget 2021 — $30B over 5 years for Canada-Wide Early Learning and Child Care",
    sourceUrl: "https://www.canada.ca/en/early-learning-child-care-agreement.html",
    keywordSql: `prog_name_en ILIKE '%child care%' OR prog_name_en ILIKE '%childcare%'
      OR prog_name_en ILIKE '%early learning%' OR prog_name_en ILIKE '%garderie%'
      OR prog_name_en ILIKE '%apprentissage et garde des jeunes enfants%'`,
    notes: "CWELCC is delivered primarily through bilateral federal-provincial-territorial agreements, not project grants. Expect grants-only allocation to be a small fraction of the committed envelope — the gap is a delivery-channel artifact, not an under-allocation.",
    deliveryNote: "Delivered overwhelmingly via federal-provincial transfer agreements (not loaded in this portal). Grants below understate actual fulfillment."
  },
  {
    id: "erp-2030",
    name: "Emissions Reduction Plan 2030 & Climate Measures (Budget 2022)",
    targetAmountCad: 9_100_000_000,
    targetStart: "2022-04-01",
    targetEnd: "2030-04-01",
    source: "2030 Emissions Reduction Plan (ECCC, March 2022) + Budget 2022 climate line items (~$9.1B new)",
    sourceUrl: "https://www.canada.ca/en/services/environment/weather/climatechange/climate-plan/climate-plan-overview/emissions-reduction-2030.html",
    keywordSql: `prog_name_en ILIKE '%emission%' OR prog_name_en ILIKE '%climate%'
      OR prog_name_en ILIKE '%low carbon%' OR prog_name_en ILIKE '%low-carbon%'
      OR prog_name_en ILIKE '%net zero%' OR prog_name_en ILIKE '%net-zero%'
      OR prog_name_en ILIKE '%zero emission%' OR prog_name_en ILIKE '%clean growth%'
      OR prog_name_en ILIKE '%greenhouse gas%' OR prog_name_en ILIKE '%ghg %'
      OR prog_name_en ILIKE '%electrification%' OR prog_name_en ILIKE '%carbon%'
      OR prog_name_en ILIKE '%climat%' OR prog_name_en ILIKE '%décarbonisation%'`,
    notes: "Captures federal grant programs named for emissions, climate, low-carbon, net-zero, clean growth, electrification, GHG, or décarbonisation. Excludes tax credits (e.g. clean-tech ITC) and most of the Canada Growth Fund’s concessional capital, which are not grant vehicles."
  },
  {
    id: "indigenous-2021-26",
    name: "Indigenous Priorities & Reconciliation (Budget 2021 5-year window)",
    targetAmountCad: 18_000_000_000,
    targetStart: "2021-04-01",
    targetEnd: "2026-04-01",
    source: "Budget 2021 committed $18B over 5 years for Indigenous communities (health, housing, infrastructure, child welfare, language)",
    sourceUrl: "https://www.budget.canada.ca/2021/report-rapport/toc-tdm-en.html",
    keywordSql: `prog_name_en ILIKE '%indigenous%' OR prog_name_en ILIKE '%first nation%'
      OR prog_name_en ILIKE '%inuit%' OR prog_name_en ILIKE '%metis%'
      OR prog_name_en ILIKE '%métis%' OR prog_name_en ILIKE '%aboriginal%'
      OR prog_name_en ILIKE '%autochtone%' OR prog_name_en ILIKE '%reconciliation%'`,
    notes: "Captures any federal grant whose program name references Indigenous, First Nations, Inuit, Métis, aboriginal, autochtone, or reconciliation. Includes ongoing Indigenous Services Canada grant streams, which may cause allocated-via-grants to exceed the incremental $18B commitment — a positive signal, unlike the CWELCC gap."
  },
  {
    id: "dental-2023-28",
    name: "Canadian Dental Care Plan (CDCP)",
    targetAmountCad: 13_000_000_000,
    targetStart: "2023-04-01",
    targetEnd: "2028-04-01",
    source: "Budget 2023 — $13B over 5 years for the Canadian Dental Care Plan",
    sourceUrl: "https://www.budget.canada.ca/2023/report-rapport/chap2-en.html",
    keywordSql: `prog_name_en ILIKE '%dental%' OR prog_name_en ILIKE '%dentaire%'
      OR description_en ILIKE '%Canadian Dental Care Plan%' OR description_en ILIKE '%Plan canadien de soins dentaires%'`,
    notes: "CDCP is delivered primarily through direct-billing to Sun Life (operational contract) and reimbursements to providers, not grants. Expect near-zero grant allocation — this is a delivery-channel gap, not an under-allocation.",
    deliveryNote: "Delivered via direct insurance administration (Sun Life contract + provider reimbursement), outside the grants dataset."
  },
  {
    id: "mental-health-2021",
    name: "Mental Health & Substance Use (Budget 2021)",
    targetAmountCad: 5_000_000_000,
    targetStart: "2021-04-01",
    targetEnd: "2031-04-01",
    source: "Budget 2021 — $5B over 10 years Canada Mental Health Transfer + Wellness Together Canada",
    sourceUrl: "https://www.budget.canada.ca/2021/report-rapport/p3-en.html",
    keywordSql: `prog_name_en ILIKE '%mental health%' OR prog_name_en ILIKE '%santé mentale%'
      OR prog_name_en ILIKE '%suicide%' OR prog_name_en ILIKE '%addiction%'
      OR prog_name_en ILIKE '%opioid%' OR prog_name_en ILIKE '%overdose%'
      OR prog_name_en ILIKE '%substance use%'`,
    notes: "Captures grants naming mental health, suicide prevention, addiction/opioid/substance-use, and their French equivalents. The Canada Mental Health Transfer itself flows as a federal-provincial transfer and is not captured in grants."
  },
];
