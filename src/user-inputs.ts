import { FILTER_GROUPS, FILTER_TITLES, type FilterGroupKey, type SearchFilters } from "./constants.js";
import { asArray, normalizeFilterGroupKey, normalizeWhitespace } from "./helpers.js";
import { getPortalFilters, type FilterGroup, type FilterOption } from "./portal.js";

const FILTER_CACHE_TTL_MS = 5 * 60 * 1000;

const FRIENDLY_GROUP_ALIASES: Array<[string, FilterGroupKey]> = [
  ["organization", "owner_org"],
  ["org", "owner_org"],
  ["publisher", "owner_org"],
  ["owner_org", "owner_org"],
  ["portal type", "dataset_type"],
  ["dataset type", "dataset_type"],
  ["type of dataset", "dataset_type"],
  ["dataset_type", "dataset_type"],
  ["collection", "collection"],
  ["collection type", "collection"],
  ["collection_type", "collection"],
  ["jurisdiction", "jurisdiction"],
  ["keywords", "keywords_en"],
  ["keyword", "keywords_en"],
  ["keywords_en", "keywords_en"],
  ["subject", "subject_en"],
  ["subject_en", "subject_en"],
  ["format", "resource_format"],
  ["formats", "resource_format"],
  ["resource_format", "resource_format"],
  ["update frequency", "frequency"],
  ["frequency", "frequency"],
  ["resource type", "resource_type"],
  ["resource_type", "resource_type"],
  ["api enabled", "datastore_enabled"],
  ["api-enabled", "datastore_enabled"],
  ["datastore enabled", "datastore_enabled"],
  ["datastore_enabled", "datastore_enabled"],
];

const FRIENDLY_SEARCH_FIELD_MAP = {
  organization: "owner_org",
  portalType: "dataset_type",
  collectionType: "collection",
  jurisdictionName: "jurisdiction",
  keyword: "keywords_en",
  subject: "subject_en",
  format: "resource_format",
  updateFrequency: "frequency",
  resourceTypeName: "resource_type",
  apiEnabled: "datastore_enabled",
} as const;

type FriendlyFieldKey = keyof typeof FRIENDLY_SEARCH_FIELD_MAP;

export interface FriendlySearchInputs {
  organization?: string | string[] | undefined;
  portalType?: string | string[] | undefined;
  collectionType?: string | string[] | undefined;
  jurisdictionName?: string | string[] | undefined;
  keyword?: string | string[] | undefined;
  subject?: string | string[] | undefined;
  format?: string | string[] | undefined;
  updateFrequency?: string | string[] | undefined;
  resourceTypeName?: string | string[] | undefined;
  apiEnabled?: string | string[] | undefined;
}

export interface AppliedFilterGroup {
  key: FilterGroupKey;
  title: string;
  labels: string[];
  values: string[];
}

export interface ResolvedSearchFilters {
  filters: SearchFilters;
  appliedGroups: AppliedFilterGroup[];
  unresolvedInputs: string[];
}

let filterGroupsCache: { expiresAt: number; groups: FilterGroup[] } | null = null;

export async function getPortalFilterDirectory(): Promise<FilterGroup[]> {
  const now = Date.now();
  if (filterGroupsCache && filterGroupsCache.expiresAt > now) {
    return filterGroupsCache.groups;
  }

  const { groups } = await getPortalFilters();
  filterGroupsCache = {
    expiresAt: now + FILTER_CACHE_TTL_MS,
    groups,
  };

  return groups;
}

export function resolveFilterGroupInput(input: string | undefined, groups?: readonly FilterGroup[]): FilterGroupKey | null {
  if (!input) {
    return null;
  }

  const normalizedInput = normalizeForMatch(input);
  const aliasMatch = FRIENDLY_GROUP_ALIASES.find(([alias]) => normalizeForMatch(alias) === normalizedInput);
  if (aliasMatch) {
    return aliasMatch[1];
  }

  const directMatch = normalizeFilterGroupKey(input);
  if (directMatch) {
    return directMatch;
  }

  if (!groups) {
    return null;
  }

  for (const group of groups) {
    if (normalizeForMatch(group.heading) === normalizedInput || normalizeForMatch(group.param) === normalizedInput) {
      return group.param;
    }
  }

  return null;
}

