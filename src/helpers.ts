import {
  DEFAULT_PAGE,
  DEFAULT_SORT,
  type FilterGroupKey,
  type SearchFilters,
  SORT_OPTIONS,
  STRUCTURED_TEXT_FORMATS,
  STRUCTURED_TEXT_MIME_SNIPPETS,
  type SortOption,
  PORTAL_SEARCH_URL,
} from "./constants.js";

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isSortOption(value: string): value is SortOption {
  return (SORT_OPTIONS as readonly string[]).includes(value);
}

export function buildPortalSearchUrl(options?: {
  query?: string;
  page?: number;
  sort?: SortOption;
  filters?: SearchFilters;
}): string {
  const params = new URLSearchParams();

  params.set("wbdisable", "true");
  params.set("search_text", options?.query ?? "");
  params.set("page", String(options?.page ?? DEFAULT_PAGE));
  params.set("sort", options?.sort ?? DEFAULT_SORT);

  for (const [key, values] of Object.entries(options?.filters ?? {})) {
    if (!values || values.length === 0) {
      continue;
    }

    params.set(key, values.join("|"));
  }

  return `${PORTAL_SEARCH_URL}?${params.toString()}`;
}

export function extractDatasetIdentifier(value: string): string {
  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/dataset\/([^/?#]+)/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Fall through to raw value handling.
  }

  return trimmed;
}

export function normalizeFilterGroupKey(value: string): FilterGroupKey | null {
  return (([
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
  ] as const).find((item) => item === value) ?? null);
}

export function isStructuredTextResource(format?: string | null, mimeType?: string | null, url?: string | null): boolean {
  const normalizedFormat = normalizeWhitespace(format ?? "").toUpperCase();
  if (normalizedFormat && STRUCTURED_TEXT_FORMATS.has(normalizedFormat)) {
    return true;
  }

  const normalizedMime = (mimeType ?? "").toLowerCase();
  if (normalizedMime) {
    for (const snippet of STRUCTURED_TEXT_MIME_SNIPPETS) {
      if (normalizedMime.includes(snippet)) {
        return true;
      }
    }
  }

  const pathname = url ? safePathname(url) : "";
  const extension = pathname.includes(".") ? pathname.split(".").pop()?.toLowerCase() ?? "" : "";

  return new Set([
    "csv",
    "json",
    "jsonl",
    "xml",
    "txt",
    "geojson",
    "rdf",
    "rss",
    "html",
    "htm",
    "sql",
  ]).has(extension);
}

function safePathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

