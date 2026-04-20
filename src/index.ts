#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeDatasetResource, prepareDatasetChart } from "./analysis.js";
import {
  AGGREGATION_OPTIONS,
  CHART_TYPES,
  DEFAULT_ANALYSIS_MAX_BYTES,
  DEFAULT_ANALYSIS_MAX_ROWS,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  DEFAULT_MAP_FEATURE_LIMIT,
  DEFAULT_MAP_MAX_BYTES,
  DEFAULT_PAGE,
  DEFAULT_PREVIEW_MAX_BYTES,
  DEFAULT_SORT,
  GRANTS_RESOURCE_ID,
  type SearchFilters,
  SORT_OPTIONS,
} from "./constants.js";
import { getDataset, resolveResource } from "./catalog.js";
import { lookupCharity, formatCharityProfileText } from "./charity-lookup.js";
import { searchCharityTransfers, detectFundingLoops, formatTransferSearchText, formatLoopDetectionText } from "./charity-transfers.js";
import { formatContractsSearchText, parseContracts, sortContractsByAmendmentRatio, sortContractsByValue } from "./contracts-presentation.js";
import { crossReferenceEntity, findCharityBN, formatCharityBNSearchText, formatEntityDossierText } from "./cross-reference.js";
import { datastoreSearch, formatDatastoreSearchText } from "./datastore.js";
import { searchCharityDirectors, formatDirectorSearchText } from "./director-search.js";
import { discoverTopic } from "./discovery.js";
import { screenEntity, formatScreeningText } from "./entity-screening.js";
import { parseGrants, sortGrantsByValue, formatGrantsSearchText } from "./grants-presentation.js";
import { prepareGeoJsonMap } from "./mapping.js";
import {
  formatAnalysisText,
  formatChartText,
  formatDatasetText,
  formatDiscoveryText,
  formatFilterOptionsText,
  formatInvalidFilterGroupText,
  formatMapText,
  formatResourcePreviewText,
  formatResourcesText,
  formatSearchResultsText,
} from "./presentation.js";
import { getPortalFilters, searchPortalDatasets } from "./portal.js";
import { fetchResourcePreview } from "./resource-fetch.js";
import { resolveFilterGroupInput, resolveSearchFilters, type FriendlySearchInputs } from "./user-inputs.js";

const sortSchema = z.enum(SORT_OPTIONS);
const chartTypeSchema = z.enum(CHART_TYPES);
const aggregationSchema = z.enum(AGGREGATION_OPTIONS);
const stringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);

const filterSchema = z
  .object({
    owner_org: z.array(z.string()).optional(),
    dataset_type: z.array(z.string()).optional(),
    collection: z.array(z.string()).optional(),
    jurisdiction: z.array(z.string()).optional(),
    keywords_en: z.array(z.string()).optional(),
    subject_en: z.array(z.string()).optional(),
    resource_format: z.array(z.string()).optional(),
    frequency: z.array(z.string()).optional(),
    resource_type: z.array(z.string()).optional(),
    datastore_enabled: z.array(z.enum(["True", "False"])).optional(),
  })
  .optional();

const filterBrowserInputSchema = {
  query: z.string().optional().describe("Optional portal search text to apply before reading filter counts."),
  sort: sortSchema.optional().describe("Optional portal sort value."),
  filters: filterSchema.describe(
    "Advanced raw portal filter selections keyed by the portal parameter names. Most users can ignore this and use filterGroup for browsing.",
  ),
  filterGroup: z
    .string()
    .optional()
    .describe('Optional group to inspect in detail, such as "Organization", "Format", "Subject", or "API enabled".'),
  valueSearch: z
    .string()
    .optional()
    .describe("Optional text used to narrow the values within a single filter group."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of values to show when browsing a single filter group. Defaults to 20."),
};

const searchInputSchema = {
  query: z.string().optional().describe("Free-text search text, matching the portal's search box."),
  page: z.number().int().min(1).optional().describe("Portal results page number. Defaults to 1."),
  sort: sortSchema.optional().describe("Portal sort value."),
  organization: stringOrStringArraySchema
    .optional()
    .describe('Friendly organization names or slugs, such as "Natural Resources Canada" or "nrcan-rncan".'),
  portalType: stringOrStringArraySchema.optional().describe('Friendly portal type names such as "Open Data" or "Open Information".'),
  collectionType: stringOrStringArraySchema.optional().describe('Friendly collection names such as "API", "Open Maps", or "Publications".'),
  jurisdictionName: stringOrStringArraySchema.optional().describe('Friendly jurisdiction names such as "Federal" or "Provincial / Territorial".'),
  keyword: stringOrStringArraySchema.optional().describe('Friendly keyword values such as "climate" or "Government information".'),
  subject: stringOrStringArraySchema.optional().describe('Friendly subject names such as "Nature and Environment" or "Health and Safety".'),
  format: stringOrStringArraySchema.optional().describe('Friendly format values such as "CSV", "JSON", "GeoJSON", or "XLSX".'),
  updateFrequency: stringOrStringArraySchema.optional().describe('Friendly update frequency values such as "As Needed" or "Annually".'),
  resourceTypeName: stringOrStringArraySchema.optional().describe('Friendly resource type values such as "API", "Dataset", or "Web Service".'),
  apiEnabled: stringOrStringArraySchema.optional().describe('Friendly API-enabled values such as "Yes", "No", "True", or "False".'),
  filters: filterSchema.describe(
    "Advanced raw portal filters keyed by the portal parameter names. Most users should prefer the friendly fields like organization, format, subject, keyword, or apiEnabled.",
  ),
};

const analysisInputSchema = {
  datasetIdOrNameOrUrl: z
    .string()
    .optional()
    .describe("Dataset UUID, package name, or open.canada.ca dataset URL. If resourceIdOrName is omitted, the tool will choose the most analysis-friendly resource."),
  resourceIdOrName: z
    .string()
    .optional()
    .describe("Optional resource ID or exact resource name within the dataset."),
  resourceUrl: z
    .string()
    .url()
    .optional()
    .describe("Direct CSV, JSON, or GeoJSON resource URL. Use this when you already know the exact resource."),
  maxBytes: z
    .number()
    .int()
    .min(4_096)
    .max(2_000_000)
    .optional()
    .describe("Maximum number of bytes to fetch for analysis. Larger values help with JSON resources."),
  maxRows: z
    .number()
    .int()
    .min(10)
    .max(5_000)
    .optional()
    .describe("Maximum number of rows to analyze from the fetched content."),
};

const visualizationInputSchema = {
  ...analysisInputSchema,
  chartGoal: z
    .string()
    .optional()
    .describe('Optional natural-language goal such as "show the trend over time", "compare provinces", or "top categories".'),
  chartType: chartTypeSchema
    .optional()
    .describe('Optional chart type. Use "auto" to let the tool choose between line, bar, and scatter.'),
  xField: z
    .string()
    .optional()
    .describe("Optional field to place on the x-axis."),
  yField: z
    .string()
    .optional()
    .describe("Optional numeric field to place on the y-axis."),
  groupField: z
    .string()
    .optional()
    .describe("Optional grouping field for multi-series charts."),
  aggregation: aggregationSchema
    .optional()
    .describe('Optional aggregation for grouped values. Use "auto" to let the tool choose.'),
  topN: z
    .number()
    .int()
    .min(3)
    .max(50)
    .optional()
    .describe("For bar charts, limit the output to the top N values."),
};

const mapInputSchema = {
  datasetIdOrNameOrUrl: z
    .string()
    .optional()
    .describe("Dataset UUID, package name, or open.canada.ca dataset URL. If resourceIdOrName is omitted, the tool will try the most map-friendly GeoJSON resource."),
  resourceIdOrName: z
    .string()
    .optional()
    .describe("Optional resource ID or exact resource name within the dataset."),
  resourceUrl: z
    .string()
    .url()
    .optional()
    .describe("Direct GeoJSON resource URL."),
  labelField: z
    .string()
    .optional()
    .describe("Optional property field to use as the main label in the map preview."),
  valueField: z
    .string()
    .optional()
    .describe("Optional numeric property field to use for choropleth or styled-map values."),
  maxBytes: z
    .number()
    .int()
    .min(16_384)
    .max(50_000_000)
    .optional()
    .describe("Maximum number of bytes to fetch for the GeoJSON document."),
  maxRows: z
    .number()
    .int()
    .min(10)
    .max(5_000)
    .optional()
    .describe("Maximum number of feature-property rows to analyze when inferring fields."),
  maxFeatures: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of GeoJSON features to include in the returned map payload."),
};

type FilterBrowserArgs = {
  query?: string | undefined;
  sort?: (typeof SORT_OPTIONS)[number] | undefined;
  filters?: SearchFilters | undefined;
  filterGroup?: string | undefined;
  valueSearch?: string | undefined;
  limit?: number | undefined;
};

type SearchToolArgs = {
  query?: string | undefined;
  page?: number | undefined;
  sort?: (typeof SORT_OPTIONS)[number] | undefined;
  filters?: SearchFilters | undefined;
} & FriendlySearchInputs;

type AnalysisToolArgs = {
  datasetIdOrNameOrUrl?: string | undefined;
  resourceIdOrName?: string | undefined;
  resourceUrl?: string | undefined;
  maxBytes?: number | undefined;
  maxRows?: number | undefined;
};

type VisualizationToolArgs = AnalysisToolArgs & {
  chartGoal?: string | undefined;
  chartType?: (typeof CHART_TYPES)[number] | undefined;
  xField?: string | undefined;
  yField?: string | undefined;
  groupField?: string | undefined;
  aggregation?: (typeof AGGREGATION_OPTIONS)[number] | undefined;
  topN?: number | undefined;
};

type MapToolArgs = AnalysisToolArgs & {
  labelField?: string | undefined;
  valueField?: string | undefined;
  maxFeatures?: number | undefined;
};

const server = new McpServer({
  name: "open-gov-data-portal",
  version: "1.5.0",
  description: "Government of Canada Open Government Data Portal. Provides direct access to 1.26M federal contracts, 1.275M grants, T3010 charity data (financials, directors, transfers), and the full open data catalog. Use the MCP tools to search, analyze, chart, and cross-reference government spending data.",
});

// Hackathon challenge prompts — these appear as selectable templates in Claude Desktop
server.prompt(
  "zombie-recipients",
  "Challenge 1: Find companies and nonprofits that received large public funding and then ceased operations",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, investigate which entities received large amounts of federal funding and then ceased operations. Follow these steps:\n\n1. Use search_grants with recipientType 'N' (not-for-profit) to find the largest nonprofit grant recipients (sort by value, limit 20)\n2. For the top recipients, use find_charity_bn to look up their CRA business numbers\n3. For each BN found, use lookup_charity to check their T3010 financial health. The returned metrics follow canonical definitions: 'governmentFunding' is Line 4120 self-reported government revenue ONLY (never sum 4130 investment income or 4140 other revenue), and 'verifiedGrantsAnnual' is federal disbursements from the grants table cross-referenced by 9-digit BN prefix and annualized as SUM / distinct years.\n4. Flag entities where verifiedGrantsPct (or failing that, governmentFundingPct / Line 4120) exceeds 70-80% of total revenue\n5. Use cross_reference_entity for the most suspicious cases to see their full government funding picture\n6. Summarize your findings: which entities appear to be zombie recipients?",
      },
    }],
  }),
);

