#!/usr/bin/env node
// Static leak scanner — fails if forbidden internal-doc references appear in
// user-facing source files. See CLAUDE.md Rule 12.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOTS = ["app", "components"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git"]);
const ALLOWED_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mdx"]);

// Phrases that should never appear in user-facing UI text. Match is
// case-insensitive. Each entry is a regex source.
const FORBIDDEN = [
  /CLAUDE\.md/i,
  /ChallengePrompts/i,
  /ChallengePrompts\.md/i,
  /constitutional\s+guardrail/i,
  /constitution(al)?\s+rule/i,
  /Challenge\s+\d+\s+guardrail/i,
  /per\s+Rule\s+\d+/i,
  /HackathonChallengeDemo/i,
  /demo_output_\d/i,
];

// We scan only string literals and JSX text — comments are exempt. We
// approximate this by stripping line and block comments before searching.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : e.name.slice(dot);
      if (ALLOWED_EXT.has(ext)) yield p;
    }
  }
}

const violations = [];
for (const root of ROOTS) {
  try {
    await stat(root);
  } catch {
    continue;
  }
  for await (const file of walk(root)) {
    const raw = await readFile(file, "utf8");
    const code = stripComments(raw);
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      for (const re of FORBIDDEN) {
        if (re.test(line)) {
          violations.push({
            file,
            line: i + 1,
            pattern: re.source,
            text: line.trim().slice(0, 200),
          });
        }
      }
    });
  }
}

if (violations.length === 0) {
  console.log("[audit-leaks] clean — no forbidden phrases in app/ or components/");
  process.exit(0);
}

console.error(`[audit-leaks] FOUND ${violations.length} forbidden reference(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  /${v.pattern}/`);
  console.error(`    ${v.text}\n`);
}
process.exit(1);
