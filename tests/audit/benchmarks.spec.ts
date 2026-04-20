import { test, expect } from "@playwright/test";

type AbsenceCheck = {
  path: string;
  mustNotContain: string;
  reason: string;
};

const absenceChecks: AbsenceCheck[] = [
  { path: "/challenges/zombie-recipients", mustNotContain: "MASTERCARD FOUNDATION",  reason: "Field 4140 is investments, not gov funding" },
  { path: "/challenges/ghost-capacity",    mustNotContain: "MASTERCARD FOUNDATION",  reason: "Investment-dominated foundation, not a ghost entity" },
  { path: "/challenges/zombie-recipients", mustNotContain: "SOBEY FOUNDATION",       reason: "Field 4130 is investment income, not provincial funding" },
  { path: "/challenges/ghost-capacity",    mustNotContain: "GOUVERNEMENT DU QUÉBEC", reason: "Government entity, must be excluded from charity-ghost analysis" },
  { path: "/challenges/zombie-recipients", mustNotContain: "GOUVERNEMENT DU QUÉBEC", reason: "Government entity, must be excluded from zombie analysis" },
];

for (const a of absenceChecks) {
  test(`benchmark — ${a.mustNotContain} absent from ${a.path}`, async ({ page }) => {
    await page.goto(a.path, { waitUntil: "domcontentloaded" });
    const body = (await page.textContent("body")) ?? "";
    expect(
      body.toUpperCase().includes(a.mustNotContain.toUpperCase()),
      `${a.mustNotContain} should not appear on ${a.path} (${a.reason})`,
    ).toBeFalsy();
  });
}

test("benchmark — S.U.C.C.E.S.S. entity profile loads and shows grant data", async ({ page }) => {
  const resp = await page.goto("/entity/S.U.C.C.E.S.S.", { waitUntil: "domcontentloaded" });
  expect(resp?.status() ?? 0).toBeLessThan(400);
  const body = (await page.textContent("body")) ?? "";
  expect(body, "should mention S.U.C.C.E.S.S.").toMatch(/S\.U\.C\.C\.E\.S\.S\./i);
  expect(body, "should display dollar figures").toMatch(/\$[\d,]+/);
});
