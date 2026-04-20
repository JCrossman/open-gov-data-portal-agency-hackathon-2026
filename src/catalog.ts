import { CATALOG_API_BASE_URL } from "./constants.js";
import { extractDatasetIdentifier, normalizeWhitespace } from "./helpers.js";

interface CatalogEnvelope<T> {
  success: boolean;
  result?: T;
  error?: {
    message?: string;
  };
}

interface CatalogOrganization {
  id: string;
  name: string;
  title: string;
}

interface CatalogResource {
  id: string;
  name?: string;
  name_translated?: {
    en?: string;
    fr?: string;
  };
  description?: string | null;
  format?: string;
  url: string;
  url_type?: string | null;
  resource_type?: string;
  mimetype?: string | null;
  mimetype_inner?: string | null;
  character_set?: string;
  datastore_active?: boolean;
  datastore_contains_all_records_of_source_file?: boolean;
  date_published?: string;
  created?: string;
  last_modified?: string | null;
  metadata_modified?: string;
  state?: string;
}

interface CatalogPackage {
  id: string;
  name: string;
  title?: string;
  title_translated?: {
    en?: string;
    fr?: string;
  };
  notes?: string;
  notes_translated?: {
    en?: string;
    fr?: string;
  };
  collection?: string;
  frequency?: string;
  jurisdiction?: string;
  license_title?: string;
  license_url?: string;
  metadata_created?: string;
  metadata_modified?: string;
  portal_release_date?: string;
  date_published?: string;
  subject?: string[];
  keywords?: {
    en?: string[];
    fr?: string[];
  };
  organization?: CatalogOrganization;
  owner_org?: string;
  resources?: CatalogResource[];
}

export interface NormalizedResource {
  id: string;
  name: string;
  nameTranslated: {
    en: string | null;
    fr: string | null;
  };
  description: string | null;
  format: string | null;
  url: string;
  urlType: string | null;
  resourceType: string | null;
  mimeType: string | null;
  mimeTypeInner: string | null;
  characterSet: string | null;
  datastoreActive: boolean;
  datastoreContainsAllRecords: boolean;
  datePublished: string | null;
  created: string | null;
  lastModified: string | null;
  metadataModified: string | null;
  state: string | null;
}

export interface NormalizedDataset {
  id: string;
  name: string;
  title: string;
  titleTranslated: {
    en: string | null;
    fr: string | null;
  };
  description: string | null;
  descriptionTranslated: {
    en: string | null;
    fr: string | null;
  };
  collection: string | null;
  frequency: string | null;
  jurisdiction: string | null;
  licenseTitle: string | null;
  licenseUrl: string | null;
  metadataCreated: string | null;
  metadataModified: string | null;
  portalReleaseDate: string | null;
  datePublished: string | null;
  subjects: string[];
  keywords: {
    en: string[];
    fr: string[];
  };
  organization: {
    id: string | null;
    slug: string | null;
    title: string | null;
  };
  resources: NormalizedResource[];
}

export async function getDataset(datasetIdOrNameOrUrl: string): Promise<NormalizedDataset> {
  const id = extractDatasetIdentifier(datasetIdOrNameOrUrl);
  const result = await fetchCatalogAction<CatalogPackage>("package_show", { id });
  return normalizeDataset(result);
}

