import {
  analyzeStructuredText,
  type AnalysisColumn,
  type AnalysisDataset,
  type AnalysisResource,
  type AnalysisScope,
  type ResourceAnalysisResult,
  type TableCellValue,
  type TableRow,
} from "./analysis.js";
import type { NormalizedResource } from "./catalog.js";
import { getDataset, resolveResource } from "./catalog.js";
import { DEFAULT_ANALYSIS_MAX_ROWS, DEFAULT_MAP_FEATURE_LIMIT, DEFAULT_MAP_MAX_BYTES } from "./constants.js";
import { normalizeWhitespace } from "./helpers.js";
import { fetchResourcePreview } from "./resource-fetch.js";
import { looksGeoJsonLike, selectRecommendedResource } from "./resource-selection.js";

type GeoJsonGeometryType =
  | "Point"
  | "MultiPoint"
  | "LineString"
  | "MultiLineString"
  | "Polygon"
  | "MultiPolygon"
  | "GeometryCollection";

interface GeoJsonGeometry {
  type: GeoJsonGeometryType;
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
}

export interface GeoJsonFeature {
  type: "Feature";
  id?: string | number | null;
  properties?: Record<string, unknown>;
  geometry: GeoJsonGeometry | null;
  bbox?: number[];
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  bbox?: number[];
}

export interface GeoJsonMapSpec {
  type: "geojson-map";
  mapType: "point" | "choropleth" | "boundary" | "line" | "mixed";
  labelField: string | null;
  valueField: string | null;
  boundingBox: [number, number, number, number] | null;
  featureCollection: GeoJsonFeatureCollection;
}

export interface PreparedGeoJsonMap {
  mapType: GeoJsonMapSpec["mapType"];
  title: string;
  geometryTypes: GeoJsonGeometryType[];
  featureCount: number;
  returnedFeatureCount: number;
  labelField: string | null;
  valueField: string | null;
  reasoning: string;
  boundingBox: [number, number, number, number] | null;
  previewRows: TableRow[];
  warnings: string[];
  mapSpec: GeoJsonMapSpec;
}

export interface GeoJsonMapResult extends ResourceAnalysisResult {
  map: PreparedGeoJsonMap;
}

export interface PrepareGeoJsonMapOptions {
  datasetIdOrNameOrUrl?: string | undefined;
  resourceIdOrName?: string | undefined;
  resourceUrl?: string | undefined;
  labelField?: string | undefined;
  valueField?: string | undefined;
  maxBytes?: number | undefined;
  maxRows?: number | undefined;
  maxFeatures?: number | undefined;
}

interface LoadedGeoJson {
  dataset: AnalysisDataset | null;
  resource: AnalysisResource;
  selectionNote: string | null;
  scope: AnalysisScope;
  analysis: ResourceAnalysisResult["analysis"];
  collection: GeoJsonFeatureCollection;
}

export async function prepareGeoJsonMap(options: PrepareGeoJsonMapOptions): Promise<GeoJsonMapResult> {
  const loaded = await loadGeoJsonResource(options);
  const geometryTypes = collectGeometryTypes(loaded.collection.features);
  if (geometryTypes.length === 0) {
    throw new Error("The GeoJSON resource does not contain usable geometry for a map preview.");
  }

  const labelColumn = resolveLabelField(loaded.analysis.columns, options.labelField);
  const valueColumn = resolveValueField(loaded.analysis.columns, options.valueField);
  const mapType = chooseMapType(geometryTypes, valueColumn);
  const boundingBox = normalizeBoundingBox(loaded.collection.bbox) ?? computeBoundingBox(loaded.collection.features);
  const maxFeatures = options.maxFeatures ?? DEFAULT_MAP_FEATURE_LIMIT;
  const returnedFeatures = loaded.collection.features.slice(0, maxFeatures);
  const warnings = [...loaded.analysis.warnings];

  if (loaded.collection.features.length > returnedFeatures.length) {
    warnings.push(
      `Only the first ${formatCount(returnedFeatures.length)} features are included in the map payload to keep the result bounded.`,
    );
  }

  const featureCollection: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: returnedFeatures,
    ...(boundingBox ? { bbox: boundingBox } : {}),
  };
  const previewRows = buildPreviewRows(returnedFeatures, labelColumn?.name ?? null, valueColumn?.name ?? null);
  const reasoning = buildMapReasoning({
    mapType,
    geometryTypes,
    labelField: labelColumn?.name ?? null,
    valueField: valueColumn?.name ?? null,
  });

  return {
    dataset: loaded.dataset,
    resource: loaded.resource,
    selectionNote: loaded.selectionNote,
    scope: loaded.scope,
    analysis: {
      ...loaded.analysis,
      warnings,
    },
    map: {
      mapType,
      title: buildMapTitle(loaded.dataset?.title, loaded.resource.name, mapType),
      geometryTypes,
      featureCount: loaded.collection.features.length,
      returnedFeatureCount: returnedFeatures.length,
      labelField: labelColumn?.name ?? null,
      valueField: valueColumn?.name ?? null,
      reasoning,
      boundingBox,
      previewRows,
      warnings,
      mapSpec: {
        type: "geojson-map",
        mapType,
        labelField: labelColumn?.name ?? null,
        valueField: valueColumn?.name ?? null,
        boundingBox,
        featureCollection,
      },
    },
  };
}