server.prompt(
  "ghost-capacity",
  "Challenge 2: Find funded organizations with no evidence of delivery capacity",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, find organizations that receive government funding but show no evidence of being able to deliver what they were funded to do. Follow these steps:\n\n1. Use search_grants to find grant recipients\n2. Use lookup_charity for each recipient BN to examine their T3010 financials and compensation. The canonical metrics returned are: 'governmentFundingPct' (Line 4120 self-reported gov revenue / total revenue, capped at 100 — never includes 4130 or 4140), 'verifiedGrantsPct' (annualized federal grants / total revenue via 9-digit BN prefix match, capped at 100), and 'compensationPct' (compensation / total revenue — revenue denominator, matches mv_ghost_capacity).\n3. Flag charities where verifiedGrantsPct (or governmentFundingPct) exceeds 80%, compensationPct exceeds 60-70%, and employee counts are very low\n4. These are ghost-capacity entities — they persist but never deliver. Summarize what you find.",
      },
    }],
  }),
);

server.prompt(
  "funding-loops",
  "Challenge 3: Detect circular funding patterns between charities",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, investigate whether money flows in circles between Canadian charities. IMPORTANT SCOPE CAVEAT: the current data model reliably surfaces only 2-node RECIPROCAL PAIRS (A→B and B→A). The full Challenge 3 prompt also covers triangular cycles (A→B→C→A) and longer circular chains, as well as classifying loops as STRUCTURALLY NORMAL (federated/denominational charities, donation platforms, parent-subsidiary transfers) vs POTENTIALLY SUSPICIOUS (loops that appear to inflate revenue, generate tax receipts, or absorb funds into overhead). The detect_funding_loops tool follows largest-transfer chains heuristically and is not an exhaustive cycle detector. Follow these steps:\n\n1. Use search_charity_transfers to find large charity-to-charity transfers; note the reciprocal-pair flags it surfaces\n2. For flagged pairs, use detect_funding_loops to probe longer chains from one endpoint, but treat absence of a loop as 'not found by this heuristic' — NOT proof that no cycle exists\n3. Use lookup_charity on both sides to understand the organizational relationship\n4. Before summarizing, explicitly classify each flagged loop as structurally normal vs potentially suspicious, and state that triangular and longer cycles are OUT OF SCOPE for this data model\n5. Frame conclusions as 'reciprocal-pair signals' rather than a complete answer to Challenge 3.",
      },
    }],
  }),
);

server.prompt(
  "sole-source-amendment-creep",
  "Challenge 4: Find contracts that started small and grew large through sole-source amendments",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, investigate contracts where amended value dwarfs the original bid. IMPORTANT SCOPE CAVEAT: a high amendment_ratio is a SIGNAL, not proof of sole-source abuse. The current data model does NOT reconstruct contract continuity across quarterly snapshots, does NOT detect competitive→sole-source transitions for the same work, does NOT detect threshold-splitting (multiple contracts just under competitive thresholds), and does NOT track same-vendor follow-on sole-source awards after an initial competitive win. A single row's procurement method reflects only that quarter's snapshot. Follow these steps:\n\n1. Use search_contracts with solicitationProcedure 'TN' (sole-source) and sortBy 'amendment_ratio' to surface the largest amendment growth\n2. Also search with sortBy 'value' to find the largest sole-source contracts\n3. For the worst cases, use cross_reference_entity to see the vendor's broader contracting footprint\n4. When summarizing, label findings as 'amendment-creep signals on individual contract records' — NOT a complete competitive→sole-source or threshold-splitting analysis — and explicitly note the unmodeled patterns above.",
      },
    }],
  }),
);

