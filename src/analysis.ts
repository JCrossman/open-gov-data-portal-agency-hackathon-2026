import { parse as parseCsv } from "csv-parse/sync";
import type { NormalizedResource } from "./catalog.js";
import { getDataset, resolveResource } from "./catalog.js";
import {
  DEFAULT_ANALYSIS_MAX_BYTES,
  DEFAULT_ANALYSIS_MAX_ROWS,
  DEFAULT_CHART_POINT_LIMIT,
  DEFAULT_SAMPLE_ROW_COUNT,
  DEFAULT_TOP_N,
  type AggregationOption,
  type ChartType,
} from "./constants.js";
import { normalizeWhitespace } from "./helpers.js";
import { fetchResourcePreview } from "./resource-fetch.js";
import { selectRecommendedResource } from "./resource-selection.js";

export type TableCellValue = string | number | boolean | null;
export type TableRow = Record<string, TableCellValue>;

type SupportedAnalysisFormat = "csv" | "json" | "geojson";
type InferredType = "number" | "date" | "boolean" | "string";
type SemanticRole = "measure" | "time" | "category" | "geography" | "identifier";
type ComputedAggregation = "sum" | "avg" | "count" | "none";

export interface AnalysisColumn {
  name: string;
  inferredType: InferredType;
  semanticRole: SemanticRole;
  nonNullCount: number;
  nullCount: number;
  distinctCount: number;
  examples: string[];
  numberSummary?: {
    min: number;
    max: number;
    mean: number;
  } | undefined;
  dateSummary?: {
    earliest: string;
    latest: string;
  } | undefined;
}

export interface ChartSuggestion {
  chartType: Exclude<ChartType, "auto">;
  title: string;
  xField: string;
  yField: string | null;
  reasoning: string;
}

export interface StructuredTableAnalysis {
  detectedFormat: SupportedAnalysisFormat;
  rowCount: number;
  columnCount: number;
  columns: AnalysisColumn[];
  sampleRows: TableRow[];
  suggestions: ChartSuggestion[];
  warnings: string[];
  rows: TableRow[];
}

export interface AnalysisDataset {
  id: string | null;
  title: string | null;
  url: string | null;
}

export interface AnalysisResource {
  id: string | null;
  name: string | null;
  format: string | null;
  resourceType: string | null;
  url: string;
  mimeType: string | null;
  datastoreActive: boolean;
  selectedAutomatically: boolean;
}

export interface AnalysisScope {
  maxBytes: number;
  bytesRead: number;
  contentType: string | null;
  completeness: "complete_resource" | "sampled_preview";
  note: string;
}

export interface ResourceAnalysisResult {
  dataset: AnalysisDataset | null;
  resource: AnalysisResource;
  selectionNote: string | null;
  scope: AnalysisScope;
  analysis: Omit<StructuredTableAnalysis, "rows">;
}

export interface PreparedChart {
  chartType: Exclude<ChartType, "auto">;
  title: string;
  xField: string;
  yField: string;
  sourceYField: string | null;
  groupField: string | null;
  aggregation: ComputedAggregation;
  reasoning: string;
  pointCount: number;
  points: TableRow[];
  warnings: string[];
  vegaLiteSpec: Record<string, unknown>;
}

export interface ChartPreparationResult extends ResourceAnalysisResult {
  chart: PreparedChart;
}

export interface AnalyzeDatasetResourceOptions {
  datasetIdOrNameOrUrl?: string | undefined;
  resourceIdOrName?: string | undefined;
  resourceUrl?: string | undefined;
  maxBytes?: number | undefined;
  maxRows?: number | undefined;
}

export interface PrepareDatasetChartOptions extends AnalyzeDatasetResourceOptions {
  chartGoal?: string | undefined;
  chartType?: ChartType | undefined;
  xField?: string | undefined;
  yField?: string | undefined;
  groupField?: string | undefined;
  aggregation?: AggregationOption | undefined;
  topN?: number | undefined;
}

interface ResolvedAnalysisTarget {
  dataset: AnalysisDataset | null;
  resource: AnalysisResource;
  selectionNote: string | null;
}

export async function analyzeDatasetResource(options: AnalyzeDatasetResourceOptions): Promise<ResourceAnalysisResult> {
  const loaded = await loadAnalyzedRows(options);
  return loaded.result;
}

export async function prepareDatasetChart(options: PrepareDatasetChartOptions): Promise<ChartPreparationResult> {
  const loaded = await loadAnalyzedRows(options);
  const chart = buildChartFromAnalysis(loaded.analysis, {
    chartGoal: options.chartGoal,
    chartType: options.chartType,
    xField: options.xField,
    yField: options.yField,
    groupField: options.groupField,
    aggregation: options.aggregation,
    topN: options.topN,
  });

  return {
    ...loaded.result,
    chart,
  };
}