async function loadGeoJsonResource(options: PrepareGeoJsonMapOptions): Promise<LoadedGeoJson> {
  if (!options.resourceUrl && !options.datasetIdOrNameOrUrl) {
    throw new Error("Provide either resourceUrl or datasetIdOrNameOrUrl.");
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAP_MAX_BYTES;

  if (options.resourceUrl) {
    const preview = await fetchResourcePreview({
      url: options.resourceUrl,
      maxBytes,
    });

    return buildLoadedGeoJson({
      dataset: null,
      resource: {
        id: null,
        name: null,
        format: "GEOJSON",
        resourceType: null,
        url: options.resourceUrl,
        mimeType: preview.contentType,
        datastoreActive: false,
        selectedAutomatically: false,
      },
      selectionNote: null,
      preview,
      maxBytes,
      maxRows: options.maxRows,
    });
  }

  const dataset = await getDataset(options.datasetIdOrNameOrUrl!);
  const explicitResource = options.resourceIdOrName ? resolveResource(dataset, options.resourceIdOrName) : null;
  const candidates = explicitResource ? [explicitResource] : rankGeoJsonResources(dataset.resources);

  if (candidates.length === 0) {
    throw new Error(`No GeoJSON resources were found for dataset ${dataset.id}.`);
  }

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const preview = await fetchResourcePreview({
        url: candidate.url,
        format: candidate.format,
        mimeType: candidate.mimeType,
        maxBytes,
      });

      return buildLoadedGeoJson({
        dataset: {
          id: dataset.id,
          title: dataset.title,
          url: `https://open.canada.ca/data/en/dataset/${dataset.id}`,
        },
        resource: toAnalysisResource(candidate, explicitResource === null),
        selectionNote: explicitResource
          ? null
          : `Automatically selected the most map-friendly GeoJSON resource: ${candidate.name}${candidate.format ? ` (${candidate.format})` : ""}.`,
        preview,
        maxBytes,
        maxRows: options.maxRows,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (explicitResource) {
        throw lastError;
      }
    }
  }

  throw new Error(lastError?.message ?? "I couldn't load a usable GeoJSON resource from this dataset.");
}

function buildLoadedGeoJson(options: {
  dataset: AnalysisDataset | null;
  resource: AnalysisResource;
  selectionNote: string | null;
  preview: Awaited<ReturnType<typeof fetchResourcePreview>>;
  maxBytes: number;
  maxRows?: number | undefined;
}): LoadedGeoJson {
  if (!options.preview.fetchedDirectly || !options.preview.previewText) {
    throw new Error("This mapping workflow currently supports directly readable GeoJSON resources only.");
  }

  if (options.preview.previewTruncated) {
    throw new Error("The GeoJSON resource exceeded the map byte limit. Increase maxBytes or choose a smaller GeoJSON resource.");
  }

  const collection = parseGeoJsonFeatureCollection(options.preview.previewText);
  const structuredAnalysis = analyzeStructuredText({
    text: options.preview.previewText,
    previewTruncated: false,
    format: "GEOJSON",
    contentType: options.preview.contentType ?? options.resource.mimeType,
    url: options.resource.url,
    maxRows: options.maxRows ?? DEFAULT_ANALYSIS_MAX_ROWS,
  });

  return {
    dataset: options.dataset,
    resource: options.resource,
    selectionNote: options.selectionNote,
    scope: {
      maxBytes: options.maxBytes,
      bytesRead: options.preview.bytesRead,
      contentType: options.preview.contentType,
      completeness: "complete_resource",
      note: "The fetched GeoJSON fit within the map byte limit.",
    },
    analysis: summarizeAnalysis(structuredAnalysis),
    collection,
  };
}

function rankGeoJsonResources(resources: NormalizedResource[]): NormalizedResource[] {
  const scored = resources
    .filter((resource) => looksGeoJsonLike(resource))
    .map((resource) => ({
      resource,
      score: scoreGeoJsonResource(resource),
    }))
    .sort((left, right) => right.score - left.score);

  return scored.map((item) => item.resource);
}

function scoreGeoJsonResource(resource: NormalizedResource): number {
  const preferred = selectRecommendedResource([resource], { preferGeoJson: true });
  if (!preferred) {
    return 0;
  }

  let score = 0;
  if (looksGeoJsonLike(resource)) {
    score += 100;
  }

  const format = (resource.format ?? "").toUpperCase();
  if (format === "GEOJSON") {
    score += 50;
  }

  if ((resource.resourceType ?? "").toLowerCase() === "api") {
    score -= 10;
  }

  return score;
}

function toAnalysisResource(resource: NormalizedResource, selectedAutomatically: boolean): AnalysisResource {
  return {
    id: resource.id,
    name: resource.name,
    format: resource.format,
    resourceType: resource.resourceType,
    url: resource.url,
    mimeType: resource.mimeType,
    datastoreActive: resource.datastoreActive,
    selectedAutomatically,
  };
}

function parseGeoJsonFeatureCollection(text: string): GeoJsonFeatureCollection {
  const parsed = JSON.parse(text) as unknown;

  if (isFeatureCollection(parsed)) {
    return {
      type: "FeatureCollection",
      features: parsed.features,
      ...(normalizeBoundingBox(parsed.bbox) ? { bbox: normalizeBoundingBox(parsed.bbox)! } : {}),
    };
  }

  if (isFeature(parsed)) {
    return {
      type: "FeatureCollection",
      features: [parsed],
      ...(normalizeBoundingBox(parsed.bbox) ? { bbox: normalizeBoundingBox(parsed.bbox)! } : {}),
    };
  }

  if (Array.isArray(parsed) && parsed.every(isFeature)) {
    return {
      type: "FeatureCollection",
      features: parsed,
    };
  }

  throw new Error("The resource did not parse as a GeoJSON FeatureCollection.");
}

function collectGeometryTypes(features: GeoJsonFeature[]): GeoJsonGeometryType[] {
  const types = new Set<GeoJsonGeometryType>();
  for (const feature of features) {
    collectGeometryTypesFromGeometry(feature.geometry, types);
  }

  return [...types];
}

function collectGeometryTypesFromGeometry(geometry: GeoJsonGeometry | null, types: Set<GeoJsonGeometryType>) {
  if (!geometry) {
    return;
  }

  types.add(geometry.type);
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries ?? []) {
      collectGeometryTypesFromGeometry(child, types);
    }
  }
}

