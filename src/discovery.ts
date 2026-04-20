import { DISCLOSURE_SOURCES, findDisclosureSourceByTopic, type DisclosureSource } from "./disclosure-sources.js";
import { normalizeWhitespace } from "./helpers.js";
import { getPortalFilters, searchPortalDatasets, type PortalSearchResponse } from "./portal.js";

export interface DiscoveryTopicOverview {
  topic: string;
  openData: {
    totalRecords: number | null;
    topPublishers: string[];
    topFormats: string[];
    topSubjects: string[];
    chartFriendlyFormats: string[];
    mapFriendlyFormats: string[];
    representativeDatasets: Array<{
      title: string;
      publisher: string | null;
      formats: string[];
      datasetUrl: string;
      summary: string;
      goodFor: string[];
    }>;
  };
  proactiveDisclosure: {
    matchingSources: Array<{
      id: string;
      title: string;
      description: string;
      searchUrl: string;
      recordCount: string | null;
      domain: string;
    }>;
  };
  suggestedNextSteps: string[];
}

export async function discoverTopic(options: {
  topic: string;
  maxDatasets?: number | undefined;
}): Promise<DiscoveryTopicOverview> {
  const topic = normalizeWhitespace(options.topic);
  const maxDatasets = options.maxDatasets ?? 5;

  // Single combined call: the catalog API now returns both results and facets
  const [searchResult, filterResult] = await Promise.all([
    searchPortalDatasets({ query: topic }),
    getPortalFilters({ query: topic }),
  ]);

  const topPublishers = extractTopFilterValues(filterResult.groups, "owner_org", 5);
  const topFormats = extractTopFilterValues(filterResult.groups, "resource_format", 8);
  const topSubjects = extractTopFilterValues(filterResult.groups, "subject_en", 5);

  const chartFriendlyFormats = topFormats.filter((format) =>
    ["CSV", "JSON", "JSONL", "XML", "TXT"].includes(format.toUpperCase()),
  );
  const mapFriendlyFormats = topFormats.filter((format) =>
    ["GEOJSON", "KML", "KMZ", "SHP", "FGDB/GDB"].includes(format.toUpperCase()),
  );

  const representativeDatasets = buildRepresentativeDatasets(searchResult, maxDatasets);
  const matchingDisclosureSources = findMatchingDisclosureSources(topic);
  const suggestedNextSteps = buildSuggestedNextSteps({
    topic,
    hasOpenData: (searchResult.totalRecords ?? 0) > 0,
    hasChartFormats: chartFriendlyFormats.length > 0,
    hasMapFormats: mapFriendlyFormats.length > 0,
    hasDisclosureSources: matchingDisclosureSources.length > 0,
    representativeDatasets,
  });

  return {
    topic,
    openData: {
      totalRecords: searchResult.totalRecords,
      topPublishers,
      topFormats,
      topSubjects,
      chartFriendlyFormats,
      mapFriendlyFormats,
      representativeDatasets,
    },
    proactiveDisclosure: {
      matchingSources: matchingDisclosureSources.map((source) => ({
        id: source.id,
        title: source.title,
        description: source.description,
        searchUrl: source.searchUrl,
        recordCount: source.recordCount,
        domain: source.domain,
      })),
    },
    suggestedNextSteps,
  };
}

function extractTopFilterValues(
  groups: Awaited<ReturnType<typeof getPortalFilters>>["groups"],
  param: string,
  limit: number,
): string[] {
  const group = groups.find((g) => g.param === param);
  if (!group) {
    return [];
  }

  return group.options
    .slice(0, limit)
    .map((option) => option.label);
}

function buildRepresentativeDatasets(
  searchResult: PortalSearchResponse,
  maxDatasets: number,
): DiscoveryTopicOverview["openData"]["representativeDatasets"] {
  return searchResult.results.slice(0, maxDatasets).map((item) => {
    const goodFor = assessGoodFor(item.formats);
    return {
      title: item.title,
      publisher: item.publisher,
      formats: item.formats,
      datasetUrl: item.datasetUrl,
      summary: item.summary ? truncateText(item.summary, 200) : "",
      goodFor,
    };
  });
}

