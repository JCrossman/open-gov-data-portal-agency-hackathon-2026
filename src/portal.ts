import {
  CATALOG_API_BASE_URL,
  DEFAULT_PAGE,
  DEFAULT_SORT,
  FILTER_GROUPS,
  FILTER_TITLES,
  type FilterGroupKey,
  type SearchFilters,
  type SortOption,
} from "./constants.js";
import { normalizeWhitespace } from "./helpers.js";

export interface FilterOption {
  value: string;
  label: string;
  count: number | null;
  selected: boolean;
}

export interface FilterGroup {
  heading: string;
  param: FilterGroupKey;
  options: FilterOption[];
  optionCount: number;
}

export interface PortalSearchResultItem {
  datasetId: string | null;
  datasetUrl: string;
  title: string;
  summary: string;
  jurisdictionLabel: string | null;
  recordModified: string | null;
  recordReleased: string | null;
  publisher: string | null;
  formats: string[];
  keywords: string[];
}

export interface PortalSearchResponse {
  sourceUrl: string;
  query: string;
  page: number;
  sort: SortOption;
  totalRecords: number | null;
  pageSize: number;
  totalPages: number | null;
  results: PortalSearchResultItem[];
}

const DEFAULT_ROWS = 10;

const FACET_FIELD_MAP: Record<FilterGroupKey, string> = {
  owner_org: "organization",
  dataset_type: "dataset_type",
  collection: "collection",
  jurisdiction: "jurisdiction",
  keywords_en: "keywords_en",
  subject_en: "subject",
  resource_format: "res_format",
  frequency: "frequency",
  resource_type: "res_type",
  datastore_enabled: "datastore_active",
};

const FQ_KEY_MAP: Record<FilterGroupKey, string> = {
  owner_org: "organization",
  dataset_type: "dataset_type",
  collection: "collection",
  jurisdiction: "jurisdiction",
  keywords_en: "keywords_en",
  subject_en: "subject",
  resource_format: "res_format",
  frequency: "frequency",
  resource_type: "res_type",
  datastore_enabled: "datastore_active",
};

const JURISDICTION_LABELS: Record<string, string> = {
  federal: "Federal",
  provincial: "Provincial / Territorial",
  municipal: "Municipal",
  user: "User Submitted",
};

interface CatalogSearchResult {
  count: number;
  results: CatalogPackageSummary[];
  search_facets?: Record<string, { title: string; items: Array<{ name: string; display_name: string; count: number }> }>;
}

interface CatalogPackageSummary {
  id: string;
  name: string;
  title?: string;
  title_translated?: { en?: string; fr?: string };
  notes?: string;
  notes_translated?: { en?: string; fr?: string };
  metadata_modified?: string;
  metadata_created?: string;
  jurisdiction?: string;
  organization?: { title: string; name: string };
  resources?: Array<{ format?: string }>;
  keywords?: { en?: string[] };
  subject?: string[];
}

export async function getPortalFilters(options?: {
  query?: string;
  sort?: SortOption;
  filters?: SearchFilters;
}): Promise<{ url: string; groups: FilterGroup[] }> {
  const facetFields = FILTER_GROUPS.map((key) => FACET_FIELD_MAP[key]);
  const params = buildCatalogSearchParams({
    query: options?.query,
    page: 1,
    rows: 0,
    sort: options?.sort,
    filters: options?.filters,
    facetFields,
    facetLimit: 50,
  });

  const url = `${CATALOG_API_BASE_URL}/package_search?${params.toString()}`;
  const body = await fetchCatalogSearch(params);
  const groups = buildFilterGroupsFromFacets(body.search_facets ?? {}, options?.filters);

  return { url, groups };
}

export async function searchPortalDatasets(options?: {
  query?: string;
  page?: number;
  sort?: SortOption;
  filters?: SearchFilters;
}): Promise<PortalSearchResponse> {
  const page = options?.page ?? DEFAULT_PAGE;
  const rows = DEFAULT_ROWS;
  const params = buildCatalogSearchParams({
    query: options?.query,
    page,
    rows,
    sort: options?.sort,
    filters: options?.filters,
    facetFields: [],
    facetLimit: 0,
  });

  const url = `${CATALOG_API_BASE_URL}/package_search?${params.toString()}`;
  const body = await fetchCatalogSearch(params);
  const totalRecords = body.count;
  const results = body.results.map(normalizeCatalogResult);

  return {
    sourceUrl: url,
    query: options?.query ?? "",
    page,
    sort: options?.sort ?? DEFAULT_SORT,
    totalRecords,
    pageSize: results.length,
    totalPages: results.length > 0 ? Math.ceil(totalRecords / rows) : null,
    results,
  };
}

export function emptyFilters(): SearchFilters {
  const filters: SearchFilters = {};

  for (const group of FILTER_GROUPS) {
    filters[group] = [];
  }

  return filters;
}

