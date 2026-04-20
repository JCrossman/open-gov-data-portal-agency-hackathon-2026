export const PORTAL_SEARCH_URL = "https://search.open.canada.ca/opendata/";
export const CATALOG_API_BASE_URL = "https://open.canada.ca/data/api/action";

export const SORT_OPTIONS = [
  "score desc",
  "metadata_modified desc",
  "metadata_created desc",
  "title_translated_eng asc",
  "title_translated_eng desc",
] as const;

export type SortOption = (typeof SORT_OPTIONS)[number];

export const DEFAULT_SORT: SortOption = "score desc";
export const DEFAULT_PAGE = 1;
export const DEFAULT_PREVIEW_MAX_BYTES = 50_000;
export const DEFAULT_PREVIEW_MAX_CHARS = 5_000;
export const DEFAULT_MAX_BYTES = 200_000;
export const DEFAULT_MAX_CHARS = 20_000;
export const DEFAULT_ANALYSIS_MAX_BYTES = 10_000_000;
export const DEFAULT_ANALYSIS_MAX_ROWS = 5_000;
export const DEFAULT_SAMPLE_ROW_COUNT = 5;
export const DEFAULT_CHART_POINT_LIMIT = 200;
export const DEFAULT_TOP_N = 10;
export const DEFAULT_MAP_MAX_BYTES = 20_000_000;
export const DEFAULT_MAP_FEATURE_LIMIT = 25;
export const DEFAULT_DOWNLOAD_MAX_BYTES = 50_000_000;

// DataStore resource IDs for proactive disclosure and T3010 data
export const CONTRACTS_MAIN_RESOURCE_ID = "fac950c0-00d5-4ec1-a4d3-9cbebf98a305";
export const CONTRACTS_LEGACY_RESOURCE_ID = "7f9b18ca-f627-4852-93d5-69adeb9437d6";
export const GRANTS_RESOURCE_ID = "1d15a62f-5656-49ad-8c88-f40ce689d831";

export const T3010_IDENTIFICATION_RESOURCE_ID = "694fdc72-eae4-4ee0-83eb-832ab7b230e3";
export const T3010_FINANCIAL_RESOURCE_ID = "e545170c-3689-4833-b2a8-e9e83100ab59";
export const T3010_DIRECTORS_RESOURCE_ID = "3eb35dcd-9b0c-4ae9-a45c-e5e481567c23";
export const T3010_QUALIFIED_DONEES_RESOURCE_ID = "e945d3ac-ce8c-40c9-a322-47f477d6a8de";
export const T3010_COMPENSATION_RESOURCE_ID = "37fe5088-b30c-4713-9a42-5a3e7e08fcb0";
export const T3010_GENERAL_INFO_RESOURCE_ID = "fd7c8679-8032-4613-b2b7-44fb8bc9c7c9";
export const T3010_PROGRAMS_RESOURCE_ID = "1f16eb1b-cc03-4c95-a81c-0fdc0722c5ee";
export const T3010_NON_QUALIFIED_DONEES_RESOURCE_ID = "f4eb196a-d0c1-45b0-bc48-e9b48c06cbce";
export const WRONGDOING_RESOURCE_ID = "4e4db232-f5e8-43c7-b8b2-439eb7d55475";

export const CHART_TYPES = [
  "auto",
  "line",
  "bar",
  "scatter",
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

export const AGGREGATION_OPTIONS = [
  "auto",
  "sum",
  "avg",
  "count",
] as const;

export type AggregationOption = (typeof AGGREGATION_OPTIONS)[number];

export const FILTER_GROUPS = [
  "owner_org",
  "dataset_type",
  "collection",
  "jurisdiction",
  "keywords_en",
  "subject_en",
  "resource_format",
  "frequency",
  "resource_type",
  "datastore_enabled",
] as const;

export type FilterGroupKey = (typeof FILTER_GROUPS)[number];

export type SearchFilters = {
  owner_org?: string[] | undefined;
  dataset_type?: string[] | undefined;
  collection?: string[] | undefined;
  jurisdiction?: string[] | undefined;
  keywords_en?: string[] | undefined;
  subject_en?: string[] | undefined;
  resource_format?: string[] | undefined;
  frequency?: string[] | undefined;
  resource_type?: string[] | undefined;
  datastore_enabled?: ("True" | "False")[] | undefined;
};

export const FILTER_TITLES: Record<FilterGroupKey, string> = {
  owner_org: "Organization",
  dataset_type: "Portal Type",
  collection: "Collection Type",
  jurisdiction: "Jurisdiction",
  keywords_en: "Keywords",
  subject_en: "Subject",
  resource_format: "Format",
  frequency: "Update Frequency",
  resource_type: "Resource Type",
  datastore_enabled: "API enabled",
};

export const STRUCTURED_TEXT_FORMATS = new Set([
  "CSV",
  "JSON",
  "JSONL",
  "XML",
  "TXT",
  "GEOJSON",
  "RDF",
  "RSS",
  "SQL",
  "HTML",
  "WMS",
  "WFS",
  "WCS",
  "ESRI REST",
]);

export const STRUCTURED_TEXT_MIME_SNIPPETS = [
  "application/json",
  "application/geo+json",
  "application/ld+json",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/rdf+xml",
  "application/sql",
  "text/",
];