export function analyzeStructuredText(options: {
  text: string;
  previewTruncated: boolean;
  format: string | null;
  contentType: string | null;
  url: string;
  maxRows?: number | undefined;
}): StructuredTableAnalysis {
  const warnings: string[] = [];
  const detectedFormat = detectAnalysisFormat({
    text: options.text,
    format: options.format,
    contentType: options.contentType,
    url: options.url,
  });

  let rows: TableRow[];
  if (detectedFormat === "csv") {
    rows = parseCsvRows(options.text, options.previewTruncated, warnings);
  } else {
    const parsedJson = parseJsonRows(options.text, options.previewTruncated, warnings);
    rows = parsedJson.rows;
  }

  if (rows.length === 0) {
    throw new Error("No tabular rows could be parsed from this resource.");
  }

  const maxRows = options.maxRows ?? DEFAULT_ANALYSIS_MAX_ROWS;
  const analysisRows = rows.slice(0, maxRows);
  if (rows.length > analysisRows.length) {
    warnings.push(`Only the first ${formatCount(analysisRows.length)} rows were analyzed to keep the result bounded.`);
  }

  const columns = buildColumnProfiles(analysisRows);
  const suggestions = buildChartSuggestions(columns);

  return {
    detectedFormat,
    rowCount: analysisRows.length,
    columnCount: columns.length,
    columns,
    sampleRows: analysisRows.slice(0, DEFAULT_SAMPLE_ROW_COUNT),
    suggestions,
    warnings,
    rows: analysisRows,
  };
}

export function buildChartFromAnalysis(
  analysis: StructuredTableAnalysis,
  options?: {
    chartGoal?: string | undefined;
    chartType?: ChartType | undefined;
    xField?: string | undefined;
    yField?: string | undefined;
    groupField?: string | undefined;
    aggregation?: AggregationOption | undefined;
    topN?: number | undefined;
  },
): PreparedChart {
  const goal = options?.chartGoal;
  const chartType = chooseChartType(analysis, options?.chartType, goal);
  const xColumn = resolveXField(analysis, chartType, options?.xField, goal);
  const yColumn = resolveYField(analysis, chartType, options?.yField, goal);
  const groupColumn = resolveGroupField(analysis, options?.groupField);

  if (groupColumn && groupColumn.name === xColumn.name) {
    throw new Error("groupField must be different from xField.");
  }

  if (groupColumn && yColumn && groupColumn.name === yColumn.name) {
    throw new Error("groupField must be different from yField.");
  }

  if (chartType === "scatter") {
    if (!yColumn) {
      throw new Error("Scatter charts need two numeric fields. Provide yField or choose a different chart type.");
    }

    return buildScatterChart(analysis, xColumn, yColumn, groupColumn, goal);
  }

  return buildAggregateChart(analysis, chartType, xColumn, yColumn, groupColumn, {
    chartGoal: goal,
    aggregation: options?.aggregation,
    topN: options?.topN,
  });
}

async function loadAnalyzedRows(options: AnalyzeDatasetResourceOptions): Promise<{
  result: ResourceAnalysisResult;
  analysis: StructuredTableAnalysis;
}> {
  const target = await resolveAnalysisTarget(options);
  const maxBytes = options.maxBytes ?? DEFAULT_ANALYSIS_MAX_BYTES;
  const preview = await fetchResourcePreview({
    url: target.resource.url,
    format: target.resource.format,
    mimeType: target.resource.mimeType,
    maxBytes,
  });

  if (!preview.fetchedDirectly || !preview.previewText) {
    throw new Error("This analysis workflow currently supports directly readable CSV, JSON, or GeoJSON resources.");
  }

  const analysis = analyzeStructuredText({
    text: preview.previewText,
    previewTruncated: preview.previewTruncated,
    format: target.resource.format,
    contentType: preview.contentType ?? target.resource.mimeType,
    url: target.resource.url,
    maxRows: options.maxRows,
  });

  const result: ResourceAnalysisResult = {
    dataset: target.dataset,
    resource: target.resource,
    selectionNote: target.selectionNote,
    scope: {
      maxBytes,
      bytesRead: preview.bytesRead,
      contentType: preview.contentType,
      completeness: preview.previewTruncated ? "sampled_preview" : "complete_resource",
      note: preview.previewTruncated
        ? "The resource exceeded the analysis byte limit, so this result is based on a sampled preview."
        : "The fetched content fit within the analysis byte limit.",
    },
    analysis: summarizeStructuredAnalysis(analysis),
  };

  return {
    result,
    analysis,
  };
}

async function resolveAnalysisTarget(options: AnalyzeDatasetResourceOptions): Promise<ResolvedAnalysisTarget> {
  if (!options.resourceUrl && !options.datasetIdOrNameOrUrl) {
    throw new Error("Provide either resourceUrl or datasetIdOrNameOrUrl.");
  }

  if (options.resourceUrl) {
    return {
      dataset: null,
      resource: {
        id: null,
        name: null,
        format: null,
        resourceType: null,
        url: options.resourceUrl,
        mimeType: null,
        datastoreActive: false,
        selectedAutomatically: false,
      },
      selectionNote: null,
    };
  }

  const dataset = await getDataset(options.datasetIdOrNameOrUrl!);
  const explicitResource = options.resourceIdOrName ? resolveResource(dataset, options.resourceIdOrName) : null;
  const chosenResource = explicitResource ?? selectRecommendedResource(dataset.resources, { preferAnalysisFriendly: true });

  if (!chosenResource) {
    throw new Error(`No resources were found for dataset ${dataset.id}.`);
  }

  const resource: AnalysisResource = {
    id: chosenResource.id,
    name: chosenResource.name,
    format: chosenResource.format,
    resourceType: chosenResource.resourceType,
    url: chosenResource.url,
    mimeType: chosenResource.mimeType,
    datastoreActive: chosenResource.datastoreActive,
    selectedAutomatically: explicitResource === null,
  };

  return {
    dataset: {
      id: dataset.id,
      title: dataset.title,
      url: `https://open.canada.ca/data/en/dataset/${dataset.id}`,
    },
    resource,
    selectionNote: explicitResource
      ? null
      : `Automatically selected the most analysis-friendly resource: ${chosenResource.name}${chosenResource.format ? ` (${chosenResource.format})` : ""}.`,
  };
}