server.prompt(
  "vendor-concentration",
  "Challenge 5: Measure vendor concentration in government spending categories",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, measure vendor concentration in government spending. IMPORTANT SCOPE CAVEAT: the current data model is largely SEGMENT-AGNOSTIC — there is no pre-computed HHI / CR4 / CR10 broken down by commodity category, department, or region, and any concentration figure derived here is a TOP-N APPROXIMATION (typically top-50-by-value) rather than a full-market concentration index. Vendor name normalization is also imperfect, so both false merges and false splits can distort market share. Follow these steps:\n\n1. Use search_contracts with sortBy 'value' to find the largest contracts overall\n2. Search by commodityType (e.g. 'S' = services) to get a within-category top-N view\n3. Use department filters to compare top-N shares across departments\n4. Compute rough top-3 / top-5 shares but label them as approximations over the sampled top-N, NOT full-market HHI\n5. Summarize findings as 'concentration signals at the top of the market' and explicitly flag that segment-level (category × department × region) full-market concentration analysis is out of scope for this tool surface.",
      },
    }],
  }),
);

server.prompt(
  "related-parties",
  "Challenge 6: Find individuals who control multiple entities receiving public money",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, investigate governance-overlap signals among recipients of public money. IMPORTANT SCOPE CAVEAT: multi-board name matches from T3010 director data are LEADS, not proof of related-party control. The ingested director fields currently lack reliable disambiguation (no middle initials, no end-dates for former directors, no address-level matching), so same-name collisions (e.g. two unrelated 'John Smith' directors) are COMMON and must be treated as a hypothesis to be verified, not a finding. Director-field backfill is planned but not yet landed. Follow these steps:\n\n1. Use search_grants to find top grant recipients and collect their business numbers\n2. Use lookup_charity to retrieve each charity's board\n3. Use search_charity_directors to find individuals whose (first, last) name appears on multiple boards\n4. Use cross_reference_entity and search_charity_transfers to check whether the linked charities actually fund each other or share contractors — ONLY then does a same-name overlap start to look like a real governance link\n5. When summarizing, frame results as 'same-name multi-board leads requiring human disambiguation' and explicitly warn that same-name collisions are expected. Do NOT state that any individual 'controls' multiple entities without a funding/governance relationship between the linked organizations.",
      },
    }],
  }),
);

server.prompt(
  "policy-misalignment",
  "Challenge 7: Compare actual spending to stated policy priorities",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, explore how federal spending distributes across topical buckets. IMPORTANT SCOPE CAVEAT: the current data model performs TOPICAL BUCKETING on program-name text (prog_name_en / related fields) using keyword matching — it does NOT compare spending against explicit, measurable government commitments (emissions targets, housing starts, reconciliation spending targets, healthcare capacity goals). This is a COMMITMENT-VS-ALLOCATION proxy at best. Without a structured list of named policy targets and their quantitative baselines, this tool surface cannot answer 'where are the biggest gaps between rhetoric and allocation' in the sense the challenge prompt demands. Follow these steps:\n\n1. Use discover_topic for a policy area (e.g. 'climate', 'housing', 'reconciliation', 'healthcare')\n2. Use search_grants filtered by relevant programs to see funding flows in that topical bucket\n3. Use search_contracts for procurement in the same area\n4. Report total dollars, top recipients, and top programs per topic\n5. When summarizing, label output as 'topical spending composition on program-name text' — NOT a commitment-vs-allocation analysis — and note that real policy-misalignment findings require externally-sourced, measurable commitment baselines that are NOT in this dataset.",
      },
    }],
  }),
);

server.prompt(
  "duplicative-funding",
  "Challenge 8: Find organizations funded by multiple departments for the same purpose",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, surface cases where a single recipient name appears under multiple federal departments. IMPORTANT SCOPE CAVEAT: the current data model only covers FEDERAL MULTI-DEPARTMENT OVERLAP ON SHARED RECIPIENT NAME. It does NOT cover cross-level duplication (federal + provincial + municipal funding the same activity) because provincial and municipal funding data is not loaded, it does NOT verify that the overlapping grants serve the SAME PURPOSE (purpose-level clustering is out of scope — different programs can legitimately fund different activities at the same recipient), and it does NOT detect FUNDING GAPS (priorities that no level of government is funding). Multi-department funding by itself is NOT automatically duplication. Follow these steps:\n\n1. Use search_grants with a large limit to find recipients appearing under multiple federal departments\n2. Use cross_reference_entity for top recipients to see federal grants AND contracts together\n3. For recipients funded by 3+ federal departments, compare program names to form a HYPOTHESIS about purpose overlap — but do NOT assert duplication without human verification of program intent\n4. When summarizing, label output as 'federal multi-department overlap on shared recipient name' and explicitly note that cross-level duplication and funding-gap detection are out of scope.",
      },
    }],
  }),
);

server.prompt(
  "contract-intelligence",
  "Challenge 9: Analyze what Canada is buying and whether costs are rising",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, analyze what the federal government is buying. IMPORTANT SCOPE CAVEAT: the current tool surface supports SPENDING COMPOSITION (largest contracts, largest vendors, spend by commodity/department) but does NOT yet perform COST-GROWTH DECOMPOSITION. Specifically, it does not split year-over-year changes into (a) volume (number of contracts), (b) unit cost / price proxy, or (c) vendor concentration change. A top-N view over time is NOT the same as answering 'is Canada paying more for the same thing' — contract heterogeneity, quarterly-snapshot duplication, and vendor normalization gaps all confound a naive year-over-year comparison. Follow these steps:\n\n1. Use search_contracts with sortBy 'value' to see the largest current contracts\n2. Search by commodityType to compare category-level composition\n3. Use sortBy 'date' to surface recent awards for qualitative review\n4. If the user asks about cost growth, state clearly that a proper volume / unit-cost / concentration decomposition is OUT OF SCOPE for this tool surface and requires contract-history reconstruction across quarterly snapshots\n5. Summarize findings as 'contract composition snapshots' — NOT 'taxpayers are getting less for more' — unless an explicit decomposition has been performed outside this toolset.",
      },
    }],
  }),
);