function buildCatalogSearchParams(options: {
  query?: string | undefined;
  page: number;
  rows: number;
  sort?: SortOption | undefined;
  filters?: SearchFilters | undefined;
  facetFields: string[];
  facetLimit: number;
}): URLSearchParams {
  const params = new URLSearchParams();

  params.set("q", options.query ?? "");
  params.set("rows", String(options.rows));
  params.set("start", String((options.page - 1) * options.rows));

  if (options.sort) {
    params.set("sort", options.sort);
  }

  const fqParts = buildFqParts(options.filters);
  if (fqParts.length > 0) {
    params.set("fq", fqParts.join(" "));
  }

  if (options.facetFields.length > 0) {
    params.set("facet.field", JSON.stringify(options.facetFields));
    params.set("facet.limit", String(options.facetLimit));
  }

  return params;
}

function buildFqParts(filters?: SearchFilters): string[] {
  if (!filters) {
    return [];
  }

  const parts: string[] = [];

  for (const [key, values] of Object.entries(filters)) {
    if (!values || values.length === 0) {
      continue;
    }

    const fqKey = FQ_KEY_MAP[key as FilterGroupKey] ?? key;
    for (const value of values) {
      parts.push(`${fqKey}:${value}`);
    }
  }

  return parts;
}

async function fetchCatalogSearch(params: URLSearchParams): Promise<CatalogSearchResult> {
  const url = `${CATALOG_API_BASE_URL}/package_search?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "en",
    },
  });

  if (!response.ok) {
    throw new Error(`Catalog search request failed with ${response.status} ${response.statusText}`);
  }

  const envelope = (await response.json()) as { success: boolean; result?: CatalogSearchResult; error?: { message?: string } };
  if (!envelope.success || !envelope.result) {
    throw new Error(envelope.error?.message ?? "Catalog search failed");
  }

  return envelope.result;
}

function buildFilterGroupsFromFacets(
  facets: NonNullable<CatalogSearchResult["search_facets"]>,
  activeFilters?: SearchFilters,
): FilterGroup[] {
  const groups: FilterGroup[] = [];

  for (const filterKey of FILTER_GROUPS) {
    const facetKey = FACET_FIELD_MAP[filterKey];
    const facet = facets[facetKey];
    if (!facet) {
      continue;
    }

    const activeValues = new Set(activeFilters?.[filterKey] ?? []);
    const options: FilterOption[] = facet.items
      .filter((item) => item.count > 0 || activeValues.has(item.name))
      .map((item) => ({
        value: item.name,
        label: humanizeFacetLabel(filterKey, item.display_name, item.name),
        count: item.count,
        selected: activeValues.has(item.name),
      }));

    groups.push({
      heading: FILTER_TITLES[filterKey],
      param: filterKey,
      options,
      optionCount: options.length,
    });
  }

  return groups;
}

function humanizeFacetLabel(filterKey: FilterGroupKey, displayName: string, rawName: string): string {
  if (filterKey === "jurisdiction") {
    return JURISDICTION_LABELS[rawName] ?? normalizeWhitespace(displayName);
  }

  if (filterKey === "owner_org") {
    const english = displayName.split("|")[0];
    return english ? normalizeWhitespace(english) : normalizeWhitespace(displayName);
  }

  if (filterKey === "subject_en") {
    return normalizeWhitespace(rawName)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  return normalizeWhitespace(displayName) || normalizeWhitespace(rawName);
}

function normalizeCatalogResult(pkg: CatalogPackageSummary): PortalSearchResultItem {
  const title = firstNonEmpty(pkg.title_translated?.en, pkg.title, pkg.name);
  const summary = firstNonEmpty(pkg.notes_translated?.en, pkg.notes, "");
  const formats = uniqueFormats(pkg.resources ?? []);
  const keywords = pkg.keywords?.en ?? [];
  const jurisdictionLabel = pkg.jurisdiction ? (JURISDICTION_LABELS[pkg.jurisdiction] ?? pkg.jurisdiction) : null;
  const publisher = pkg.organization?.title
    ? normalizeWhitespace(pkg.organization.title.split("|")[0] ?? pkg.organization.title)
    : null;

  return {
    datasetId: pkg.id,
    datasetUrl: `https://open.canada.ca/data/en/dataset/${pkg.id}`,
    title: normalizeWhitespace(title),
    summary: normalizeWhitespace(summary),
    jurisdictionLabel,
    recordModified: pkg.metadata_modified ? pkg.metadata_modified.slice(0, 10) : null,
    recordReleased: pkg.metadata_created ? pkg.metadata_created.slice(0, 10) : null,
    publisher,
    formats,
    keywords,
  };
}

function uniqueFormats(resources: Array<{ format?: string }>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const resource of resources) {
    const format = normalizeWhitespace(resource.format ?? "");
    if (format && !seen.has(format.toUpperCase())) {
      seen.add(format.toUpperCase());
      result.push(format);
    }
  }

  return result;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value && normalizeWhitespace(value)) {
      return normalizeWhitespace(value);
    }
  }

  return "";
}