function summarizeStructuredAnalysis(analysis: StructuredTableAnalysis): Omit<StructuredTableAnalysis, "rows"> {
  return {
    detectedFormat: analysis.detectedFormat,
    rowCount: analysis.rowCount,
    columnCount: analysis.columnCount,
    columns: analysis.columns,
    sampleRows: analysis.sampleRows,
    suggestions: analysis.suggestions,
    warnings: analysis.warnings,
  };
}

function detectAnalysisFormat(options: {
  text: string;
  format: string | null;
  contentType: string | null;
  url: string;
}): SupportedAnalysisFormat {
  const normalizedFormat = normalizeWhitespace(options.format ?? "").toUpperCase();
  const normalizedContentType = (options.contentType ?? "").toLowerCase();
  const normalizedUrl = options.url.toLowerCase();
  const trimmedText = options.text.trimStart();

  if (normalizedFormat === "CSV" || normalizedContentType.includes("text/csv") || normalizedUrl.endsWith(".csv")) {
    return "csv";
  }

  if (
    normalizedFormat === "GEOJSON"
    || normalizedContentType.includes("application/geo+json")
    || normalizedUrl.endsWith(".geojson")
  ) {
    return "geojson";
  }

  if (
    normalizedFormat === "JSON"
    || normalizedFormat === "JSONL"
    || normalizedContentType.includes("application/json")
    || normalizedUrl.endsWith(".json")
    || normalizedUrl.endsWith(".jsonl")
    || trimmedText.startsWith("{")
    || trimmedText.startsWith("[")
  ) {
    return "json";
  }

  if (looksLikeCsv(trimmedText)) {
    return "csv";
  }

  throw new Error("This resource does not look like CSV, JSON, or GeoJSON content that can be analyzed directly.");
}

function parseCsvRows(text: string, previewTruncated: boolean, warnings: string[]): TableRow[] {
  const preparedText = previewTruncated ? trimCsvToLastCompleteLine(text) : text;
  if (previewTruncated) {
    warnings.push("The CSV preview was truncated at the byte limit, so the last incomplete row was dropped.");
  }

  const records = parseCsv(preparedText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
    relax_column_count: true,
  }) as Array<Record<string, string | undefined>>;

  return records
    .map((record) => {
      const row: TableRow = {};
      for (const [key, value] of Object.entries(record)) {
        const name = normalizeWhitespace(key);
        if (!name) {
          continue;
        }

        row[name] = toCellValue(value);
      }

      return row;
    })
    .filter((row) => Object.keys(row).length > 0);
}

