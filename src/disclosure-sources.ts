export interface DisclosureSource {
  id: string;
  title: string;
  description: string;
  basePath: string;
  searchUrl: string;
  exportPath: string;
  recordPattern: string;
  recordCount: string | null;
  domain: "spending" | "travel" | "briefing" | "reporting" | "other";
  exampleQueries: string[];
}

export const DISCLOSURE_SOURCES: DisclosureSource[] = [
  {
    id: "contracts",
    title: "Contracts over $10,000",
    description: "Federal government contracts over $10,000, standing offers, and supply arrangements. Published quarterly.",
    basePath: "/contracts/",
    searchUrl: "https://search.open.canada.ca/contracts/",
    exportPath: "/contracts/export/",
    recordPattern: "/contracts/record/",
    recordCount: "1,131,113",
    domain: "spending",
    exampleQueries: ["IT contracts", "consulting", "translation services"],
  },
  {
    id: "grants",
    title: "Grants and Contributions",
    description: "Federal grants and contributions — transfers of money, goods, services, or assets to individuals and organizations.",
    basePath: "/grants/",
    searchUrl: "https://search.open.canada.ca/grants/",
    exportPath: "/grants/export/",
    recordPattern: "/grants/record/",
    recordCount: "1,149,686",
    domain: "spending",
    exampleQueries: ["climate research grants", "indigenous programs", "health funding"],
  },
  {
    id: "travel",
    title: "Travel Expenses",
    description: "Travel expense reports for senior government officials, including airfare, lodging, meals, and other costs.",
    basePath: "/travel/",
    searchUrl: "https://search.open.canada.ca/travel/",
    exportPath: "/travel/export/",
    recordPattern: "/travel/record/",
    recordCount: null,
    domain: "travel",
    exampleQueries: ["Global Affairs travel", "ministerial travel", "National Defence travel"],
  },
  {
    id: "travel_annual",
    title: "Annual Travel, Hospitality and Conference Spending",
    description: "Annual totals for departmental spending on travel, hospitality, and conferences.",
    basePath: "/travel_annual/",
    searchUrl: "https://search.open.canada.ca/travel_annual/",
    exportPath: "/travel_annual/export/",
    recordPattern: "/travel_annual/record/",
    recordCount: null,
    domain: "travel",
    exampleQueries: ["annual travel spending by department", "conference costs 2024"],
  },
  {
    id: "hospitality",
    title: "Hospitality Expenses",
    description: "Hospitality expense reports for government officials, covering events, meals, and receptions.",
    basePath: "/hospitality/",
    searchUrl: "https://search.open.canada.ca/hospitality/",
    exportPath: "/hospitality/export/",
    recordPattern: "/hospitality/record/",
    recordCount: null,
    domain: "travel",
    exampleQueries: ["Global Affairs hospitality", "reception costs"],
  },
  {
    id: "reclassification",
    title: "Government Position Reclassifications",
    description: "Reclassified government positions in the Public Service of Canada, published quarterly.",
    basePath: "/reclassification/",
    searchUrl: "https://search.open.canada.ca/reclassification/",
    exportPath: "/reclassification/export/",
    recordPattern: "/reclassification/record/",
    recordCount: "15,326",
    domain: "other",
    exampleQueries: ["AS to PM reclassifications", "executive reclassifications"],
  },
  {
    id: "briefing_titles",
    title: "Briefing Note Titles and Numbers",
    description: "Titles of briefing notes received by ministers and deputy heads.",
    basePath: "/briefing_titles/",
    searchUrl: "https://search.open.canada.ca/briefing_titles/",
    exportPath: "/briefing_titles/export/",
    recordPattern: "/briefing_titles/record/",
    recordCount: null,
    domain: "briefing",
    exampleQueries: ["climate briefings", "defence briefing notes", "immigration briefings"],
  },
  {
    id: "qpnotes",
    title: "Question Period Notes",
    description: "Question period notes prepared for ministers in the House of Commons.",
    basePath: "/qpnotes/",
    searchUrl: "https://search.open.canada.ca/qpnotes/",
    exportPath: "/qpnotes/export/",
    recordPattern: "/qpnotes/record/",
    recordCount: null,
    domain: "briefing",
    exampleQueries: ["health minister QP notes", "environment question period"],
  },
  {
    id: "wrongdoing",
    title: "Acts of Founded Wrongdoing",
    description: "Disclosures of founded wrongdoing under the Public Servants Disclosure Protection Act.",
    basePath: "/wrongdoing/",
    searchUrl: "https://search.open.canada.ca/wrongdoing/",
    exportPath: "/wrongdoing/export/",
    recordPattern: "/wrongdoing/record/",
    recordCount: "70",
    domain: "reporting",
    exampleQueries: ["founded wrongdoing cases"],
  },
  {
    id: "admin_aircraft",
    title: "Use of Administrative Aircraft",
    description: "Flight information for government administrative aircraft use by ministers and senior officials.",
    basePath: "/admin_aircraft/",
    searchUrl: "https://search.open.canada.ca/admin_aircraft/",
    exportPath: "/admin_aircraft/export/",
    recordPattern: "/admin_aircraft/record/",
    recordCount: "20",
    domain: "travel",
    exampleQueries: ["Prime Minister flights", "ministerial aircraft"],
  },
];

export function getDisclosureSource(id: string): DisclosureSource | null {
  return DISCLOSURE_SOURCES.find((source) => source.id === id) ?? null;
}

export function getDisclosureSourcesByDomain(domain: DisclosureSource["domain"]): DisclosureSource[] {
  return DISCLOSURE_SOURCES.filter((source) => source.domain === domain);
}

export function findDisclosureSourceByTopic(topic: string): DisclosureSource[] {
  const normalized = topic.toLowerCase();
  return DISCLOSURE_SOURCES.filter(
    (source) =>
      source.title.toLowerCase().includes(normalized)
      || source.description.toLowerCase().includes(normalized)
      || source.id.includes(normalized)
      || source.exampleQueries.some((query) => query.toLowerCase().includes(normalized)),
  );
}
