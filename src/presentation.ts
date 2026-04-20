import { FILTER_TITLES, type FilterGroupKey } from "./constants.js";
import type { ChartPreparationResult, ResourceAnalysisResult, TableCellValue, TableRow } from "./analysis.js";
import type { NormalizedDataset, NormalizedResource } from "./catalog.js";
import type { DiscoveryTopicOverview } from "./discovery.js";
import { normalizeWhitespace } from "./helpers.js";
import type { GeoJsonMapResult } from "./mapping.js";
import type { FilterGroup, PortalSearchResponse } from "./portal.js";
import type { ResourceFetchResult } from "./resource-fetch.js";
import { selectRecommendedResource } from "./resource-selection.js";
import type { AppliedFilterGroup } from "./user-inputs.js";

const numberFormatter = new Intl.NumberFormat("en-US");

export function formatFilterOptionsText(options: {
  groups: FilterGroup[];
  selectedGroup?: FilterGroup | null | undefined;
  valueSearch?: string | undefined;
  limit?: number | undefined;
}): string {
  if (options.selectedGroup) {
    return formatSingleFilterGroupText(options.selectedGroup, options.valueSearch, options.limit ?? 20);
  }

  const lines = ["Open Government Portal filter groups", ""];

  for (const group of options.groups) {
    const examples = group.options.slice(0, 3).map((item) => item.label).join(", ");
    lines.push(`- ${group.heading} — ${formatCount(group.optionCount)} values. Examples: ${examples}`);
  }

  lines.push("");
  lines.push('To browse one group in detail, call this again with filterGroup set to something like "Organization", "Format", or "Subject".');
  return lines.join("\n");
}