function parseJsonRows(
  text: string,
  previewTruncated: boolean,
  warnings: string[],
): {
  rows: TableRow[];
} {
  try {
    const parsed = JSON.parse(text) as unknown;
    const extracted = extractRowsFromJsonValue(parsed);
    if (previewTruncated) {
      warnings.push("The JSON preview was truncated at the byte limit. Only the parsed portion is available for analysis.");
    }
    if (extracted.note) {
      warnings.push(extracted.note);
    }
    return {
      rows: extracted.rows,
    };
  } catch (error) {
    const jsonlRows = tryParseJsonLines(text);
    if (jsonlRows) {
      if (previewTruncated) {
        warnings.push("The JSON Lines preview was truncated at the byte limit, so this analysis uses only the visible records.");
      }
      return {
        rows: jsonlRows,
      };
    }

    if (previewTruncated) {
      throw new Error("The JSON resource exceeded the analysis byte limit and could not be parsed completely. Increase maxBytes or choose a smaller resource.");
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse the JSON resource: ${message}`);
  }
}

function extractRowsFromJsonValue(value: unknown): { rows: TableRow[]; note: string | null } {
  if (Array.isArray(value)) {
    return {
      rows: value.map((item) => toRow(item)),
      note: null,
    };
  }

  if (isRecord(value)) {
    if (value.type === "FeatureCollection" && Array.isArray(value.features)) {
      return {
        rows: value.features.map((feature) => featureToRow(feature)),
        note: "GeoJSON features were converted into rows using feature properties and basic geometry fields.",
      };
    }

    if (isRecord(value.result) && Array.isArray(value.result.records)) {
      return {
        rows: value.result.records.map((record) => toRow(record)),
        note: 'Using the "result.records" array from the JSON payload.',
      };
    }

    if (Array.isArray(value.records)) {
      return {
        rows: value.records.map((record) => toRow(record)),
        note: 'Using the "records" array from the JSON payload.',
      };
    }

    for (const [key, candidate] of Object.entries(value)) {
      if (Array.isArray(candidate)) {
        return {
          rows: candidate.map((item) => toRow(item)),
          note: `Using the "${key}" array from the JSON payload.`,
        };
      }
    }

    return {
      rows: [toRow(value)],
      note: "Using the top-level JSON object as a single-row table.",
    };
  }

  return {
    rows: [{ value: toCellValue(value) }],
    note: "Using the top-level JSON value as a single-row table.",
  };
}

function featureToRow(value: unknown): TableRow {
  if (!isRecord(value)) {
    return toRow(value);
  }

  const row: TableRow = {};
  const properties = isRecord(value.properties) ? value.properties : null;
  for (const [key, propertyValue] of Object.entries(properties ?? {})) {
    row[normalizeWhitespace(key)] = toCellValue(propertyValue);
  }

  if (typeof value.id === "string" || typeof value.id === "number") {
    row.feature_id = toCellValue(value.id);
  }

  const geometry = isRecord(value.geometry) ? value.geometry : null;
  if (geometry?.type && typeof geometry.type === "string") {
    row.geometry_type = geometry.type;
  }

  if (geometry?.type === "Point" && Array.isArray(geometry.coordinates)) {
    const longitude = geometry.coordinates[0];
    const latitude = geometry.coordinates[1];
    row.longitude = typeof longitude === "number" ? longitude : null;
    row.latitude = typeof latitude === "number" ? latitude : null;
  }

  return row;
}

function toRow(value: unknown): TableRow {
  if (!isRecord(value)) {
    return { value: toCellValue(value) };
  }

  const row: TableRow = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizeWhitespace(key);
    if (!normalizedKey) {
      continue;
    }

    row[normalizedKey] = toCellValue(item);
  }

  return row;
}

function toCellValue(value: unknown): TableCellValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  try {
    return normalizeWhitespace(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function buildColumnProfiles(rows: TableRow[]): AnalysisColumn[] {
  const columnNames = collectColumnNames(rows);
  return columnNames.map((name) => buildColumnProfile(name, rows));
}

function collectColumnNames(rows: TableRow[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }

  return names;
}

function buildColumnProfile(name: string, rows: TableRow[]): AnalysisColumn {
  const values = rows.map((row) => row[name] ?? null);
  const nonNullValues = values.filter((value): value is Exclude<TableCellValue, null> => value !== null);
  const nullCount = values.length - nonNullValues.length;
  const distinctValues = uniqueValues(nonNullValues);
  const examples = distinctValues.slice(0, 3).map((value) => truncateExample(value));

  const parsedNumbers = nonNullValues
    .map((value) => parseNumberCandidate(value))
    .filter((value): value is number => value !== null);
  const parsedDates = nonNullValues
    .map((value) => parseDateCandidate(value))
    .filter((value): value is string => value !== null);
  const parsedBooleans = nonNullValues
    .map((value) => parseBooleanCandidate(value))
    .filter((value): value is boolean => value !== null);

  let inferredType: InferredType = "string";
  if (nonNullValues.length > 0) {
    const booleanRate = parsedBooleans.length / nonNullValues.length;
    const numberRate = parsedNumbers.length / nonNullValues.length;
    const dateRate = parsedDates.length / nonNullValues.length;

    if (booleanRate === 1 && distinctValues.length <= 2) {
      inferredType = "boolean";
    } else if (numberRate >= 0.9) {
      inferredType = "number";
    } else if (dateRate >= 0.9) {
      inferredType = "date";
    } else if (booleanRate >= 0.9 && distinctValues.length <= 3) {
      inferredType = "boolean";
    }
  }

  const numberSummary = inferredType === "number" ? summarizeNumbers(parsedNumbers) : undefined;
  const dateSummary = inferredType === "date" ? summarizeDates(parsedDates) : undefined;
  const semanticRole = inferSemanticRole({
    name,
    inferredType,
    distinctCount: distinctValues.length,
    nonNullCount: nonNullValues.length,
    numberSummary,
  });

  return {
    name,
    inferredType,
    semanticRole,
    nonNullCount: nonNullValues.length,
    nullCount,
    distinctCount: distinctValues.length,
    examples,
    numberSummary,
    dateSummary,
  };
}

function buildChartSuggestions(columns: AnalysisColumn[]): ChartSuggestion[] {
  const suggestions: ChartSuggestion[] = [];
  const timeField = columns.find((column) => column.semanticRole === "time");
  const measureFields = columns.filter((column) => column.semanticRole === "measure");
  const geographyField = columns.find((column) => column.semanticRole === "geography");
  const categoryField = [...columns]
    .filter((column) => column.semanticRole === "category" && column.distinctCount > 1)
    .sort((left, right) => left.distinctCount - right.distinctCount)[0] ?? null;

  if (timeField && measureFields[0]) {
    suggestions.push({
      chartType: "line",
      title: `${measureFields[0].name} over ${timeField.name}`,
      xField: timeField.name,
      yField: measureFields[0].name,
      reasoning: "The resource includes a time-like field and a numeric measure, which is a strong fit for a line chart.",
    });
  }

  const comparisonField = geographyField ?? categoryField;
  if (comparisonField) {
    suggestions.push({
      chartType: "bar",
      title: measureFields[0]
        ? `${measureFields[0].name} by ${comparisonField.name}`
        : `Record count by ${comparisonField.name}`,
      xField: comparisonField.name,
      yField: measureFields[0]?.name ?? null,
      reasoning: measureFields[0]
        ? "A category or geography field paired with a numeric measure is a good fit for a bar chart."
        : "This field looks like a good grouping dimension for a count-based bar chart.",
    });
  }

  if (measureFields.length >= 2) {
    const first = measureFields[0]!;
    const second = measureFields[1]!;
    suggestions.push({
      chartType: "scatter",
      title: `${second.name} versus ${first.name}`,
      xField: first.name,
      yField: second.name,
      reasoning: "Two numeric measures are available, which makes a scatter plot a good way to inspect their relationship.",
    });
  }

  return suggestions;
}

function chooseChartType(
  analysis: StructuredTableAnalysis,
  requestedChartType: ChartType | undefined,
  chartGoal: string | undefined,
): Exclude<ChartType, "auto"> {
  if (requestedChartType && requestedChartType !== "auto") {
    return requestedChartType;
  }

  const inferredFromGoal = inferChartTypeFromGoal(chartGoal);
  if (inferredFromGoal) {
    return inferredFromGoal;
  }

  return analysis.suggestions[0]?.chartType ?? "bar";
}

function inferChartTypeFromGoal(chartGoal: string | undefined): Exclude<ChartType, "auto"> | null {
  if (!chartGoal) {
    return null;
  }

  const normalized = normalizeForMatch(chartGoal);
  if (
    normalized.includes("trend")
    || normalized.includes("overtime")
    || normalized.includes("timeseries")
    || normalized.includes("timeline")
  ) {
    return "line";
  }

  if (
    normalized.includes("scatter")
    || normalized.includes("correlation")
    || normalized.includes("relationship")
    || normalized.includes("versus")
  ) {
    return "scatter";
  }

  if (
    normalized.includes("bar")
    || normalized.includes("compare")
    || normalized.includes("comparison")
    || normalized.includes("top")
    || normalized.includes("breakdown")
  ) {
    return "bar";
  }

  return null;
}

function resolveXField(
  analysis: StructuredTableAnalysis,
  chartType: Exclude<ChartType, "auto">,
  requestedField: string | undefined,
  chartGoal: string | undefined,
): AnalysisColumn {
  const requested = requestedField ? matchColumn(analysis.columns, requestedField, "xField") : null;
  if (requested) {
    return requested;
  }

  if (chartType === "line") {
    const timeField = findGoalMatchedColumn(analysis.columns.filter((column) => column.semanticRole === "time"), chartGoal)
      ?? analysis.columns.find((column) => column.semanticRole === "time");
    if (!timeField) {
      throw new Error("I couldn't find a time-like field for a line chart. Try specifying xField or choose a bar chart.");
    }
    return timeField;
  }

  if (chartType === "scatter") {
    const numericFields = analysis.columns.filter((column) => column.semanticRole === "measure");
    const goalMatched = findGoalMatchedColumn(numericFields, chartGoal);
    if (goalMatched) {
      return goalMatched;
    }

    if (!numericFields[0]) {
      throw new Error("I couldn't find a numeric field to use on the x-axis for a scatter chart.");
    }

    return numericFields[0];
  }

  const comparisonCandidates = analysis.columns
    .filter(
      (column) => (column.semanticRole === "geography" || column.semanticRole === "category") && column.distinctCount > 1,
    )
    .sort((left, right) => left.distinctCount - right.distinctCount);
  const chosen = findGoalMatchedColumn(comparisonCandidates, chartGoal) ?? comparisonCandidates[0];

  if (!chosen) {
    throw new Error("I couldn't find a category-like field for a bar chart. Try specifying xField or choose a scatter chart.");
  }

  return chosen;
}

function resolveYField(
  analysis: StructuredTableAnalysis,
  chartType: Exclude<ChartType, "auto">,
  requestedField: string | undefined,
  chartGoal: string | undefined,
): AnalysisColumn | null {
  const requested = requestedField ? matchColumn(analysis.columns, requestedField, "yField") : null;
  if (requested) {
    if (requested.semanticRole !== "measure") {
      throw new Error(`Field "${requested.name}" is not numeric enough for use as yField.`);
    }
    return requested;
  }

  const numericFields = analysis.columns.filter((column) => column.semanticRole === "measure");
  const goalMatched = findGoalMatchedColumn(numericFields, chartGoal);
  if (goalMatched) {
    return goalMatched;
  }

  if (chartType === "bar") {
    return numericFields[0] ?? null;
  }

  if (chartType === "line" || chartType === "scatter") {
    if (!numericFields[0]) {
      throw new Error(`I couldn't find a numeric field for a ${chartType} chart.`);
    }

    return chartType === "scatter" && numericFields[1] ? numericFields[1] : numericFields[0];
  }

  return null;
}

