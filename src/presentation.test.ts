import test from "node:test";
import assert from "node:assert/strict";
import type { ChartPreparationResult, ResourceAnalysisResult } from "./analysis.js";
import type { DiscoveryTopicOverview } from "./discovery.js";
import type { GeoJsonMapResult } from "./mapping.js";
import type { PortalSearchResponse } from "./portal.js";
import { formatAnalysisText, formatChartText, formatDiscoveryText, formatFilterOptionsText, formatMapText, formatSearchResultsText } from "./presentation.js";

test("formatFilterOptionsText shows filter groups with examples", () => {
  const text = formatFilterOptionsText({
    groups: [
      {
        heading: "Organization",
        param: "owner_org",
        optionCount: 2,
        options: [
          { value: "nrcan-rncan", label: "Natural Resources Canada", count: 100, selected: false },
          { value: "hc-sc", label: "Health Canada", count: 50, selected: false },
        ],
      },
      {
        heading: "Format",
        param: "resource_format",
        optionCount: 2,
        options: [
          { value: "CSV", label: "CSV", count: 10, selected: false },
          { value: "JSON", label: "JSON", count: 5, selected: false },
        ],
      },
    ],
  });

  assert.match(text, /Open Government Portal filter groups/);
  assert.match(text, /Organization — 2 values/);
  assert.match(text, /Natural Resources Canada/);
  assert.match(text, /Format — 2 values/);
});

test("formatSearchResultsText includes readable result details", () => {
  const response: PortalSearchResponse = {
    sourceUrl: "https://search.open.canada.ca/opendata/?wbdisable=true&search_text=climate&page=1&sort=score+desc",
    query: "climate",
    page: 1,
    sort: "score desc",
    totalRecords: 2781,
    pageSize: 10,
    totalPages: 279,
    results: [
      {
        datasetId: "abc",
        datasetUrl: "https://open.canada.ca/data/en/dataset/abc",
        title: "Climate",
        summary: "Climate summary",
        jurisdictionLabel: "Provincial / Territorial",
        recordModified: "Jul 2, 2024",
        recordReleased: "Mar 20, 2023",
        publisher: "Government of Northwest Territories",
        formats: ["CSV", "JSON"],
        keywords: ["climate"],
      },
    ],
  };

  const text = formatSearchResultsText({
    result: response,
    appliedFilters: [
      {
        key: "owner_org",
        title: "Organization",
        labels: ["Natural Resources Canada"],
        values: ["nrcan-rncan"],
      },
    ],
    unresolvedInputs: [],
  });

  assert.match(text, /Found 2,781 records/);
  assert.match(text, /Active filters: Organization: Natural Resources Canada/);
  assert.match(text, /1\. Climate/);
  assert.match(text, /Publisher: Government of Northwest Territories/);
  assert.match(text, /Dataset URL: https:\/\/open\.canada\.ca\/data\/en\/dataset\/abc/);
});

