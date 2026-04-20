export type AuditUrl = {
  path: string;
  heading: string;
  requiresMethodology: boolean;
  requiresSortableTable: boolean;
  skipAxe?: boolean;
};

export const challengeUrls: AuditUrl[] = [
  { path: "/challenges/zombie-recipients",     heading: "Zombie",                 requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/ghost-capacity",        heading: "Ghost Capacity",         requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/funding-loops",         heading: "Funding Loops",          requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/amendment-creep",       heading: "Sole Source",            requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/vendor-concentration",  heading: "Vendor Concentration",   requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/related-parties",       heading: "Related Parties",        requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/policy-misalignment",   heading: "Policy",                 requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/duplicative-funding",   heading: "Duplicative",            requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/contract-intelligence", heading: "Contract Intelligence",  requiresMethodology: true, requiresSortableTable: true },
  { path: "/challenges/adverse-media",         heading: "Adverse Media",          requiresMethodology: true, requiresSortableTable: true },
];

export const otherUrls: AuditUrl[] = [
  { path: "/",                            heading: "Open",            requiresMethodology: false, requiresSortableTable: false },
  { path: "/challenges",                  heading: "Challenges",      requiresMethodology: false, requiresSortableTable: false },
  { path: "/ask",                         heading: "Ask",             requiresMethodology: false, requiresSortableTable: false },
  { path: "/explore/contracts",           heading: "Contracts",       requiresMethodology: false, requiresSortableTable: false },
  { path: "/explore/grants",              heading: "Grants",          requiresMethodology: false, requiresSortableTable: false },
  { path: "/entity/search",               heading: "Entity",          requiresMethodology: false, requiresSortableTable: false },
  { path: "/entity/S.U.C.C.E.S.S.",       heading: "S.U.C.C.E.S.S.",  requiresMethodology: false, requiresSortableTable: false },
  { path: "/network",                     heading: "Network",         requiresMethodology: false, requiresSortableTable: false },
];

export const allUrls: AuditUrl[] = [...challengeUrls, ...otherUrls];