function resolveGroupField(analysis: StructuredTableAnalysis, requestedField: string | undefined): AnalysisColumn | null {
  if (!requestedField) {
    return null;
  }

  const column = matchColumn(analysis.columns, requestedField, "groupField");
  if (column.semanticRole === "measure" || column.semanticRole === "time") {
    throw new Error(`Field "${column.name}" is not a good grouping field. Use a category or geography field instead.`);
  }

  return column;
}

function buildScatterChart(
  analysis: StructuredTableAnalysis,
  xColumn: AnalysisColumn,
  yColumn: AnalysisColumn,
  groupColumn: AnalysisColumn | null,
  chartGoal: string | undefined,
): PreparedChart {
  if (xColumn.semanticRole !== "measure" || yColumn.semanticRole !== "measure") {
    throw new Error("Scatter charts need two numeric fields.");
  }

  const points: TableRow[] = [];
  for (const row of analysis.rows) {
    const xValue = parseNumberCandidate(row[xColumn.name] ?? null);
    const yValue = parseNumberCandidate(row[yColumn.name] ?? null);
    if (xValue === null || yValue === null) {
      continue;
    }

    const point: TableRow = {
      [xColumn.name]: xValue,
      [yColumn.name]: yValue,
    };

    if (groupColumn) {
      point[groupColumn.name] = row[groupColumn.name] ?? null;
    }

    points.push(point);
  }

  const visiblePoints = points.slice(0, DEFAULT_CHART_POINT_LIMIT);
  const warnings: string[] = [];
  if (points.length > visiblePoints.length) {
    warnings.push(`Only the first ${formatCount(visiblePoints.length)} points are returned to keep the visualization payload bounded.`);
  }

  return {
    chartType: "scatter",
    title: `${yColumn.name} versus ${xColumn.name}`,
    xField: xColumn.name,
    yField: yColumn.name,
    sourceYField: yColumn.name,
    groupField: groupColumn?.name ?? null,
    aggregation: "none",
    reasoning: chartGoal
      ? `Prepared a scatter plot based on the requested goal: ${chartGoal}`
      : "Prepared a scatter plot because the resource contains two numeric measures that can be compared directly.",
    pointCount: visiblePoints.length,
    points: visiblePoints,
    warnings,
    vegaLiteSpec: buildVegaLiteSpec({
      chartType: "scatter",
      xField: xColumn.name,
      yField: yColumn.name,
      groupField: groupColumn?.name ?? null,
      points: visiblePoints,
      xType: "quantitative",
    }),
  };
}