function assessGoodFor(formats: string[]): string[] {
  const uses: string[] = [];
  const upperFormats = formats.map((f) => f.toUpperCase());

  if (upperFormats.some((f) => ["CSV", "JSON", "JSONL", "XML"].includes(f))) {
    uses.push("analysis");
    uses.push("charting");
  }

  if (upperFormats.some((f) => ["GEOJSON", "KML", "KMZ", "SHP"].includes(f))) {
    uses.push("mapping");
  }

  if (upperFormats.some((f) => ["CSV", "JSON", "XML", "TXT", "GEOJSON"].includes(f))) {
    uses.push("raw data access");
  }

  if (uses.length === 0 && formats.length > 0) {
    uses.push("inspection");
  }

  return uses;
}

function findMatchingDisclosureSources(topic: string): DisclosureSource[] {
  const directMatches = findDisclosureSourceByTopic(topic);
  if (directMatches.length > 0) {
    return directMatches;
  }

  const normalized = topic.toLowerCase();
  const broadMatches: DisclosureSource[] = [];

  const spendingKeywords = ["spending", "money", "budget", "financial", "cost", "expense", "dollar", "funding", "fiscal", "procurement", "purchase"];
  const travelKeywords = ["travel", "trip", "flight", "hospitality", "conference", "aircraft"];
  const accountabilityKeywords = ["accountability", "transparency", "wrongdoing", "disclosure", "government", "minister", "briefing", "parliament"];

  if (spendingKeywords.some((keyword) => normalized.includes(keyword))) {
    broadMatches.push(...DISCLOSURE_SOURCES.filter((s) => s.domain === "spending"));
  }

  if (travelKeywords.some((keyword) => normalized.includes(keyword))) {
    broadMatches.push(...DISCLOSURE_SOURCES.filter((s) => s.domain === "travel"));
  }

  if (accountabilityKeywords.some((keyword) => normalized.includes(keyword))) {
    broadMatches.push(...DISCLOSURE_SOURCES.filter((s) => s.domain === "briefing" || s.domain === "reporting"));
  }

  const seen = new Set<string>();
  return broadMatches.filter((source) => {
    if (seen.has(source.id)) {
      return false;
    }
    seen.add(source.id);
    return true;
  });
}

function buildSuggestedNextSteps(options: {
  topic: string;
  hasOpenData: boolean;
  hasChartFormats: boolean;
  hasMapFormats: boolean;
  hasDisclosureSources: boolean;
  representativeDatasets: DiscoveryTopicOverview["openData"]["representativeDatasets"];
}): string[] {
  const steps: string[] = [];
  const firstDataset = options.representativeDatasets[0];

  if (firstDataset && options.hasChartFormats) {
    steps.push(`Analyze and chart a top result: use analyze_dataset or visualize_dataset with "${firstDataset.datasetUrl}"`);
  }

  if (firstDataset && options.hasMapFormats) {
    steps.push(`Map a GeoJSON result: use map_dataset with a dataset that has GeoJSON resources`);
  }

  if (firstDataset) {
    steps.push(`Inspect a dataset: use get_dataset with "${firstDataset.datasetUrl}"`);
  }

  if (options.hasOpenData) {
    steps.push(`Narrow the search: use search_open_data with additional filters like organization, format, or subject`);
    steps.push(`Browse filters: use browse_filters to see what organizations, formats, or subjects are available for "${options.topic}"`);
  }

  if (options.hasDisclosureSources) {
    steps.push(`Explore proactive disclosure: the matching disclosure sources listed above can be searched directly at their URLs`);
  }

  if (!options.hasOpenData && !options.hasDisclosureSources) {
    steps.push(`Try a broader or different topic — no results were found for "${options.topic}"`);
  }

  return steps;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}
