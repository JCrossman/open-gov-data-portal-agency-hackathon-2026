import test from "node:test";
import assert from "node:assert/strict";
import { buildPortalSearchUrl, extractDatasetIdentifier, isStructuredTextResource } from "./helpers.js";

test("buildPortalSearchUrl encodes portal search parameters", () => {
  const url = buildPortalSearchUrl({
    query: "climate",
    page: 2,
    sort: "title_translated_eng asc",
    filters: {
      owner_org: ["casdo-ocena", "atssc-scdata"],
      datastore_enabled: ["True"],
    },
  });

  assert.equal(
    url,
    "https://search.open.canada.ca/opendata/?wbdisable=true&search_text=climate&page=2&sort=title_translated_eng+asc&owner_org=casdo-ocena%7Catssc-scdata&datastore_enabled=True",
  );
});

test("extractDatasetIdentifier accepts either an ID or an open.canada URL", () => {
  assert.equal(
    extractDatasetIdentifier("https://open.canada.ca/data/en/dataset/b5690169-7f36-e278-29d5-e45ca29a8ade"),
    "b5690169-7f36-e278-29d5-e45ca29a8ade",
  );
  assert.equal(
    extractDatasetIdentifier("b5690169-7f36-e278-29d5-e45ca29a8ade"),
    "b5690169-7f36-e278-29d5-e45ca29a8ade",
  );
});

test("isStructuredTextResource recognizes text-like formats and MIME types", () => {
  assert.equal(isStructuredTextResource("CSV", null, null), true);
  assert.equal(isStructuredTextResource(null, "application/json; charset=utf-8", null), true);
  assert.equal(isStructuredTextResource(null, "application/pdf", "https://example.com/file.pdf"), false);
});