function buildAggregateChart(
  analysis: StructuredTableAnalysis,
  chartType: "line" | "bar",
  xColumn: AnalysisColumn,
  yColumn: AnalysisColumn | null,
  groupColumn: AnalysisColumn | null,
  options: {
    chartGoal?: string | undefined;
    aggregation?: AggregationOption | undefined;
    topN?: number | undefined;
  },
): PreparedChart {
  const buckets = new Map<string, { xValue: TableCellValue; groupValue: TableCellValue; values: number[]; count: number }>();

  for (const row of analysis.rows) {
    const xValue = row[xColumn.name] ?? null;
    if (xValue === null) {
      continue;
    }

    const groupValue = groupColumn ? row[groupColumn.name] ?? null : null;
    const bucketKey = `${serializeValue(xValue)}\u0000${serializeValue(groupValue)}`;

    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        xValue,
        groupValue,
        values: [],
        count: 0,
      };
      buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    if (yColumn) {
      const numericValue = parseNumberCandidate(row[yColumn.name] ?? null);
      if (numericValue !== null) {
        bucket.values.push(numericValue);
      }
    }
  }

  const aggregation = chooseAggregation({
    requested: options.aggregation,
    chartGoal: options.chartGoal,
    yColumn,
    buckets: Array.from(buckets.values()),
  });

  const yField = aggregation === "count" ? "record_count" : yColumn?.name ?? "value";
  const points: TableRow[] = [];
  for (const bucket of buckets.values()) {
    const aggregatedValue = summarizeBucket(bucket, aggregation);
    if (aggregatedValue === null) {
      continue;
    }

    const point: TableRow = {
      [xColumn.name]: coerceOutputValue(bucket.xValue, xColumn.inferredType),
      [yField]: aggregatedValue,
    };

    if (groupColumn) {
      point[groupColumn.name] = coerceOutputValue(bucket.groupValue, groupColumn.inferredType);
    }

    points.push(point);
  }

  const sortedPoints = sortChartPoints(points, {
    chartType,
    xField: xColumn.name,
    yField,
    xType: xColumn.inferredType,
  });

  const warnings: string[] = [];
  let visiblePoints = sortedPoints;
  if (chartType === "bar" && !groupColumn) {
    visiblePoints = sortedPoints.slice(0, options.topN ?? DEFAULT_TOP_N);
    if (sortedPoints.length > visiblePoints.length) {
      warnings.push(`Only the top ${formatCount(visiblePoints.length)} bars are returned.`);
    }
  } else {
    visiblePoints = sortedPoints.slice(0, DEFAULT_CHART_POINT_LIMIT);
    if (sortedPoints.length > visiblePoints.length) {
      warnings.push(`Only the first ${formatCount(visiblePoints.length)} chart points are returned to keep the payload bounded.`);
    }
  }

  if (groupColumn) {
    const distinctGroups = new Set(visiblePoints.map((point) => serializeValue(point[groupColumn.name] ?? null)));
    if (distinctGroups.size > 6) {
      warnings.push("The grouped chart contains many series. Consider specifying a narrower groupField or an additional filter.");
    }
  }

  const title = chartType === "line"
    ? `${yField} over ${xColumn.name}`
    : `${yField} by ${xColumn.name}`;
  const reasoning = buildChartReasoning({
    chartType,
    xColumn,
    yColumn,
    aggregation,
    chartGoal: options.chartGoal,
  });

  return {
    chartType,
    title,
    xField: xColumn.name,
    yField,
    sourceYField: yColumn?.name ?? null,
    groupField: groupColumn?.name ?? null,
    aggregation,
    reasoning,
    pointCount: visiblePoints.length,
    points: visiblePoints,
    warnings,
    vegaLiteSpec: buildVegaLiteSpec({
      chartType,
      xField: xColumn.name,
      yField,
      groupField: groupColumn?.name ?? null,
      points: visiblePoints,
      xType: xColumn.inferredType === "date" ? "temporal" : xColumn.inferredType === "number" ? "quantitative" : "nominal",
    }),
  };
}