test("formatAnalysisText includes candidate fields and sample rows", () => {
  const result: ResourceAnalysisResult = {
    dataset: {
      id: "abc",
      title: "Climate observations",
      url: "https://open.canada.ca/data/en/dataset/abc",
    },
    resource: {
      id: "res1",
      name: "Monthly climate CSV",
      format: "CSV",
      resourceType: "dataset",
      url: "https://example.com/climate.csv",
      mimeType: "text/csv",
      datastoreActive: false,
      selectedAutomatically: true,
    },
    selectionNote: "Automatically selected the most analysis-friendly resource: Monthly climate CSV (CSV).",
    scope: {
      maxBytes: 1_000_000,
      bytesRead: 240,
      contentType: "text/csv",
      completeness: "complete_resource",
      note: "The fetched content fit within the analysis byte limit.",
    },
    analysis: {
      detectedFormat: "csv",
      rowCount: 3,
      columnCount: 3,
      columns: [
        {
          name: "date",
          inferredType: "date",
          semanticRole: "time",
          nonNullCount: 3,
          nullCount: 0,
          distinctCount: 3,
          examples: ["2024-01-01"],
          dateSummary: {
            earliest: "2024-01-01",
            latest: "2024-03-01",
          },
        },
        {
          name: "province",
          inferredType: "string",
          semanticRole: "geography",
          nonNullCount: 3,
          nullCount: 0,
          distinctCount: 2,
          examples: ["Ontario", "Quebec"],
        },
        {
          name: "value",
          inferredType: "number",
          semanticRole: "measure",
          nonNullCount: 3,
          nullCount: 0,
          distinctCount: 3,
          examples: ["10", "15", "12"],
          numberSummary: {
            min: 10,
            max: 15,
            mean: 12.333,
          },
        },
      ],
      sampleRows: [
        { date: "2024-01-01", province: "Ontario", value: 10 },
        { date: "2024-02-01", province: "Ontario", value: 15 },
      ],
      suggestions: [
        {
          chartType: "line",
          title: "value over date",
          xField: "date",
          yField: "value",
          reasoning: "The resource includes a time-like field and a numeric measure.",
        },
      ],
      warnings: [],
    },
  };

  const text = formatAnalysisText(result);
  assert.match(text, /Best candidate fields/);
  assert.match(text, /Time: date/);
  assert.match(text, /Measures: value/);
  assert.match(text, /\| date \| province \| value \|/);
});

test("formatChartText includes chart reasoning and a data preview table", () => {
  const result: ChartPreparationResult = {
    dataset: {
      id: "abc",
      title: "Climate observations",
      url: "https://open.canada.ca/data/en/dataset/abc",
    },
    resource: {
      id: "res1",
      name: "Monthly climate CSV",
      format: "CSV",
      resourceType: "dataset",
      url: "https://example.com/climate.csv",
      mimeType: "text/csv",
      datastoreActive: false,
      selectedAutomatically: true,
    },
    selectionNote: null,
    scope: {
      maxBytes: 1_000_000,
      bytesRead: 240,
      contentType: "text/csv",
      completeness: "complete_resource",
      note: "The fetched content fit within the analysis byte limit.",
    },
    analysis: {
      detectedFormat: "csv",
      rowCount: 3,
      columnCount: 3,
      columns: [],
      sampleRows: [],
      suggestions: [],
      warnings: [],
    },
    chart: {
      chartType: "line",
      title: "value over date",
      xField: "date",
      yField: "value",
      sourceYField: "value",
      groupField: null,
      aggregation: "none",
      reasoning: "Prepared a line chart because the resource has a time field and a numeric measure.",
      pointCount: 3,
      points: [
        { date: "2024-01-01", value: 10 },
        { date: "2024-02-01", value: 15 },
      ],
      warnings: [],
      vegaLiteSpec: {
        mark: "line",
      },
    },
  };

  const text = formatChartText(result);
  assert.match(text, /Chart type: Line/);
  assert.match(text, /Why this chart:/);
  assert.match(text, /\| date \| value \|/);
});

