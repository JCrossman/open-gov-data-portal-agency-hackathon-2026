import test from "node:test";
import assert from "node:assert/strict";
import { analyzeStructuredText, buildChartFromAnalysis } from "./analysis.js";

test("analyzeStructuredText profiles CSV columns and suggests charts", () => {
  const analysis = analyzeStructuredText({
    text: [
      "date,province,value",
      "2024-01-01,Ontario,10",
      "2024-02-01,Ontario,15",
      "2024-03-01,Quebec,12",
    ].join("\n"),
    previewTruncated: false,
    format: "CSV",
    contentType: "text/csv",
    url: "https://example.com/data.csv",
  });

  assert.equal(analysis.detectedFormat, "csv");
  assert.equal(analysis.rowCount, 3);
  assert.equal(analysis.columns.find((column) => column.name === "date")?.semanticRole, "time");
  assert.equal(analysis.columns.find((column) => column.name === "value")?.semanticRole, "measure");
  assert.ok(analysis.suggestions.some((suggestion) => suggestion.chartType === "line"));
});

test("buildChartFromAnalysis prepares a line chart from time-series data", () => {
  const analysis = analyzeStructuredText({
    text: [
      "date,province,value",
      "2024-01-01,Ontario,10",
      "2024-02-01,Ontario,15",
      "2024-03-01,Quebec,12",
    ].join("\n"),
    previewTruncated: false,
    format: "CSV",
    contentType: "text/csv",
    url: "https://example.com/data.csv",
  });

  const chart = buildChartFromAnalysis(analysis, { chartType: "line" });

  assert.equal(chart.chartType, "line");
  assert.equal(chart.xField, "date");
  assert.equal(chart.yField, "value");
  assert.equal(chart.aggregation, "none");
  assert.deepEqual(chart.points[0], {
    date: "2024-01-01",
    value: 10,
  });
});

test("analyzeStructuredText supports JSON payloads with result.records", () => {
  const analysis = analyzeStructuredText({
    text: JSON.stringify({
      result: {
        records: [
          { province: "Ontario", total: 10 },
          { province: "Quebec", total: 8 },
        ],
      },
    }),
    previewTruncated: false,
    format: "JSON",
    contentType: "application/json",
    url: "https://example.com/data.json",
  });

  assert.equal(analysis.detectedFormat, "json");
  assert.equal(analysis.rowCount, 2);
  assert.ok(analysis.warnings.some((warning) => warning.includes("result.records")));
  const chart = buildChartFromAnalysis(analysis, { chartType: "bar" });
  assert.equal(chart.chartType, "bar");
  assert.equal(chart.xField, "province");
  assert.equal(chart.yField, "total");
});