function buildChartReasoning(options: {
  chartType: "line" | "bar";
  xColumn: AnalysisColumn;
  yColumn: AnalysisColumn | null;
  aggregation: ComputedAggregation;
  chartGoal?: string | undefined;
}): string {
  if (options.chartGoal) {
    return `Prepared a ${options.chartType} chart to match the requested goal: ${options.chartGoal}`;
  }

  if (options.chartType === "line") {
    return `Prepared a line chart because "${options.xColumn.name}" looks like a time field and "${options.yColumn?.name ?? options.aggregation}" looks like a measurable value.`;
  }

  if (options.yColumn) {
    return `Prepared a bar chart by grouping "${options.xColumn.name}" and summarizing "${options.yColumn.name}" with ${describeAggregation(options.aggregation)}.`;
  }

  return `Prepared a count-based bar chart by grouping records with "${options.xColumn.name}".`;
}

function chooseAggregation(options: {
  requested: AggregationOption | undefined;
  chartGoal: string | undefined;
  yColumn: AnalysisColumn | null;
  buckets: Array<{ values: number[]; count: number }>;
}): ComputedAggregation {
  if (options.requested && options.requested !== "auto") {
    return options.requested;
  }

  if (!options.yColumn) {
    return "count";
  }

  const hasDuplicates = options.buckets.some((bucket) => bucket.values.length > 1 || bucket.count > 1);
  if (!hasDuplicates) {
    return "none";
  }

  const hintText = normalizeForMatch(`${options.chartGoal ?? ""} ${options.yColumn.name}`);
  const rawHintText = `${options.chartGoal ?? ""} ${options.yColumn.name}`.toLowerCase();
  if (
    rawHintText.includes("%")
    || rawHintText.includes("percent")
    || rawHintText.includes("percentage")
    || hintText.includes("average")
    || hintText.includes("avg")
    || hintText.includes("mean")
    || hintText.includes("rate")
    || hintText.includes("pct")
  ) {
    return "avg";
  }

  return "sum";
}

function summarizeBucket(
  bucket: {
    values: number[];
    count: number;
  },
  aggregation: ComputedAggregation,
): number | null {
  if (aggregation === "count") {
    return bucket.count;
  }

  if (bucket.values.length === 0) {
    return null;
  }

  if (aggregation === "none") {
    return bucket.values[0] ?? null;
  }

  if (aggregation === "avg") {
    return bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length;
  }

  return bucket.values.reduce((sum, value) => sum + value, 0);
}

function buildVegaLiteSpec(options: {
  chartType: "line" | "bar" | "scatter";
  xField: string;
  yField: string;
  groupField: string | null;
  points: TableRow[];
  xType: "temporal" | "quantitative" | "nominal";
}): Record<string, unknown> {
  const encoding: Record<string, unknown> = {
    x: {
      field: options.xField,
      type: options.xType,
    },
    y: {
      field: options.yField,
      type: "quantitative",
    },
  };

  if (options.groupField) {
    encoding.color = {
      field: options.groupField,
      type: "nominal",
    };
  }

  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    mark: options.chartType === "scatter" ? "point" : options.chartType,
    data: {
      values: options.points,
    },
    encoding,
  };
}

function sortChartPoints(
  points: TableRow[],
  options: {
    chartType: "line" | "bar";
    xField: string;
    yField: string;
    xType: InferredType;
  },
): TableRow[] {
  return [...points].sort((left, right) => {
    if (options.chartType === "line") {
      return compareChartXValues(left[options.xField] ?? null, right[options.xField] ?? null, options.xType);
    }

    const leftValue = parseNumberCandidate(left[options.yField] ?? null) ?? Number.NEGATIVE_INFINITY;
    const rightValue = parseNumberCandidate(right[options.yField] ?? null) ?? Number.NEGATIVE_INFINITY;
    return rightValue - leftValue;
  });
}

function compareChartXValues(left: TableCellValue, right: TableCellValue, type: InferredType): number {
  if (type === "date") {
    const leftTime = Date.parse(String(left ?? ""));
    const rightTime = Date.parse(String(right ?? ""));
    return leftTime - rightTime;
  }

  if (type === "number") {
    return (parseNumberCandidate(left) ?? 0) - (parseNumberCandidate(right) ?? 0);
  }

  return String(left ?? "").localeCompare(String(right ?? ""));
}

function coerceOutputValue(value: TableCellValue, inferredType: InferredType): TableCellValue {
  if (value === null) {
    return null;
  }

  if (inferredType === "date") {
    return parseDateCandidate(value) ?? String(value);
  }

  return value;
}