export function normalizeDataset(result: CatalogPackage): NormalizedDataset {
  return {
    id: result.id,
    name: result.name,
    title: firstNonEmpty(result.title_translated?.en, result.title, result.name),
    titleTranslated: {
      en: result.title_translated?.en ?? null,
      fr: result.title_translated?.fr ?? null,
    },
    description: firstNonEmpty(result.notes_translated?.en, result.notes, null),
    descriptionTranslated: {
      en: result.notes_translated?.en ?? null,
      fr: result.notes_translated?.fr ?? null,
    },
    collection: result.collection ?? null,
    frequency: result.frequency ?? null,
    jurisdiction: result.jurisdiction ?? null,
    licenseTitle: result.license_title ?? null,
    licenseUrl: result.license_url ?? null,
    metadataCreated: result.metadata_created ?? null,
    metadataModified: result.metadata_modified ?? null,
    portalReleaseDate: result.portal_release_date ?? null,
    datePublished: result.date_published ?? null,
    subjects: result.subject ?? [],
    keywords: {
      en: result.keywords?.en ?? [],
      fr: result.keywords?.fr ?? [],
    },
    organization: {
      id: result.organization?.id ?? result.owner_org ?? null,
      slug: result.organization?.name ?? null,
      title: result.organization?.title ?? null,
    },
    resources: (result.resources ?? []).map(normalizeResource),
  };
}

export function normalizeResource(resource: CatalogResource): NormalizedResource {
  const englishName = normalizeOptionalText(resource.name_translated?.en ?? resource.name ?? null);

  return {
    id: resource.id,
    name: englishName ?? resource.id,
    nameTranslated: {
      en: normalizeOptionalText(resource.name_translated?.en ?? null),
      fr: normalizeOptionalText(resource.name_translated?.fr ?? null),
    },
    description: normalizeOptionalText(resource.description ?? null),
    format: normalizeOptionalText(resource.format ?? null),
    url: resource.url,
    urlType: normalizeOptionalText(resource.url_type ?? null),
    resourceType: normalizeOptionalText(resource.resource_type ?? null),
    mimeType: normalizeOptionalText(resource.mimetype ?? null),
    mimeTypeInner: normalizeOptionalText(resource.mimetype_inner ?? null),
    characterSet: normalizeOptionalText(resource.character_set ?? null),
    datastoreActive: resource.datastore_active ?? false,
    datastoreContainsAllRecords: resource.datastore_contains_all_records_of_source_file ?? false,
    datePublished: normalizeOptionalText(resource.date_published ?? null),
    created: normalizeOptionalText(resource.created ?? null),
    lastModified: normalizeOptionalText(resource.last_modified ?? null),
    metadataModified: normalizeOptionalText(resource.metadata_modified ?? null),
    state: normalizeOptionalText(resource.state ?? null),
  };
}

export function resolveResource(dataset: NormalizedDataset, resourceIdOrName?: string): NormalizedResource {
  if (!resourceIdOrName) {
    if (dataset.resources.length === 1) {
      return dataset.resources[0]!;
    }

    throw new Error("Multiple resources are available. Provide resourceIdOrName to choose one.");
  }

  const exactById = dataset.resources.find((resource) => resource.id === resourceIdOrName);
  if (exactById) {
    return exactById;
  }

  const normalizedNeedle = normalizeWhitespace(resourceIdOrName).toLowerCase();
  const exactNameMatches = dataset.resources.filter((resource) => resource.name.toLowerCase() === normalizedNeedle);

  if (exactNameMatches.length === 1) {
    return exactNameMatches[0]!;
  }

  if (exactNameMatches.length > 1) {
    throw new Error("Multiple resources matched that name. Use an exact resource ID instead.");
  }

  throw new Error(`Resource ${resourceIdOrName} was not found in dataset ${dataset.id}.`);
}

async function fetchCatalogAction<T>(action: string, params: Record<string, string>): Promise<T> {
  const url = `${CATALOG_API_BASE_URL}/${action}?${new URLSearchParams(params).toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "en",
    },
  });

  if (!response.ok) {
    throw new Error(`Catalog API request failed with ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as CatalogEnvelope<T>;
  if (!body.success || body.result === undefined) {
    throw new Error(body.error?.message ?? `Catalog API action ${action} failed`);
  }

  return body.result;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (value && normalizeWhitespace(value)) {
      return normalizeWhitespace(value);
    }
  }

  return "";
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const normalized = normalizeWhitespace(value);
  return normalized || null;
}