function resolveLabelField(columns: AnalysisColumn[], requestedField: string | undefined): AnalysisColumn | null {
  if (requestedField) {
    return matchField(columns, requestedField, "labelField");
  }

  const preferredByName = columns.find(
    (column) => /(name|title|label|site|location|place|museum|park|station|region|province|territory|city|community)/i.test(column.name),
  );
  if (preferredByName) {
    return preferredByName;
  }

  return columns.find((column) => column.semanticRole === "geography" || column.semanticRole === "category") ?? null;
}

function resolveValueField(columns: AnalysisColumn[], requestedField: string | undefined): AnalysisColumn | null {
  if (requestedField) {
    const matched = matchField(columns, requestedField, "valueField");
    if (matched.semanticRole !== "measure") {
      throw new Error(`Field "${matched.name}" is not numeric enough for valueField.`);
    }
    return matched;
  }

  const preferredByName = columns.find(
    (column) =>
      column.semanticRole === "measure"
      && /(count|total|value|amount|rate|pct|percent|population|density|area|score)/i.test(column.name),
  );
  if (preferredByName) {
    return preferredByName;
  }

  return columns.find((column) => column.semanticRole === "measure") ?? null;
}

function chooseMapType(
  geometryTypes: GeoJsonGeometryType[],
  valueColumn: AnalysisColumn | null,
): PreparedGeoJsonMap["mapType"] {
  if (geometryTypes.every((type) => type === "Point" || type === "MultiPoint")) {
    return "point";
  }

  if (geometryTypes.some((type) => type === "Polygon" || type === "MultiPolygon")) {
    return valueColumn ? "choropleth" : "boundary";
  }

  if (geometryTypes.every((type) => type === "LineString" || type === "MultiLineString")) {
    return "line";
  }

  return "mixed";
}