function matchColumn(columns: AnalysisColumn[], requestedField: string, label: string): AnalysisColumn {
  const normalizedRequested = normalizeForMatch(requestedField);
  const exactMatch = columns.find((column) => normalizeForMatch(column.name) === normalizedRequested);
  if (exactMatch) {
    return exactMatch;
  }

  const partialMatches = columns.filter((column) => {
    const normalizedColumn = normalizeForMatch(column.name);
    return normalizedColumn.includes(normalizedRequested) || normalizedRequested.includes(normalizedColumn);
  });

  if (partialMatches.length === 1) {
    return partialMatches[0]!;
  }

  throw new Error(`I couldn't match ${label} "${requestedField}". Available fields: ${columns.map((column) => column.name).join(", ")}`);
}

function findGoalMatchedColumn(columns: AnalysisColumn[], chartGoal: string | undefined): AnalysisColumn | null {
  if (!chartGoal) {
    return null;
  }

  const normalizedGoal = normalizeForMatch(chartGoal);
  return columns.find((column) => normalizedGoal.includes(normalizeForMatch(column.name))) ?? null;
}

function inferSemanticRole(options: {
  name: string;
  inferredType: InferredType;
  distinctCount: number;
  nonNullCount: number;
  numberSummary:
    | {
        min: number;
        max: number;
        mean: number;
      }
    | undefined;
}): SemanticRole {
  const normalizedName = normalizeForMatch(options.name);
  const distinctRatio = options.nonNullCount > 0 ? options.distinctCount / options.nonNullCount : 0;

  if (looksLikeGeographyField(normalizedName)) {
    return "geography";
  }

  if (
    options.inferredType === "date"
    || looksLikeTimeField(normalizedName)
    || (
      options.inferredType === "number"
      && normalizedName.includes("year")
      && options.numberSummary !== undefined
      && options.numberSummary.min >= 1800
      && options.numberSummary.max <= 2200
    )
  ) {
    return "time";
  }

  if (
    looksLikeIdentifierField(normalizedName)
    || (options.inferredType !== "number" && distinctRatio > 0.9 && options.nonNullCount >= 20)
  ) {
    return "identifier";
  }

  if (options.inferredType === "number") {
    return "measure";
  }

  return "category";
}

function looksLikeGeographyField(value: string): boolean {
  return [
    "province",
    "territory",
    "region",
    "municipality",
    "city",
    "country",
    "postal",
    "latitude",
    "longitude",
    "lat",
    "lon",
    "lng",
    "geography",
    "geo",
    "census",
  ].some((snippet) => value.includes(snippet));
}

function looksLikeTimeField(value: string): boolean {
  return [
    "date",
    "time",
    "month",
    "year",
    "week",
    "period",
    "quarter",
    "day",
  ].some((snippet) => value.includes(snippet));
}

function looksLikeIdentifierField(value: string): boolean {
  return [
    "id",
    "uuid",
    "guid",
    "identifier",
    "code",
    "reference",
    "key",
  ].some((snippet) => value.includes(snippet));
}

function summarizeNumbers(values: number[]): { min: number; max: number; mean: number } | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min,
    max,
    mean,
  };
}

function summarizeDates(values: string[]): { earliest: string; latest: string } | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = [...values].sort((left, right) => Date.parse(left) - Date.parse(right));
  const earliest = sorted[0];
  const latest = sorted[sorted.length - 1];
  if (!earliest || !latest) {
    return undefined;
  }

  return {
    earliest,
    latest,
  };
}

function parseNumberCandidate(value: TableCellValue): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/,/g, "").trim();
  if (!/^-?(?:\d+|\d+\.\d+)$/.test(normalized)) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanCandidate(value: TableCellValue): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "n", "0"].includes(normalized)) {
    return false;
  }

  return null;
}

function parseDateCandidate(value: TableCellValue): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (!/[-/:a-zA-Z]/.test(normalized)) {
    return null;
  }

  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString().slice(0, 10);
}

function tryParseJsonLines(text: string): TableRow[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const rows: TableRow[] = [];
  for (const line of lines) {
    try {
      rows.push(toRow(JSON.parse(line) as unknown));
    } catch {
      return null;
    }
  }

  return rows;
}

function trimCsvToLastCompleteLine(text: string): string {
  const lastNewline = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  if (lastNewline === -1) {
    return text;
  }

  return text.slice(0, lastNewline);
}

function looksLikeCsv(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);

  return lines.length >= 2 && lines.every((line) => line.includes(","));
}

function uniqueValues(values: Exclude<TableCellValue, null>[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const serialized = serializeValue(value);
    if (!seen.has(serialized)) {
      seen.add(serialized);
      unique.push(String(value));
    }
  }

  return unique;
}

function truncateExample(value: string): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length <= 40 ? normalized : `${normalized.slice(0, 39)}…`;
}

function serializeValue(value: TableCellValue): string {
  return value === null ? "__null__" : String(value);
}

function normalizeForMatch(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function describeAggregation(value: ComputedAggregation): string {
  if (value === "avg") {
    return "an average";
  }
  if (value === "sum") {
    return "a sum";
  }
  if (value === "count") {
    return "a record count";
  }
  return "the raw value";
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
