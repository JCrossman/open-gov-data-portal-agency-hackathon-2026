import { defineConfig, devices } from "@playwright/test";

const BASE_URL =
  process.env.BASE_URL ??
  "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/audit",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "audit-results.json" }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "off",
    screenshot: "only-on-failure",
    extraHTTPHeaders: {},
    storageState: {
      cookies: [
        {
          name: "opengov_access",
          value: process.env.ACCESS_CODE ?? (() => { throw new Error("ACCESS_CODE env var is required"); })(),
          domain: new URL(BASE_URL).hostname,
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: BASE_URL.startsWith("https"),
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