function buildMapReasoning(options: {
  mapType: PreparedGeoJsonMap["mapType"];
  geometryTypes: GeoJsonGeometryType[];
  labelField: string | null;
  valueField: string | null;
}): string {
  const geometryText = options.geometryTypes.join(", ") || "unknown geometries";

  if (options.mapType === "choropleth") {
    return `Prepared a choropleth-style map because the GeoJSON contains polygon geometries (${geometryText}) and a numeric field (${options.valueField}).`;
  }

  if (options.mapType === "point") {
    return `Prepared a point map because the GeoJSON contains point geometries (${geometryText})${options.labelField ? ` and "${options.labelField}" is a good label field.` : "."}`;
  }

  if (options.mapType === "line") {
    return `Prepared a line map because the GeoJSON contains line geometries (${geometryText}).`;
  }

  if (options.mapType === "boundary") {
    return `Prepared a boundary map because the GeoJSON contains polygon geometries (${geometryText}) but no strong numeric field was detected for choropleth coloring.`;
  }

  return `Prepared a mixed-geometry GeoJSON map based on the available geometries (${geometryText}).`;
}

function buildMapTitle(
  datasetTitle: string | null | undefined,
  resourceName: string | null | undefined,
  mapType: PreparedGeoJsonMap["mapType"],
): string {
  const base = datasetTitle ?? resourceName ?? "GeoJSON map";
  return `${base} (${humanizeMapType(mapType)})`;
}

function buildPreviewRows(
  features: GeoJsonFeature[],
  labelField: string | null,
  valueField: string | null,
): TableRow[] {
  return features.slice(0, 8).map((feature, index) => {
    const row: TableRow = {
      feature_number: index + 1,
      geometry_type: feature.geometry?.type ?? null,
    };

    const properties = feature.properties ?? {};
    if (labelField) {
      row[labelField] = toCellValue(properties[labelField] ?? null);
    }

    if (valueField) {
      row[valueField] = toCellValue(properties[valueField] ?? null);
    }

    return row;
  });
}

function computeBoundingBox(features: GeoJsonFeature[]): [number, number, number, number] | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const feature of features) {
    walkCoordinates(feature.geometry, ([x, y]) => {
      if (x < minX) {
        minX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y > maxY) {
        maxY = y;
      }
    });
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return null;
  }

  return [minX, minY, maxX, maxY];
}

function walkCoordinates(
  geometry: GeoJsonGeometry | null,
  visitor: (coordinate: [number, number]) => void,
) {
  if (!geometry) {
    return;
  }

  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries ?? []) {
      walkCoordinates(child, visitor);
    }
    return;
  }

  visitCoordinateValue(geometry.coordinates, visitor);
}

function visitCoordinateValue(
  value: unknown,
  visitor: (coordinate: [number, number]) => void,
) {
  if (!Array.isArray(value)) {
    return;
  }

  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    visitor([value[0], value[1]]);
    return;
  }

  for (const item of value) {
    visitCoordinateValue(item, visitor);
  }
}

function normalizeBoundingBox(value: unknown): [number, number, number, number] | null {
  if (
    Array.isArray(value)
    && value.length >= 4
    && typeof value[0] === "number"
    && typeof value[1] === "number"
    && typeof value[2] === "number"
    && typeof value[3] === "number"
  ) {
    return [value[0], value[1], value[2], value[3]];
  }

  return null;
}

function summarizeAnalysis(
  analysis: ReturnType<typeof analyzeStructuredText>,
): ResourceAnalysisResult["analysis"] {
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

function matchField(columns: AnalysisColumn[], requestedField: string, label: string): AnalysisColumn {
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

function normalizeForMatch(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function humanizeMapType(value: PreparedGeoJsonMap["mapType"]): string {
  const labels: Record<PreparedGeoJsonMap["mapType"], string> = {
    point: "Point map",
    choropleth: "Choropleth map",
    boundary: "Boundary map",
    line: "Line map",
    mixed: "Mixed-geometry map",
  };

  return labels[value];
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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

function isFeatureCollection(value: unknown): value is GeoJsonFeatureCollection {
  return isRecord(value) && value.type === "FeatureCollection" && Array.isArray(value.features) && value.features.every(isFeature);
}

function isFeature(value: unknown): value is GeoJsonFeature {
  return isRecord(value) && value.type === "Feature" && "geometry" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
