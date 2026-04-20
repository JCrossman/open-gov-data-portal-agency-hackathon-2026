import test from "node:test";
import assert from "node:assert/strict";
import { resolveFilterGroupInput } from "./user-inputs.js";

test("resolveFilterGroupInput understands friendly labels and raw keys", () => {
  assert.equal(resolveFilterGroupInput("Organization"), "owner_org");
  assert.equal(resolveFilterGroupInput("Format"), "resource_format");
  assert.equal(resolveFilterGroupInput("API enabled"), "datastore_enabled");
  assert.equal(resolveFilterGroupInput("subject_en"), "subject_en");
});
