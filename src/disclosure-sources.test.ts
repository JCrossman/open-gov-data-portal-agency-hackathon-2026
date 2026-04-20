import test from "node:test";
import assert from "node:assert/strict";
import { DISCLOSURE_SOURCES, findDisclosureSourceByTopic, getDisclosureSource, getDisclosureSourcesByDomain } from "./disclosure-sources.js";

test("getDisclosureSource returns known sources and null for unknown", () => {
  const contracts = getDisclosureSource("contracts");
  assert.ok(contracts);
  assert.equal(contracts.title, "Contracts over $10,000");
  assert.equal(contracts.domain, "spending");

  assert.equal(getDisclosureSource("nonexistent"), null);
});

test("getDisclosureSourcesByDomain filters correctly", () => {
  const spending = getDisclosureSourcesByDomain("spending");
  assert.ok(spending.length >= 2);
  assert.ok(spending.every((source) => source.domain === "spending"));

  const travel = getDisclosureSourcesByDomain("travel");
  assert.ok(travel.length >= 3);
  assert.ok(travel.every((source) => source.domain === "travel"));
});

test("findDisclosureSourceByTopic matches by title, description, and example queries", () => {
  const contractMatches = findDisclosureSourceByTopic("contract");
  assert.ok(contractMatches.some((source) => source.id === "contracts"));

  const travelMatches = findDisclosureSourceByTopic("travel");
  assert.ok(travelMatches.some((source) => source.id === "travel"));

  const grantMatches = findDisclosureSourceByTopic("grant");
  assert.ok(grantMatches.some((source) => source.id === "grants"));
});

test("all disclosure sources have required fields", () => {
  for (const source of DISCLOSURE_SOURCES) {
    assert.ok(source.id, `source missing id`);
    assert.ok(source.title, `${source.id} missing title`);
    assert.ok(source.searchUrl.startsWith("https://"), `${source.id} missing valid searchUrl`);
    assert.ok(source.exampleQueries.length > 0, `${source.id} missing example queries`);
  }
});