server.prompt(
  "adverse-media-screening",
  "Challenge 10 (placeholder): Screen top recipients against an internal wrongdoing dataset — NOT a complete adverse-media solution",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Using the Open Government Data Portal MCP tools, run a lightweight red-flag screen on top federal funding recipients. IMPORTANT SCOPE CAVEAT: this is a PLACEHOLDER for Challenge 10, not a complete answer. The only structured 'wrongdoing' dataset currently loaded is the federal Public Servants Disclosure Protection Act 'Acts of Founded Wrongdoing' list, which records INTERNAL government-employee wrongdoing — it is NOT adverse media about external funding recipients. A real Challenge 10 pipeline requires external recipient-focused signals (regulatory enforcement actions, sanctions lists, criminal cases, fraud allegations, safety incidents) that have not yet been ingested. The optional BRAVE_SEARCH_API_KEY web-search path returns unstructured news snippets and does NOT distinguish genuine red-flag reporting from political controversy or op-eds. Follow these steps:\n\n1. Use search_grants / search_contracts with sortBy 'value' to collect top recipients\n2. Use screen_entity on each; treat CRA revoked/annulled charity designations as genuine red flags, but label any 'Acts of Founded Wrongdoing' matches as INTERNAL-GOVERNMENT findings unless the recipient is itself a government body\n3. If web search is enabled, treat snippet results as RAW LEADS to be manually triaged, not as confirmed adverse media\n4. When summarizing, explicitly state that this output is a placeholder precursor to Challenge 10, and that the structured adverse-media ingestion + severity taxonomy (fraud, sanctions, regulatory action, criminal investigation, safety incident) is not yet implemented.",
      },
    }],
  }),
);

server.registerTool(
  "discover_topic",
  {
    description:
      "Discover what open government data and proactive disclosure sources are available for a broad topic. Returns a curated overview including dataset counts, top publishers, available formats, representative datasets, matching proactive disclosure sources, and suggested next steps. Use this when the user wants to explore what data exists before diving into a specific dataset.",
    inputSchema: {
      topic: z
        .string()
        .min(1)
        .describe('The broad topic or question to explore, such as "climate", "government spending", "biodiversity", or "water quality".'),
      maxDatasets: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Maximum number of representative datasets to include. Defaults to 5."),
    },
  },
  async ({ topic, maxDatasets }) => {
    const overview = await discoverTopic({ topic, maxDatasets });

    return {
      content: [
        textBlock(formatDiscoveryText(overview)),
      ],
      structuredContent: toStructuredObject(overview),
    };
  },
);

server.registerTool(
  "get_filter_options",
  {
    description:
      "Show the Open Government Portal filter groups and, when requested, drill into one group with actual value lists and counts. This tool is designed to answer questions like 'What filters are available?' and 'Show me format values.'",
    inputSchema: filterBrowserInputSchema,
  },
  handleGetFilterOptions,
);

server.registerTool(
  "browse_filters",
  {
    description:
      "Friendly alias for browsing Open Government Portal filters. Use this to list filter groups or inspect one group such as Organization, Format, Subject, or API enabled.",
    inputSchema: filterBrowserInputSchema,
  },
  handleGetFilterOptions,
);

server.registerTool(
  "search_datasets",
  {
    description:
      "Search and filter datasets from the Open Government Portal. Returns a readable digest of the top results on the requested page, including publisher, dates, formats, and dataset URLs.",
    inputSchema: searchInputSchema,
  },
  handleSearchDatasets,
);

server.registerTool(
  "search_open_data",
  {
    description:
      "Friendly alias for searching the Open Government Portal. Supports natural filter fields like organization, format, subject, keyword, jurisdictionName, and apiEnabled.",
    inputSchema: searchInputSchema,
  },
  handleSearchDatasets,
);

server.registerTool(
  "get_dataset",
  {
    description:
      "Fetch full dataset metadata from the official Open Government catalog API using a dataset ID, name, or open.canada.ca dataset URL.",
    inputSchema: {
      datasetIdOrNameOrUrl: z
        .string()
        .min(1)
        .describe("Dataset UUID, package name, or open.canada.ca dataset URL."),
    },
  },
  async ({ datasetIdOrNameOrUrl }) => {
    const dataset = await getDataset(datasetIdOrNameOrUrl);

    return {
      content: [
        textBlock(formatDatasetText(dataset)),
      ],
      structuredContent: toStructuredObject(dataset),
    };
  },
);