export function formatSearchResultsText(options: {
  result: PortalSearchResponse;
  appliedFilters: AppliedFilterGroup[];
  unresolvedInputs: string[];
}): string {
  const { result, appliedFilters, unresolvedInputs } = options;
  const lines = ["Open Government Portal search results", ""];

  if (result.query) {
    lines.push(`Query: "${result.query}"`);
  }

  lines.push(
    `Found ${result.totalRecords !== null ? formatCount(result.totalRecords) : "an unknown number of"} records. Showing page ${result.page}${result.totalPages ? ` of ${result.totalPages}` : ""}. Sorted by ${formatSortLabel(result.sort)}.`,
  );

  if (appliedFilters.length > 0) {
    lines.push(`Active filters: ${appliedFilters.map((group) => `${group.title}: ${group.labels.join(", ")}`).join("; ")}`);
  }

  if (unresolvedInputs.length > 0) {
    lines.push(`I could not match these requested filters exactly: ${unresolvedInputs.join("; ")}`);
  }

  if (result.results.length === 0) {
    lines.push("");
    lines.push("No datasets were returned on this page.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Top results on this page:");

  for (const [index, item] of result.results.slice(0, 5).entries()) {
    lines.push(`${index + 1}. ${item.title}`);

    const metaParts = [
      item.publisher ? `Publisher: ${item.publisher}` : null,
      item.recordModified ? `Modified: ${item.recordModified}` : null,
      item.recordReleased ? `Released: ${item.recordReleased}` : null,
      item.jurisdictionLabel ? `Jurisdiction: ${item.jurisdictionLabel}` : null,
    ].filter((value): value is string => value !== null);
    if (metaParts.length > 0) {
      lines.push(`   ${metaParts.join(" | ")}`);
    }

    if (item.formats.length > 0) {
      lines.push(`   Formats: ${item.formats.join(", ")}`);
    }

    if (item.summary) {
      lines.push(`   Summary: ${truncateText(item.summary, 180)}`);
    }

    lines.push(`   Dataset URL: ${item.datasetUrl}`);
  }

  if (result.results.length > 5) {
    lines.push("");
    lines.push(`Only the first 5 results are shown here; the page contains ${result.results.length} results.`);
  }

  lines.push("");
  lines.push("Next useful actions: pass one of the dataset URLs to get_dataset, or narrow the search with organization, format, subject, keyword, or jurisdiction.");
  return lines.join("\n");
}

export function formatDatasetText(dataset: NormalizedDataset): string {
  const lines = [`Dataset: ${dataset.title}`, ""];

  lines.push(`Publisher: ${dataset.organization.title ?? "Unknown publisher"}`);

  const metaParts = [
    dataset.collection ? `Collection: ${humanizeValue(dataset.collection)}` : null,
    dataset.jurisdiction ? `Jurisdiction: ${humanizeValue(dataset.jurisdiction)}` : null,
    dataset.frequency ? `Update frequency: ${humanizeValue(dataset.frequency)}` : null,
  ].filter((value): value is string => value !== null);

  if (metaParts.length > 0) {
    lines.push(metaParts.join(" | "));
  }

  const dateParts = [
    dataset.metadataModified ? `Metadata updated: ${dataset.metadataModified}` : null,
    dataset.portalReleaseDate ? `Portal release date: ${dataset.portalReleaseDate}` : null,
    dataset.datePublished ? `Date published: ${dataset.datePublished}` : null,
  ].filter((value): value is string => value !== null);

  if (dateParts.length > 0) {
    lines.push(dateParts.join(" | "));
  }

  if (dataset.subjects.length > 0) {
    lines.push(`Subjects: ${dataset.subjects.slice(0, 6).map(humanizeValue).join(", ")}`);
  }

  if (dataset.keywords.en.length > 0) {
    lines.push(`Keywords: ${dataset.keywords.en.slice(0, 8).join(", ")}`);
  }

  if (dataset.description) {
    lines.push("");
    lines.push(`Summary: ${truncateText(dataset.description, 500)}`);
  }

  lines.push("");
  lines.push(`Resources: ${formatCount(dataset.resources.length)}`);

  const recommendation = selectRecommendedResource(dataset.resources);
  if (recommendation) {
    lines.push(
      `Recommended first resource: ${recommendation.name}${recommendation.format ? ` (${recommendation.format})` : ""}${recommendation.datastoreActive ? " — DataStore enabled" : ""}`,
    );
  }

  if (dataset.resources.length > 0) {
    const preview = dataset.resources
      .slice(0, 3)
      .map((resource) => `${resource.id}: ${resource.name}${resource.format ? ` (${resource.format})` : ""}`)
      .join("\n");
    lines.push("");
    lines.push("Resource IDs you can inspect next:");
    lines.push(preview);
  }

  return lines.join("\n");
}

export function formatResourcesText(dataset: Pick<NormalizedDataset, "title" | "resources">): string {
  const lines = [`Resources for ${dataset.title}`, ""];

  if (dataset.resources.length === 0) {
    lines.push("This dataset has no listed resources.");
    return lines.join("\n");
  }

  lines.push(`Total resources: ${formatCount(dataset.resources.length)}`);

  const recommendation = selectRecommendedResource(dataset.resources);
  if (recommendation) {
    lines.push(
      `Recommended first resource: ${recommendation.name}${recommendation.format ? ` (${recommendation.format})` : ""}${recommendation.datastoreActive ? " — DataStore enabled" : ""}`,
    );
  }

  lines.push("");

  for (const [index, resource] of dataset.resources.slice(0, 8).entries()) {
    const details = [
      resource.format,
      resource.resourceType ? `type ${resource.resourceType}` : null,
      resource.datastoreActive ? "DataStore enabled" : null,
    ].filter((value): value is string => value !== null);

    lines.push(`${index + 1}. ${resource.name}`);
    lines.push(`   ID: ${resource.id}`);
    if (details.length > 0) {
      lines.push(`   ${details.join(" | ")}`);
    }
    lines.push(`   URL: ${resource.url}`);
  }

  if (dataset.resources.length > 8) {
    lines.push("");
    lines.push(`Only the first 8 resources are shown here.`);
  }

  return lines.join("\n");
}

export function formatResourcePreviewText(options: {
  datasetTitle: string | null;
  resource: {
    id: string | null;
    name: string | null;
    format: string | null;
    resourceType: string | null;
    url: string;
    mimeType: string | null;
    datastoreActive: boolean;
  };
  preview: ResourceFetchResult;
}): string {
  const { datasetTitle, resource, preview } = options;
  const lines = [
    resource.name ? `⚠️ SAMPLE PREVIEW: ${resource.name}` : "⚠️ Sample preview",
    "This is a small sample of the data, not the full resource. Use download_resource for the complete file, or analyze_dataset for full analysis.",
    "",
  ];

  if (datasetTitle) {
    lines.push(`Dataset: ${datasetTitle}`);
  }

  const metaParts = [
    resource.id ? `ID: ${resource.id}` : null,
    resource.format ? `Format: ${resource.format}` : null,
    resource.resourceType ? `Resource type: ${resource.resourceType}` : null,
    resource.datastoreActive ? "DataStore enabled" : null,
  ].filter((value): value is string => value !== null);

  if (metaParts.length > 0) {
    lines.push(metaParts.join(" | "));
  }

  lines.push(`URL: ${preview.finalUrl}`);

  if (!preview.fetchedDirectly) {
    lines.push("");
    lines.push(preview.directFetchReason);
    lines.push("Try a CSV, JSON, XML, GeoJSON, or TXT resource if you want an inline preview.");
    return lines.join("\n");
  }

  const sizeKB = Math.round(preview.bytesRead / 1024);
  lines.push("");
  lines.push(
    `Sample size: ${sizeKB} KB${preview.previewTruncated ? " (the full resource is larger — this is only a preview)" : " (small resource — this may be the complete file)"}${preview.contentType ? ` | Content type: ${preview.contentType}` : ""}`,
  );

  const visiblePreview = truncateText(preview.previewText ?? "", 1500);
  if (visiblePreview) {
    lines.push("");
    lines.push("Sample data:");
    lines.push("```");
    lines.push(visiblePreview);
    lines.push("```");
  }

  return lines.join("\n");
}

export function formatAnalysisText(result: ResourceAnalysisResult): string {
  const lines = [
    result.dataset?.title ? `Dataset analysis: ${result.dataset.title}` : `Resource analysis: ${result.resource.name ?? result.resource.url}`,
    "",
  ];

  if (result.dataset?.title) {
    lines.push(`Dataset: ${result.dataset.title}`);
  }

  lines.push(`Resource: ${result.resource.name ?? result.resource.url}`);
  lines.push(
    [
      result.resource.format ? `Format: ${result.resource.format}` : null,
      `Detected format: ${result.analysis.detectedFormat.toUpperCase()}`,
      `Rows analyzed: ${formatCount(result.analysis.rowCount)}`,
      `Columns: ${formatCount(result.analysis.columnCount)}`,
    ].filter((value): value is string => value !== null).join(" | "),
  );
  lines.push(`Scope: ${result.scope.completeness === "complete_resource" ? "complete fetched content" : "sampled preview"}`);

  if (result.selectionNote) {
    lines.push(result.selectionNote);
  }

  const timeFields = result.analysis.columns.filter((column) => column.semanticRole === "time").map((column) => column.name);
  const measureFields = result.analysis.columns.filter((column) => column.semanticRole === "measure").map((column) => column.name);
  const geographyFields = result.analysis.columns.filter((column) => column.semanticRole === "geography").map((column) => column.name);
  const categoryFields = result.analysis.columns.filter((column) => column.semanticRole === "category").map((column) => column.name);

  lines.push("");
  lines.push("Best candidate fields:");
  lines.push(`- Time: ${formatFieldList(timeFields)}`);
  lines.push(`- Measures: ${formatFieldList(measureFields)}`);
  lines.push(`- Geography: ${formatFieldList(geographyFields)}`);
  lines.push(`- Categories: ${formatFieldList(categoryFields)}`);

  lines.push("");
  lines.push("Column summary:");
  for (const column of result.analysis.columns.slice(0, 8)) {
    lines.push(`- ${formatColumnSummary(column)}`);
  }

  if (result.analysis.columns.length > 8) {
    lines.push(`- ${formatCount(result.analysis.columns.length - 8)} more columns are available in the structured output.`);
  }

  if (result.analysis.suggestions.length > 0) {
    lines.push("");
    lines.push("Suggested visualizations:");
    for (const [index, suggestion] of result.analysis.suggestions.entries()) {
      lines.push(`${index + 1}. ${suggestion.title} (${suggestion.chartType}) — ${suggestion.reasoning}`);
    }
  }

  if (result.analysis.sampleRows.length > 0) {
    lines.push("");
    lines.push("Sample rows:");
    lines.push(formatMarkdownTable(result.analysis.sampleRows, {
      columns: chooseDisplayColumns(result.analysis.sampleRows),
      maxRows: 3,
    }));
  }

  const warnings = [result.scope.note, ...result.analysis.warnings];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Caveats:");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

export function formatChartText(result: ChartPreparationResult): string {
  const lines = [`Chart preparation: ${result.chart.title}`, ""];

  if (result.dataset?.title) {
    lines.push(`Dataset: ${result.dataset.title}`);
  }

  lines.push(`Resource: ${result.resource.name ?? result.resource.url}`);
  lines.push(
    [
      `Chart type: ${humanizeValue(result.chart.chartType)}`,
      `X field: ${result.chart.xField}`,
      `Y field: ${result.chart.yField}`,
      result.chart.groupField ? `Group field: ${result.chart.groupField}` : null,
      `Aggregation: ${humanizeValue(result.chart.aggregation)}`,
    ].filter((value): value is string => value !== null).join(" | "),
  );
  lines.push(`Data points returned: ${formatCount(result.chart.pointCount)} | Scope: ${result.scope.completeness === "complete_resource" ? "complete fetched content" : "sampled preview"}`);

  if (result.selectionNote) {
    lines.push(result.selectionNote);
  }

  lines.push("");
  lines.push(`Why this chart: ${result.chart.reasoning}`);

  if (result.chart.points.length > 0) {
    lines.push("");
    lines.push("Chart data preview:");
    lines.push(
      formatMarkdownTable(result.chart.points, {
        columns: [
          result.chart.xField,
          ...(result.chart.groupField ? [result.chart.groupField] : []),
          result.chart.yField,
        ],
        maxRows: 12,
      }),
    );

    if (result.chart.pointCount > 12) {
      lines.push("");
      lines.push(`Only the first 12 points are shown here; the structured output contains ${formatCount(result.chart.pointCount)} points.`);
    }
  }

  const warnings = [result.scope.note, ...result.analysis.warnings, ...result.chart.warnings];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Caveats:");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

export function formatMapText(result: GeoJsonMapResult): string {
  const lines = [`Map preparation: ${result.map.title}`, ""];

  if (result.dataset?.title) {
    lines.push(`Dataset: ${result.dataset.title}`);
  }

  lines.push(`Resource: ${result.resource.name ?? result.resource.url}`);
  lines.push(
    [
      `Map type: ${humanizeMapKind(result.map.mapType)}`,
      `Geometry: ${result.map.geometryTypes.join(", ") || "Unknown"}`,
      `Features returned: ${formatCount(result.map.returnedFeatureCount)} of ${formatCount(result.map.featureCount)}`,
      result.map.labelField ? `Label field: ${result.map.labelField}` : null,
      result.map.valueField ? `Value field: ${result.map.valueField}` : null,
    ].filter((value): value is string => value !== null).join(" | "),
  );

  if (result.map.boundingBox) {
    lines.push(
      `Bounding box: west ${formatCoordinate(result.map.boundingBox[0])}, south ${formatCoordinate(result.map.boundingBox[1])}, east ${formatCoordinate(result.map.boundingBox[2])}, north ${formatCoordinate(result.map.boundingBox[3])}`,
    );
  }

  if (result.selectionNote) {
    lines.push(result.selectionNote);
  }

  lines.push("");
  lines.push(`Why this map: ${result.map.reasoning}`);

  const geographyFields = result.analysis.columns.filter((column) => column.semanticRole === "geography").map((column) => column.name);
  const measureFields = result.analysis.columns.filter((column) => column.semanticRole === "measure").map((column) => column.name);
  lines.push("");
  lines.push(`Candidate geography fields: ${formatFieldList(geographyFields)}`);
  lines.push(`Candidate value fields: ${formatFieldList(measureFields)}`);

  if (result.map.previewRows.length > 0) {
    lines.push("");
    lines.push("Feature preview:");
    lines.push(
      formatMarkdownTable(result.map.previewRows, {
        columns: chooseDisplayColumns(result.map.previewRows),
        maxRows: 6,
      }),
    );
  }

  const warnings = [result.scope.note, ...result.map.warnings];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Caveats:");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

export function formatDiscoveryText(overview: DiscoveryTopicOverview): string {
  const lines = [`Discovery overview: ${overview.topic}`, ""];

  // Open data section
  lines.push("## Open Government Data Catalog");
  if (overview.openData.totalRecords !== null && overview.openData.totalRecords > 0) {
    lines.push(`Found ${formatCount(overview.openData.totalRecords)} datasets matching "${overview.topic}".`);
  } else {
    lines.push(`No open-data datasets matched "${overview.topic}".`);
  }

  if (overview.openData.topPublishers.length > 0) {
    lines.push(`Top publishers: ${overview.openData.topPublishers.join(", ")}`);
  }

  if (overview.openData.topSubjects.length > 0) {
    lines.push(`Related subjects: ${overview.openData.topSubjects.join(", ")}`);
  }

  if (overview.openData.topFormats.length > 0) {
    lines.push(`Available formats: ${overview.openData.topFormats.join(", ")}`);
  }

  if (overview.openData.chartFriendlyFormats.length > 0) {
    lines.push(`Chart-friendly formats: ${overview.openData.chartFriendlyFormats.join(", ")}`);
  }

  if (overview.openData.mapFriendlyFormats.length > 0) {
    lines.push(`Map-friendly formats: ${overview.openData.mapFriendlyFormats.join(", ")}`);
  }

  if (overview.openData.representativeDatasets.length > 0) {
    lines.push("");
    lines.push("Representative datasets:");
    for (const [index, dataset] of overview.openData.representativeDatasets.entries()) {
      lines.push(`${index + 1}. ${dataset.title}`);
      const metaParts = [
        dataset.publisher ? `Publisher: ${dataset.publisher}` : null,
        dataset.formats.length > 0 ? `Formats: ${dataset.formats.join(", ")}` : null,
        dataset.goodFor.length > 0 ? `Good for: ${dataset.goodFor.join(", ")}` : null,
      ].filter((value): value is string => value !== null);
      if (metaParts.length > 0) {
        lines.push(`   ${metaParts.join(" | ")}`);
      }
      if (dataset.summary) {
        lines.push(`   ${truncateText(dataset.summary, 160)}`);
      }
      lines.push(`   URL: ${dataset.datasetUrl}`);
    }
  }

  // Proactive disclosure section
  lines.push("");
  lines.push("## Proactive Disclosure Sources");
  if (overview.proactiveDisclosure.matchingSources.length > 0) {
    lines.push(`Found ${formatCount(overview.proactiveDisclosure.matchingSources.length)} relevant proactive disclosure source(s):`);
    for (const [index, source] of overview.proactiveDisclosure.matchingSources.entries()) {
      lines.push(`${index + 1}. ${source.title}${source.recordCount ? ` (${source.recordCount} records)` : ""}`);
      lines.push(`   ${source.description}`);
      lines.push(`   Search: ${source.searchUrl}`);
    }
  } else {
    lines.push(`No proactive disclosure sources directly matched "${overview.topic}".`);
    lines.push("Proactive disclosure covers contracts, grants, travel, hospitality, briefings, and more — try a broader or spending-related topic to find those sources.");
  }

  // Next steps
  if (overview.suggestedNextSteps.length > 0) {
    lines.push("");
    lines.push("Suggested next steps:");
    for (const step of overview.suggestedNextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export function formatInvalidFilterGroupText(filterGroup: string): string {
  const availableGroups = Object.values(FILTER_TITLES).join(", ");
  return `I couldn't match the filter group "${filterGroup}". Available groups are: ${availableGroups}.`;
}

function formatSingleFilterGroupText(group: FilterGroup, valueSearch: string | undefined, limit: number): string {
  const narrowed = valueSearch
    ? group.options.filter((option) => normalizeForMatch(option.label).includes(normalizeForMatch(valueSearch)) || normalizeForMatch(option.value).includes(normalizeForMatch(valueSearch)))
    : group.options;
  const visibleOptions = narrowed.slice(0, limit);
  const lines = [`${group.heading} filter values`, ""];

  lines.push(
    `Showing ${formatCount(visibleOptions.length)} of ${formatCount(narrowed.length)} matching values${valueSearch ? ` for "${valueSearch}"` : ""}.`,
  );
  lines.push("");

  for (const [index, option] of visibleOptions.entries()) {
    lines.push(`${index + 1}. ${option.label}${option.count !== null ? ` (${formatCount(option.count)})` : ""}`);
  }

  if (visibleOptions.length < narrowed.length) {
    lines.push("");
    lines.push("More values are available. Increase the limit or narrow the list with valueSearch.");
  }

  return lines.join("\n");
}


function formatSortLabel(value: string): string {
  const labels: Record<string, string> = {
    "score desc": "Best Match",
    "metadata_modified desc": "Updated",
    "metadata_created desc": "Created",
    "title_translated_eng asc": "Title (A-Z)",
    "title_translated_eng desc": "Title (Z-A)",
  };

  return labels[value] ?? value;
}

function formatColumnSummary(column: ResourceAnalysisResult["analysis"]["columns"][number]): string {
  const parts = [`${column.inferredType} / ${column.semanticRole}`, `${formatCount(column.nonNullCount)} non-null`];

  if (column.numberSummary) {
    parts.push(
      `Range ${formatNumber(column.numberSummary.min)} to ${formatNumber(column.numberSummary.max)}; mean ${formatNumber(column.numberSummary.mean)}`,
    );
  } else if (column.dateSummary) {
    parts.push(`Range ${column.dateSummary.earliest} to ${column.dateSummary.latest}`);
  } else if (column.examples.length > 0) {
    parts.push(`Examples: ${column.examples.join(", ")}`);
  }

  return `${column.name} — ${parts.join(". ")}`;
}

function humanizeMapKind(value: GeoJsonMapResult["map"]["mapType"]): string {
  const labels: Record<GeoJsonMapResult["map"]["mapType"], string> = {
    point: "Point map",
    choropleth: "Choropleth map",
    boundary: "Boundary map",
    line: "Line map",
    mixed: "Mixed-geometry map",
  };

  return labels[value];
}

function formatFieldList(values: string[]): string {
  if (values.length === 0) {
    return "None detected";
  }

  return values.slice(0, 4).join(", ");
}

function chooseDisplayColumns(rows: TableRow[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
      if (columns.length >= 4) {
        return columns;
      }
    }
  }

  return columns;
}

function formatMarkdownTable(
  rows: TableRow[],
  options: {
    columns: string[];
    maxRows: number;
  },
): string {
  const visibleRows = rows.slice(0, options.maxRows);
  const columns = options.columns.filter((column) => column.length > 0);

  if (visibleRows.length === 0 || columns.length === 0) {
    return "_No rows available._";
  }

  const header = `| ${columns.map(escapeMarkdownCell).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = visibleRows.map((row) => `| ${columns.map((column) => escapeMarkdownCell(formatCellValue(row[column] ?? null))).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function formatCellValue(value: TableCellValue): string {
  if (value === null) {
    return "";
  }

  if (typeof value === "number") {
    return formatNumber(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return truncateText(value, 60);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? numberFormatter.format(value) : value.toFixed(3).replace(/\.?0+$/, "");
}

function formatCoordinate(value: number): string {
  return value.toFixed(4);
}

function humanizeValue(value: string): string {
  return normalizeWhitespace(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeForMatch(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function formatCount(value: number): string {
  return numberFormatter.format(value);
}
