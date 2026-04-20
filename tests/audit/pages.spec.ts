import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { allUrls } from "./urls";

const FORBIDDEN_TEXT = [
  /CLAUDE\.md/i,
  /ChallengePrompts/i,
  /constitutional\s+guardrail/i,
  /Challenge\s+\d+\s+guardrail/i,
  /per\s+Rule\s+\d+/i,
];

for (const u of allUrls) {
  test.describe(`page contract ${u.path}`, () => {
    test("loads with 200 + expected heading + no internal-doc leaks", async ({ page }) => {
      const resp = await page.goto(u.path, { waitUntil: "domcontentloaded" });
      expect(resp, "navigation response").not.toBeNull();
      expect(resp!.status(), `HTTP status for ${u.path}`).toBeLessThan(400);

      const bodyText = await page.textContent("body");
      expect(bodyText ?? "", `body text on ${u.path}`).toMatch(new RegExp(u.heading, "i"));

      for (const re of FORBIDDEN_TEXT) {
        expect(bodyText ?? "", `forbidden phrase ${re} on ${u.path}`).not.toMatch(re);
      }
    });

    test("sortable tables expose aria-sort on header cells", async ({ page }) => {
      test.skip(!u.requiresSortableTable, "table sortability not required for this page");
      await page.goto(u.path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);

      const tables = page.locator("table");
      const tableCount = await tables.count();
      expect(tableCount, `at least one <table> on ${u.path}`).toBeGreaterThan(0);

      const ariaSorted = page.locator("th[aria-sort]");
      const sortedCount = await ariaSorted.count();
      expect(sortedCount, `at least one sortable <th> on ${u.path}`).toBeGreaterThan(0);
    });

    test("axe-core WCAG 2.1 AA — no serious or critical violations", async ({ page }) => {
      test.skip(!!u.skipAxe, "axe explicitly skipped for this page");
      await page.goto(u.path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .disableRules(["color-contrast"])
        .analyze();

      const blocking = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      if (blocking.length > 0) {
        console.error(
          `[axe ${u.path}] ${blocking.length} blocking violation(s):`,
          blocking.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.length,
            sample: v.nodes[0]?.html?.slice(0, 200),
          })),
        );
      }
      expect(blocking, `axe blocking violations on ${u.path}`).toHaveLength(0);
    });
  });
}