server.registerTool(
  "list_resources",
  {
    description:
      "List the resources attached to a dataset, including readable guidance about which resource is likely the best one to inspect first.",
    inputSchema: {
      datasetIdOrNameOrUrl: z
        .string()
        .min(1)
        .describe("Dataset UUID, package name, or open.canada.ca dataset URL."),
    },
  },
  async ({ datasetIdOrNameOrUrl }) => {
    const dataset = await getDataset(datasetIdOrNameOrUrl);
    const payload = toStructuredObject({
      dataset: {
        id: dataset.id,
        name: dataset.name,
        title: dataset.title,
        organization: dataset.organization,
      },
      resourceCount: dataset.resources.length,
      resources: dataset.resources,
    });

    return {
      content: [
        textBlock(formatResourcesText(dataset)),
      ],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "preview_resource",
  {
    description:
      "Fetch a small SAMPLE PREVIEW of a dataset resource to quickly see what the data looks like. This is NOT the full dataset — it returns only the first ~50KB of structured text resources (CSV, JSON, XML, GeoJSON, TXT, RDF). Use this to peek at the structure and format before deciding to analyze or download the full resource.",
    inputSchema: {
      datasetIdOrNameOrUrl: z
        .string()
        .optional()
        .describe("Dataset UUID, package name, or open.canada.ca dataset URL when resolving a resource from the catalog."),
      resourceIdOrName: z
        .string()
        .optional()
        .describe("Resource ID or exact resource name within the dataset. Required if the dataset has multiple resources."),
      resourceUrl: z
        .string()
        .url()
        .optional()
        .describe("Direct resource URL. Use this instead of datasetIdOrNameOrUrl when you already have the resource URL."),
      maxBytes: z
        .number()
        .int()
        .min(1_024)
        .max(500_000)
        .optional()
        .describe("Maximum bytes to fetch for the sample preview. Defaults to 50KB."),
    },
  },
  async ({ datasetIdOrNameOrUrl, resourceIdOrName, resourceUrl, maxBytes }) => {
    if (!resourceUrl && !datasetIdOrNameOrUrl) {
      throw new Error("Provide either resourceUrl or datasetIdOrNameOrUrl.");
    }

    let datasetTitle: string | null = null;
    let resourceMetadata:
      | {
          id: string | null;
          name: string | null;
          format: string | null;
          resourceType: string | null;
          url: string;
          mimeType: string | null;
          datastoreActive: boolean;
        }
      | undefined;

    if (!resourceUrl && datasetIdOrNameOrUrl) {
      const dataset = await getDataset(datasetIdOrNameOrUrl);
      const resource = resolveResource(dataset, resourceIdOrName);
      datasetTitle = dataset.title;
      resourceUrl = resource.url;
      resourceMetadata = {
        id: resource.id,
        name: resource.name,
        format: resource.format,
        resourceType: resource.resourceType,
        url: resource.url,
        mimeType: resource.mimeType,
        datastoreActive: resource.datastoreActive,
      };
    }

    const preview = await fetchResourcePreview({
      url: resourceUrl!,
      format: resourceMetadata?.format ?? null,
      mimeType: resourceMetadata?.mimeType ?? null,
      maxBytes: maxBytes ?? DEFAULT_PREVIEW_MAX_BYTES,
    });

    const payload = toStructuredObject({
      datasetTitle,
      resource: resourceMetadata ?? {
        id: null,
        name: null,
        format: null,
        resourceType: null,
        url: resourceUrl!,
        mimeType: null,
        datastoreActive: false,
      },
      preview,
    });

    return {
      content: [
        textBlock(formatResourcePreviewText(payload as Parameters<typeof formatResourcePreviewText>[0])),
      ],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "fetch_resource",
  {
    description:
      "Fetch a SAMPLE PREVIEW of a dataset resource. This is the same as preview_resource — it returns a bounded sample, not the full dataset. For complete data, use download_resource instead.",
    inputSchema: {
      datasetIdOrNameOrUrl: z
        .string()
        .optional()
        .describe("Dataset UUID, package name, or open.canada.ca dataset URL."),
      resourceIdOrName: z
        .string()
        .optional()
        .describe("Resource ID or exact resource name within the dataset."),
      resourceUrl: z
        .string()
        .url()
        .optional()
        .describe("Direct resource URL."),
      maxBytes: z
        .number()
        .int()
        .min(1_024)
        .max(500_000)
        .optional()
        .describe("Maximum bytes to fetch for the sample preview. Defaults to 50KB."),
    },
  },
  async ({ datasetIdOrNameOrUrl, resourceIdOrName, resourceUrl, maxBytes }) => {
    if (!resourceUrl && !datasetIdOrNameOrUrl) {
      throw new Error("Provide either resourceUrl or datasetIdOrNameOrUrl.");
    }

    let datasetTitle: string | null = null;
    let resourceMetadata:
      | {
          id: string | null;
          name: string | null;
          format: string | null;
          resourceType: string | null;
          url: string;
          mimeType: string | null;
          datastoreActive: boolean;
        }
      | undefined;

    if (!resourceUrl && datasetIdOrNameOrUrl) {
      const dataset = await getDataset(datasetIdOrNameOrUrl);
      const resource = resolveResource(dataset, resourceIdOrName);
      datasetTitle = dataset.title;
      resourceUrl = resource.url;
      resourceMetadata = {
        id: resource.id,
        name: resource.name,
        format: resource.format,
        resourceType: resource.resourceType,
        url: resource.url,
        mimeType: resource.mimeType,
        datastoreActive: resource.datastoreActive,
      };
    }

    const preview = await fetchResourcePreview({
      url: resourceUrl!,
      format: resourceMetadata?.format ?? null,
      mimeType: resourceMetadata?.mimeType ?? null,
      maxBytes: maxBytes ?? DEFAULT_PREVIEW_MAX_BYTES,
    });

    const payload = toStructuredObject({
      datasetTitle,
      resource: resourceMetadata ?? {
        id: null,
        name: null,
        format: null,
        resourceType: null,
        url: resourceUrl!,
        mimeType: null,
        datastoreActive: false,
      },
      preview,
    });

    return {
      content: [
        textBlock(formatResourcePreviewText(payload as Parameters<typeof formatResourcePreviewText>[0])),
      ],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "download_resource",
  {
    description:
      "Download the COMPLETE content of a dataset resource. Unlike preview_resource, this fetches the full file (up to 50MB). Use this when you need all the data, not just a sample. Returns the full text content for structured formats (CSV, JSON, XML, GeoJSON, TXT) or metadata plus the download URL for binary formats.",
    inputSchema: {
      datasetIdOrNameOrUrl: z
        .string()
        .optional()
        .describe("Dataset UUID, package name, or open.canada.ca dataset URL."),
      resourceIdOrName: z
        .string()
        .optional()
        .describe("Resource ID or exact resource name within the dataset."),
      resourceUrl: z
        .string()
        .url()
        .optional()
        .describe("Direct resource URL."),
      maxBytes: z
        .number()
        .int()
        .min(1_024)
        .max(50_000_000)
        .optional()
        .describe("Maximum bytes to download. Defaults to 50MB."),
    },
  },
  async ({ datasetIdOrNameOrUrl, resourceIdOrName, resourceUrl, maxBytes }) => {
    if (!resourceUrl && !datasetIdOrNameOrUrl) {
      throw new Error("Provide either resourceUrl or datasetIdOrNameOrUrl.");
    }

    let datasetTitle: string | null = null;
    let resourceMetadata:
      | {
          id: string | null;
          name: string | null;
          format: string | null;
          resourceType: string | null;
          url: string;
          mimeType: string | null;
          datastoreActive: boolean;
        }
      | undefined;

    if (!resourceUrl && datasetIdOrNameOrUrl) {
      const dataset = await getDataset(datasetIdOrNameOrUrl);
      const resource = resolveResource(dataset, resourceIdOrName);
      datasetTitle = dataset.title;
      resourceUrl = resource.url;
      resourceMetadata = {
        id: resource.id,
        name: resource.name,
        format: resource.format,
        resourceType: resource.resourceType,
        url: resource.url,
        mimeType: resource.mimeType,
        datastoreActive: resource.datastoreActive,
      };
    }

    const result = await fetchResourcePreview({
      url: resourceUrl!,
      format: resourceMetadata?.format ?? null,
      mimeType: resourceMetadata?.mimeType ?? null,
      maxBytes: maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
    });

    const resourceInfo = resourceMetadata ?? {
      id: null,
      name: null,
      format: null,
      resourceType: null,
      url: resourceUrl!,
      mimeType: null,
      datastoreActive: false,
    };

    const lines: string[] = [];
    lines.push(resourceInfo.name ? `Download: ${resourceInfo.name}` : "Download complete");
    if (datasetTitle) {
      lines.push(`Dataset: ${datasetTitle}`);
    }
    lines.push(`URL: ${result.finalUrl}`);

    if (!result.fetchedDirectly) {
      lines.push("");
      lines.push(result.directFetchReason);
      lines.push(`Download this file directly from: ${result.finalUrl}`);
    } else {
      const sizeKB = Math.round(result.bytesRead / 1024);
      lines.push(`Downloaded: ${sizeKB} KB${result.previewTruncated ? " (truncated at byte limit — the full file is larger)" : " (complete file)"}`);
      if (result.contentType) {
        lines.push(`Content type: ${result.contentType}`);
      }
      if (result.previewText) {
        lines.push("");
        lines.push("Full content:");
        lines.push("```");
        lines.push(result.previewText);
        lines.push("```");
      }
    }

    return {
      content: [textBlock(lines.join("\n"))],
      structuredContent: toStructuredObject({
        datasetTitle,
        resource: resourceInfo,
        download: {
          fetchedDirectly: result.fetchedDirectly,
          bytesRead: result.bytesRead,
          truncated: result.previewTruncated,
          contentType: result.contentType,
          finalUrl: result.finalUrl,
        },
        fullText: result.previewText,
      }),
    };
  },
);

server.registerTool(
  "analyze_dataset",
  {
    description:
      "Analyze a structured dataset resource and explain the detected columns, likely dimensions and measures, sample rows, chart ideas, and caveats. Use this when you want Claude to understand a dataset before charting or reporting on it.",
    inputSchema: analysisInputSchema,
  },
  handleAnalyzeDataset,
);

server.registerTool(
  "visualize_dataset",
  {
    description:
      "Prepare a chart-ready view of a structured dataset resource. The tool can pick a sensible chart automatically or follow a requested chart goal, chart type, or field selection.",
    inputSchema: visualizationInputSchema,
  },
  handleVisualizeDataset,
);

server.registerTool(
  "map_dataset",
  {
    description:
      "Prepare a GeoJSON dataset resource for map use. The tool selects a usable GeoJSON resource, identifies good label and value fields, summarizes the geometry, and returns a bounded GeoJSON map payload plus readable guidance.",
    inputSchema: mapInputSchema,
  },
  handleMapDataset,
);

server.registerTool(
  "query_datastore",
  {
    description:
      "Query the CKAN DataStore API to search, filter, and retrieve records directly from a dataset resource that has DataStore enabled. This is the fastest way to get structured data without downloading entire files. Supports text search, column filters, field selection, sorting, and pagination. Use this for contract analysis, grants analysis, or any resource where datastore_active is true.",
    inputSchema: {
      resourceId: z
        .string()
        .min(1)
        .describe("The resource ID to query. Find this from list_resources or get_dataset (look for resources where datastoreActive is true)."),
      query: z
        .string()
        .optional()
        .describe("Optional full-text search across all fields."),
      filters: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe('Optional column filters as key-value pairs. Example: {"solicitation_procedure": "TN", "commodity_type": "S"}'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Optional list of fields to return. Example: ["vendor_name", "contract_value", "solicitation_procedure"]'),
      sort: z
        .string()
        .optional()
        .describe('Optional sort expression. Example: "contract_value desc" or "contract_date asc"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum number of records to return. Defaults to 10, max 1000."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of records to skip for pagination."),
    },
  },
  async ({ resourceId, query, filters, fields, sort, limit, offset }) => {
    const result = await datastoreSearch({
      resourceId,
      query,
      filters: filters as Record<string, string | string[]> | undefined,
      fields,
      sort,
      limit,
      offset,
    });

    return {
      content: [
        textBlock(formatDatastoreSearchText(result, { query })),
      ],
      structuredContent: toStructuredObject(result),
    };
  },
);

server.registerTool(
  "search_contracts",
  {
    description:
      "Search the Government of Canada contracts database (1.26 million records). Returns contracts with all three value columns (contract_value, original_value, amendment_value) plus a computed effective_value and amendment ratio. Supports filtering by vendor, department, solicitation procedure, commodity type, and description. Client-side numeric sorting ensures 'top by value' actually works. Solicitation codes: TN = sole-source, TC = competitive.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('Optional text search (uses legacy dataset). Example: "IT consulting", "translation"'),
      vendor: z
        .string()
        .optional()
        .describe("Filter by vendor name (exact match)."),
      department: z
        .string()
        .optional()
        .describe("Filter by department/organization name."),
      description: z
        .string()
        .optional()
        .describe('Filter by contract description (exact match). Example: "Information technology and telecommunications consultants"'),
      solicitationProcedure: z
        .string()
        .optional()
        .describe('"TN" = sole-source, "TC" = competitive.'),
      commodityType: z
        .string()
        .optional()
        .describe('"S" = service, "G" = good.'),
      sortBy: z
        .enum(["value", "amendment_ratio", "date"])
        .optional()
        .describe('Sort results by "value" (effective contract value, default), "amendment_ratio" (amendment creep), or "date" (most recent first).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum contracts to return after sorting. Defaults to 20."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Records to skip for pagination (applied at the DataStore level before client-side sorting)."),
    },
  },
  async ({ query, vendor, department, description, solicitationProcedure, commodityType, sortBy, limit, offset }) => {
    const hasFilters = vendor || department || description || solicitationProcedure || commodityType;
    const useMainResource = hasFilters || !query;
    const requestedLimit = limit ?? 20;

    const filters: Record<string, string> = {};
    if (vendor) {
      filters.vendor_name = vendor;
    }
    if (department) {
      filters.owner_org_title = department;
    }
    if (description) {
      filters.description_en = description;
    }
    if (solicitationProcedure) {
      filters.solicitation_procedure = solicitationProcedure;
    }
    if (commodityType) {
      filters.commodity_type = commodityType;
    }

    // Fetch a large batch so client-side numeric sort covers contracts across all departments.
    // The DataStore stores values as text so server-side sort is meaningless for finding true top values.
    // 32K records takes ~6 seconds and covers a representative cross-section of all departments.
    const needsClientSort = (sortBy ?? "value") !== "date";
    const fetchLimit = needsClientSort ? 32000 : Math.min(requestedLimit * 3, 500);

    const result = await datastoreSearch({
      resourceId: useMainResource
        ? "fac950c0-00d5-4ec1-a4d3-9cbebf98a305"
        : "7f9b18ca-f627-4852-93d5-69adeb9437d6",
      query: useMainResource ? undefined : query,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      fields: [
        "vendor_name", "contract_value", "original_value", "amendment_value",
        "solicitation_procedure", "owner_org_title", "contract_date",
        "commodity_type", "description_en", "instrument_type",
      ],
      sort: sortBy === "date" ? "contract_date desc" : undefined,
      limit: fetchLimit,
      offset,
    });

    let contracts = parseContracts(result.records);

    const effectiveSortBy = sortBy ?? "value";
    let sortLabel: string;
    if (effectiveSortBy === "amendment_ratio") {
      contracts = sortContractsByAmendmentRatio(contracts);
      sortLabel = "Amendment ratio (highest amendment creep first)";
    } else if (effectiveSortBy === "date") {
      sortLabel = "Contract date (most recent first)";
    } else {
      contracts = sortContractsByValue(contracts);
      sortLabel = "Effective value (highest value first)";
    }

    contracts = contracts.slice(0, requestedLimit);

    return {
      content: [
        textBlock(formatContractsSearchText(result, contracts, {
          query,
          sortedBy: sortLabel,
        })),
      ],
      structuredContent: toStructuredObject({
        total: result.total,
        showing: contracts.length,
        sortedBy: sortLabel,
        contracts,
      }),
    };
  },
);

server.registerTool(
  "search_grants",
  {
    description:
      "Search 1.275 million federal grants and contributions records. Filter by recipient, department, program, province, agreement type, or recipient type. When sorting by value, samples across the full dataset. Recipient type codes: N = not-for-profit (229K records, includes charities), A = Aboriginal/Indigenous (157K), S = academic (23K), P = private/for-profit (217K), G = government (31K), O = other (54K), I = international (2K). To find charities specifically, use recipientType 'N'. Note: text search is NOT supported — use filters instead.",
    inputSchema: {
      recipient: z.string().optional().describe("Filter by recipient legal name (exact match)."),
      department: z.string().optional().describe("Filter by funding department/organization (exact bilingual name)."),
      program: z.string().optional().describe("Filter by program name (exact match)."),
      province: z.string().optional().describe("Filter by recipient province code (e.g. ON, BC, QC)."),
      agreementType: z.string().optional().describe('"G" = grant, "C" = contribution.'),
      recipientType: z.string().optional().describe('Filter by recipient type: "N" = not-for-profit/charity, "A" = Aboriginal/Indigenous, "S" = academic, "P" = private/for-profit, "G" = government, "O" = other, "I" = international.'),
      sortBy: z.enum(["value", "date"]).optional().describe('Sort by "value" (default) or "date".'),
      limit: z.number().int().min(1).max(100).optional().describe("Max results. Defaults to 20."),
      offset: z.number().int().min(0).optional().describe("Records to skip for pagination."),
    },
  },
  async ({ recipient, department, program, province, agreementType, recipientType, sortBy, limit, offset }) => {
    const requestedLimit = limit ?? 20;
    const filters: Record<string, string> = {};
    if (recipient) filters.recipient_legal_name = recipient;
    if (department) filters.owner_org_title = department;
    if (program) filters.prog_name_en = program;
    if (province) filters.recipient_province = province;
    if (agreementType) filters.agreement_type = agreementType;
    if (recipientType) filters.recipient_type = recipientType;

    const hasFilters = Object.keys(filters).length > 0;
    const needsClientSort = (sortBy ?? "value") !== "date";

    let allRecords: Array<Record<string, unknown>> = [];
    let totalRecords = 0;
    const fields = ["recipient_legal_name", "recipient_operating_name", "recipient_business_number", "agreement_value", "agreement_type", "owner_org_title", "prog_name_en", "recipient_province", "recipient_city", "agreement_start_date", "agreement_end_date", "description_en"];

    if (hasFilters || !needsClientSort) {
      // With filters, a single fetch is fine
      const fetchLimit = needsClientSort ? 32000 : Math.min(requestedLimit * 3, 500);
      const result = await datastoreSearch({
        resourceId: GRANTS_RESOURCE_ID,
        filters: hasFilters ? filters : undefined,
        fields,
        sort: needsClientSort ? undefined : "agreement_start_date desc",
        limit: fetchLimit,
        offset,
      });
      allRecords = result.records;
      totalRecords = result.total;
    } else {
      // No filters + sort by value: multi-offset sampling to cover all departments
      // 4 parallel fetches at different offsets covers ~25K records across the full 1.275M dataset
      const sampleOffsets = [0, 300000, 700000, 1100000];
      const batchResults = await Promise.all(
        sampleOffsets.map((off) =>
          datastoreSearch({
            resourceId: GRANTS_RESOURCE_ID,
            fields,
            limit: 8000,
            offset: off,
          }),
        ),
      );
      for (const result of batchResults) {
        allRecords.push(...result.records);
      }
      totalRecords = batchResults[0]?.total ?? 0;
    }

    let grants = parseGrants(allRecords);
    let sortLabel: string;
    if (needsClientSort) {
      grants = sortGrantsByValue(grants);
      sortLabel = `Value (highest first, sampled ${new Intl.NumberFormat("en-US").format(allRecords.length)} records across the dataset)`;
    } else {
      sortLabel = "Date (most recent first)";
    }
    grants = grants.slice(0, requestedLimit);

    const mockResult = { resourceId: GRANTS_RESOURCE_ID, fields: [], records: allRecords, total: totalRecords, limit: allRecords.length, offset: 0 };

    return {
      content: [textBlock(formatGrantsSearchText(mockResult, grants, { sortedBy: sortLabel }))],
      structuredContent: toStructuredObject({ total: totalRecords, sampled: allRecords.length, showing: grants.length, grants }),
    };
  },
);

server.registerTool(
  "find_charity_bn",
  {
    description:
      "Find the CRA business number (BN) for a registered charity by searching its name in T3010 identification data. Use this to bridge between grant recipient names (which often lack BNs) and the T3010 charity profile tools that require a BN. Returns matching charities with their BNs. Note: only registered charities appear — corporations, port authorities, and for-profit entities will not be found.",
    inputSchema: {
      name: z.string().min(1).describe("Charity or nonprofit name to search for (fuzzy text search)."),
    },
  },
  async ({ name }) => {
    const matches = await findCharityBN(name);
    return {
      content: [textBlock(formatCharityBNSearchText(name, matches))],
      structuredContent: toStructuredObject({ query: name, matches }),
    };
  },
);

server.registerTool(
  "lookup_charity",
  {
    description:
      "Look up a registered Canadian charity by business number (BN). Returns the charity's identity, T3010 financial summary (total revenue, total expenditure, Line 4120 self-reported government revenue, annualized verified federal grants from the grants table via BN-prefix match, and compensation as a percentage of revenue), board of directors, compensation breakdown, and charitable programs. 'Government funding' reflects ONLY T3010 Line 4120 self-reported government revenue — Lines 4130 (investment income) and 4140 (other revenue) are never summed in. For verified federal disbursements, prefer the annualized grants figure (SUM / distinct years). If you don't have the BN, use find_charity_bn first to look it up by name.",
    inputSchema: {
      businessNumber: z.string().min(1).describe("The charity's business number (BN) from CRA. Found in grant records as recipient_business_number."),
    },
  },
  async ({ businessNumber }) => {
    const profile = await lookupCharity(businessNumber);
    return {
      content: [textBlock(formatCharityProfileText(profile))],
      structuredContent: toStructuredObject(profile),
    };
  },
);

server.registerTool(
  "search_charity_transfers",
  {
    description:
      "Search charity-to-charity transfers from T3010 qualified donee data (344K records). Find which charities give money to which other charities. Automatically flags 2-node RECIPROCAL PAIRS (A→B and B→A) as a loop signal. Does NOT detect triangular or longer cycles, and does NOT classify loops as structurally normal (federated/denominational, donation platforms) vs potentially suspicious — that classification must be done downstream.",
    inputSchema: {
      donorBN: z.string().optional().describe("Filter by donor charity BN."),
      doneeBN: z.string().optional().describe("Filter by recipient charity BN."),
      doneeName: z.string().optional().describe("Filter by recipient charity name."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results. Defaults to 100."),
    },
  },
  async ({ donorBN, doneeBN, doneeName, limit }) => {
    const result = await searchCharityTransfers({ donorBN, doneeBN, doneeName, limit });
    return {
      content: [textBlock(formatTransferSearchText(result, { donorBN, doneeBN }))],
      structuredContent: toStructuredObject(result),
    };
  },
);

server.registerTool(
  "detect_funding_loops",
  {
    description:
      "Starting from a charity BN, follow the chain of LARGEST transfers outward to see whether money returns to the origin within a small number of hops. This is a heuristic largest-edge walk, NOT an exhaustive cycle detector: it will miss triangular cycles and longer chains that don't follow the largest-transfer edge at each step. A negative result means 'no loop found by this heuristic', not 'no loop exists'.",
    inputSchema: {
      startingBN: z.string().min(1).describe("The business number to start tracing from."),
      maxHops: z.number().int().min(1).max(5).optional().describe("Maximum chain depth. Defaults to 2."),
    },
  },
  async ({ startingBN, maxHops }) => {
    const result = await detectFundingLoops(startingBN, maxHops ?? 2);
    return {
      content: [textBlock(formatLoopDetectionText(result, startingBN))],
      structuredContent: toStructuredObject(result),
    };
  },
);

server.registerTool(
  "search_charity_directors",
  {
    description:
      "Search 568K charity director/officer records from T3010 data. Find directors by name or by charity BN. Flags individuals whose (first, last) name tuple appears on multiple boards as LEADS for governance-overlap investigation. Same-name collisions (e.g. two unrelated 'John Smith' directors) are common: current director records lack middle initials, end-dates for former directors, and address-level disambiguation, so multi-board hits must be treated as hypotheses to verify, NOT as proof that one individual controls multiple entities.",
    inputSchema: {
      lastName: z.string().optional().describe("Filter by director last name (exact match)."),
      firstName: z.string().optional().describe("Filter by director first name (exact match)."),
      bn: z.string().optional().describe("Filter by charity business number to see all directors of one charity."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results. Defaults to 100."),
    },
  },
  async ({ lastName, firstName, bn, limit }) => {
    const result = await searchCharityDirectors({ lastName, firstName, bn, limit });
    return {
      content: [textBlock(formatDirectorSearchText(result, { lastName, bn }))],
      structuredContent: toStructuredObject(result),
    };
  },
);

server.registerTool(
  "cross_reference_entity",
  {
    description:
      "Build a comprehensive dossier for an entity by searching across ALL government data sources: federal grants, federal contracts, T3010 charity records, and charity-to-charity transfers. Returns a unified view of every government touchpoint for the entity.",
    inputSchema: {
      entityName: z.string().optional().describe("Entity name to search across grants and contracts."),
      businessNumber: z.string().optional().describe("Business number for T3010 charity lookup and transfer search."),
    },
  },
  async ({ entityName, businessNumber }) => {
    const dossier = await crossReferenceEntity({ entityName, businessNumber });
    return {
      content: [textBlock(formatEntityDossierText(dossier))],
      structuredContent: toStructuredObject(dossier),
    };
  },
);

server.registerTool(
  "screen_entity",
  {
    description:
      "Screen a funding recipient against available red-flag sources. Checks CRA charity status (revoked/annulled — a genuine external red flag) and the federal 'Acts of Founded Wrongdoing' list. NOTE: the founded-wrongdoing dataset records INTERNAL government-employee wrongdoing under the Public Servants Disclosure Protection Act — it is NOT external adverse media about the recipient, and should be labeled as such in downstream summaries. If BRAVE_SEARCH_API_KEY is set, an optional web search returns unstructured news snippets as raw leads (no severity taxonomy, does not distinguish genuine enforcement actions from political controversy). This tool is a PLACEHOLDER for a structured adverse-media pipeline, not a complete Challenge 10 solution.",
    inputSchema: {
      entityName: z.string().min(1).describe("Entity name to screen."),
      businessNumber: z.string().optional().describe("Business number for CRA charity status check."),
      includeWebSearch: z.boolean().optional().describe("Whether to include adverse media web search. Requires BRAVE_SEARCH_API_KEY. Defaults to false."),
    },
  },
  async ({ entityName, businessNumber, includeWebSearch }) => {
    const result = await screenEntity({ entityName, businessNumber, includeWebSearch });
    return {
      content: [textBlock(formatScreeningText(result))],
      structuredContent: toStructuredObject(result),
    };
  },
);

async function handleGetFilterOptions(args: FilterBrowserArgs) {
  const resolved = await resolveSearchFilters({
    rawFilters: args.filters,
  });

  const request: {
    query?: string;
    sort?: (typeof SORT_OPTIONS)[number];
    filters?: SearchFilters;
  } = {
    sort: args.sort ?? DEFAULT_SORT,
  };

  if (args.query !== undefined) {
    request.query = args.query;
  }

  if (Object.keys(resolved.filters).length > 0) {
    request.filters = resolved.filters;
  }

  const result = await getPortalFilters(request);
  const selectedKey = resolveFilterGroupInput(args.filterGroup, result.groups);

  if (args.filterGroup && !selectedKey) {
    return {
      content: [
        textBlock(formatInvalidFilterGroupText(args.filterGroup)),
      ],
      isError: true,
    };
  }

  const selectedGroup = selectedKey ? result.groups.find((group) => group.param === selectedKey) ?? null : null;
  const payload = toStructuredObject({
    sourceUrl: result.url,
    groupCount: result.groups.length,
    selectedGroup,
    groups: result.groups,
  });

  return {
    content: [
      textBlock(
        formatFilterOptionsText({
          groups: result.groups,
          selectedGroup,
          valueSearch: args.valueSearch,
          limit: args.limit,
        }),
      ),
    ],
    structuredContent: payload,
  };
}

async function handleSearchDatasets(args: SearchToolArgs) {
  const resolved = await resolveSearchFilters({
    rawFilters: args.filters,
    friendly: {
      organization: args.organization,
      portalType: args.portalType,
      collectionType: args.collectionType,
      jurisdictionName: args.jurisdictionName,
      keyword: args.keyword,
      subject: args.subject,
      format: args.format,
      updateFrequency: args.updateFrequency,
      resourceTypeName: args.resourceTypeName,
      apiEnabled: args.apiEnabled,
    },
  });

  const request: {
    query?: string;
    page?: number;
    sort?: (typeof SORT_OPTIONS)[number];
    filters?: SearchFilters;
  } = {
    page: args.page ?? DEFAULT_PAGE,
    sort: args.sort ?? DEFAULT_SORT,
  };

  if (args.query !== undefined) {
    request.query = args.query;
  }

  if (Object.keys(resolved.filters).length > 0) {
    request.filters = resolved.filters;
  }

  const result = await searchPortalDatasets(request);
  const payload = toStructuredObject({
    ...result,
    appliedFilters: resolved.appliedGroups,
    unresolvedInputs: resolved.unresolvedInputs,
  });

  return {
    content: [
      textBlock(
        formatSearchResultsText({
          result,
          appliedFilters: resolved.appliedGroups,
          unresolvedInputs: resolved.unresolvedInputs,
        }),
      ),
    ],
    structuredContent: payload,
  };
}

async function handleAnalyzeDataset(args: AnalysisToolArgs) {
  const result = await analyzeDatasetResource({
    datasetIdOrNameOrUrl: args.datasetIdOrNameOrUrl,
    resourceIdOrName: args.resourceIdOrName,
    resourceUrl: args.resourceUrl,
    maxBytes: args.maxBytes ?? DEFAULT_ANALYSIS_MAX_BYTES,
    maxRows: args.maxRows ?? DEFAULT_ANALYSIS_MAX_ROWS,
  });

  return {
    content: [
      textBlock(formatAnalysisText(result)),
    ],
    structuredContent: toStructuredObject(result),
  };
}

async function handleVisualizeDataset(args: VisualizationToolArgs) {
  const result = await prepareDatasetChart({
    datasetIdOrNameOrUrl: args.datasetIdOrNameOrUrl,
    resourceIdOrName: args.resourceIdOrName,
    resourceUrl: args.resourceUrl,
    maxBytes: args.maxBytes ?? DEFAULT_ANALYSIS_MAX_BYTES,
    maxRows: args.maxRows ?? DEFAULT_ANALYSIS_MAX_ROWS,
    chartGoal: args.chartGoal,
    chartType: args.chartType,
    xField: args.xField,
    yField: args.yField,
    groupField: args.groupField,
    aggregation: args.aggregation,
    topN: args.topN,
  });

  return {
    content: [
      textBlock(formatChartText(result)),
    ],
    structuredContent: toStructuredObject(result),
  };
}

async function handleMapDataset(args: MapToolArgs) {
  const result = await prepareGeoJsonMap({
    datasetIdOrNameOrUrl: args.datasetIdOrNameOrUrl,
    resourceIdOrName: args.resourceIdOrName,
    resourceUrl: args.resourceUrl,
    labelField: args.labelField,
    valueField: args.valueField,
    maxBytes: args.maxBytes ?? DEFAULT_MAP_MAX_BYTES,
    maxRows: args.maxRows ?? DEFAULT_ANALYSIS_MAX_ROWS,
    maxFeatures: args.maxFeatures ?? DEFAULT_MAP_FEATURE_LIMIT,
  });

  return {
    content: [
      textBlock(formatMapText(result)),
    ],
    structuredContent: toStructuredObject(result),
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});

function toStructuredObject<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function textBlock(text: string) {
  return {
    type: "text" as const,
    text,
  };
}