export async function resolveSearchFilters(options: {
  rawFilters?: SearchFilters | undefined;
  friendly?: FriendlySearchInputs | undefined;
}): Promise<ResolvedSearchFilters> {
  const groups = await getPortalFilterDirectory();
  const filters: SearchFilters = {};
  const appliedMap = new Map<FilterGroupKey, { labels: Set<string>; values: Set<string> }>();
  const unresolvedInputs: string[] = [];

  for (const groupKey of FILTER_GROUPS) {
    const rawValues = options.rawFilters?.[groupKey];
    if (!rawValues) {
      continue;
    }

    for (const rawValue of rawValues) {
      const matched = findBestOptionMatch(findGroup(groups, groupKey), rawValue);
      const resolvedValue = matched?.value ?? rawValue;
      const resolvedLabel = matched?.label ?? rawValue;
      addFilterValue(filters, groupKey, resolvedValue);
      addAppliedLabel(appliedMap, groupKey, resolvedLabel, resolvedValue);
    }
  }

  const friendlyEntries = Object.entries(FRIENDLY_SEARCH_FIELD_MAP) as Array<[FriendlyFieldKey, FilterGroupKey]>;

  for (const [friendlyField, groupKey] of friendlyEntries) {
    const rawFriendlyValues = options.friendly?.[friendlyField];
    if (rawFriendlyValues === undefined) {
      continue;
    }

    const requestedValues = asArray(rawFriendlyValues);
    const group = findGroup(groups, groupKey);

    for (const requestedValue of requestedValues) {
      const matched = findBestOptionMatch(group, requestedValue);
      if (!matched) {
        unresolvedInputs.push(`${friendlyField}: ${requestedValue}`);
        continue;
      }

      addFilterValue(filters, groupKey, matched.value);
      addAppliedLabel(appliedMap, groupKey, matched.label, matched.value);
    }
  }

  const appliedGroups: AppliedFilterGroup[] = FILTER_GROUPS.map((groupKey) => {
    const applied = appliedMap.get(groupKey);
    if (!applied || applied.values.size === 0) {
      return null;
    }

    return {
      key: groupKey,
      title: FILTER_TITLES[groupKey],
      labels: Array.from(applied.labels),
      values: Array.from(applied.values),
    };
  }).filter((value): value is AppliedFilterGroup => value !== null);

  return {
    filters,
    appliedGroups,
    unresolvedInputs,
  };
}

function findGroup(groups: readonly FilterGroup[], key: FilterGroupKey): FilterGroup {
  const group = groups.find((item) => item.param === key);
  if (!group) {
    throw new Error(`Filter group ${key} is not available in the current portal filter inventory.`);
  }

  return group;
}

function addFilterValue(filters: SearchFilters, groupKey: FilterGroupKey, value: string): void {
  const writableFilters = filters as Record<FilterGroupKey, string[] | undefined>;
  const existing = writableFilters[groupKey] ?? [];
  if (!existing.includes(value)) {
    existing.push(value);
  }
  writableFilters[groupKey] = existing;
}

function addAppliedLabel(
  appliedMap: Map<FilterGroupKey, { labels: Set<string>; values: Set<string> }>,
  groupKey: FilterGroupKey,
  label: string,
  value: string,
): void {
  const existing = appliedMap.get(groupKey) ?? {
    labels: new Set<string>(),
    values: new Set<string>(),
  };

  existing.labels.add(normalizeWhitespace(label));
  existing.values.add(value);
  appliedMap.set(groupKey, existing);
}

function findBestOptionMatch(group: FilterGroup, requestedValue: string): FilterOption | null {
  const normalizedRequested = normalizeForMatch(requestedValue);

  const exactMatch = group.options.find(
    (option) => normalizeForMatch(option.value) === normalizedRequested || normalizeForMatch(option.label) === normalizedRequested,
  );
  if (exactMatch) {
    return exactMatch;
  }

  const prefixMatches = group.options.filter(
    (option) => normalizeForMatch(option.label).startsWith(normalizedRequested) || normalizeForMatch(option.value).startsWith(normalizedRequested),
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0]!;
  }

  const containsMatches = group.options.filter(
    (option) => normalizeForMatch(option.label).includes(normalizedRequested) || normalizeForMatch(option.value).includes(normalizedRequested),
  );
  if (containsMatches.length === 1) {
    return containsMatches[0]!;
  }

  return null;
}

function normalizeForMatch(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