test("formatMapText includes map reasoning and feature preview", () => {
  const result: GeoJsonMapResult = {
    dataset: {
      id: "abc",
      title: "Protected areas",
      url: "https://open.canada.ca/data/en/dataset/abc",
    },
    resource: {
      id: "res1",
      name: "Protected areas GeoJSON",
      format: "GEOJSON",
      resourceType: "dataset",
      url: "https://example.com/protected.geojson",
      mimeType: "application/geo+json",
      datastoreActive: false,
      selectedAutomatically: true,
    },
    selectionNote: "Automatically selected the most map-friendly GeoJSON resource: Protected areas GeoJSON (GEOJSON).",
    scope: {
      maxBytes: 2_000_000,
      bytesRead: 800,
      contentType: "application/geo+json",
      completeness: "complete_resource",
      note: "The fetched GeoJSON fit within the map byte limit.",
    },
    analysis: {
      detectedFormat: "geojson",
      rowCount: 2,
      columnCount: 2,
      columns: [
        {
          name: "name",
          inferredType: "string",
          semanticRole: "category",
          nonNullCount: 2,
          nullCount: 0,
          distinctCount: 2,
          examples: ["Park A", "Park B"],
        },
        {
          name: "value",
          inferredType: "number",
          semanticRole: "measure",
          nonNullCount: 2,
          nullCount: 0,
          distinctCount: 2,
          examples: ["10", "20"],
          numberSummary: {
            min: 10,
            max: 20,
            mean: 15,
          },
        },
      ],
      sampleRows: [
        { name: "Park A", value: 10 },
        { name: "Park B", value: 20 },
      ],
      suggestions: [],
      warnings: [],
    },
    map: {
      mapType: "choropleth",
      title: "Protected areas (Choropleth map)",
      geometryTypes: ["Polygon"],
      featureCount: 2,
      returnedFeatureCount: 2,
      labelField: "name",
      valueField: "value",
      reasoning: "Prepared a choropleth-style map because the GeoJSON contains polygon geometries.",
      boundingBox: [-80, 43, -71, 47],
      previewRows: [
        { feature_number: 1, geometry_type: "Polygon", name: "Park A", value: 10 },
        { feature_number: 2, geometry_type: "Polygon", name: "Park B", value: 20 },
      ],
      warnings: [],
      mapSpec: {
        type: "geojson-map",
        mapType: "choropleth",
        labelField: "name",
        valueField: "value",
        boundingBox: [-80, 43, -71, 47],
        featureCollection: {
          type: "FeatureCollection",
          features: [],
        },
      },
    },
  };

  const text = formatMapText(result);
  assert.match(text, /Map type: Choropleth map/);
  assert.match(text, /Geometry: Polygon/);
  assert.match(text, /Bounding box:/);
  assert.match(text, /\| feature_number \| geometry_type \| name \| value \|/);
});

test("formatDiscoveryText includes both open data and proactive disclosure sections", () => {
  const overview: DiscoveryTopicOverview = {
    topic: "climate",
    openData: {
      totalRecords: 2781,
      topPublishers: ["Natural Resources Canada", "Environment and Climate Change Canada"],
      topFormats: ["CSV", "JSON", "GEOJSON", "HTML"],
      topSubjects: ["Nature and Environment"],
      chartFriendlyFormats: ["CSV", "JSON"],
      mapFriendlyFormats: ["GEOJSON"],
      representativeDatasets: [
        {
          title: "Climate Normals",
          publisher: "Environment and Climate Change Canada",
          formats: ["CSV", "JSON"],
          datasetUrl: "https://open.canada.ca/data/en/dataset/abc",
          summary: "Historical climate normals for Canadian stations.",
          goodFor: ["analysis", "charting"],
        },
      ],
    },
    proactiveDisclosure: {
      matchingSources: [
        {
          id: "grants",
          title: "Grants and Contributions",
          description: "Federal grants and contributions.",
          searchUrl: "https://search.open.canada.ca/grants/",
          recordCount: "1,149,686",
          domain: "spending",
        },
      ],
    },
    suggestedNextSteps: [
      'Analyze and chart a top result: use analyze_dataset with "https://open.canada.ca/data/en/dataset/abc"',
      'Browse filters: use browse_filters to see what is available for "climate"',
    ],
  };

  const text = formatDiscoveryText(overview);
  assert.match(text, /Discovery overview: climate/);
  assert.match(text, /Found 2,781 datasets/);
  assert.match(text, /Natural Resources Canada/);
  assert.match(text, /Chart-friendly formats: CSV, JSON/);
  assert.match(text, /Map-friendly formats: GEOJSON/);
  assert.match(text, /1\. Climate Normals/);
  assert.match(text, /Good for: analysis, charting/);
  assert.match(text, /Proactive Disclosure Sources/);
  assert.match(text, /Grants and Contributions/);
  assert.match(text, /Suggested next steps/);
});
