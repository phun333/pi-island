#!/usr/bin/env node
// Bumps the version across ALL package.json files in the monorepo
// (main package + platform binary packages) so they stay in sync.
//
// Usage:
//   node scripts/bump-version.mjs patch   # 0.2.1 → 0.2.2
//   node scripts/bump-version.mjs minor   # 0.2.1 → 0.3.0
//   node scripts/bump-version.mjs major   # 0.2.1 → 1.0.0
//   node scripts/bump-version.mjs 0.4.0   # explicit version

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const PACKAGE_FILES = [
  join(ROOT, "package.json"),
  join(ROOT, "packages", "darwin-arm64", "package.json"),
  join(ROOT, "packages", "darwin-x64", "package.json"),
  join(ROOT, "packages", "win32-x64", "package.json"),
];

const OPTIONAL_DEP_NAMES = [
  "@pi-island/darwin-arm64",
  "@pi-island/darwin-x64",
  "@pi-island/win32-x64",
];

// ── Parse argument ─────────────────────────────────────────────────────────
const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node bump-version.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

// Read current version from main package.json
const mainPkg = JSON.parse(readFileSync(PACKAGE_FILES[0], "utf8"));
const current = mainPkg.version;
const [maj, min, pat] = current.split(".").map(Number);

let next;
if (arg === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (arg === "minor") next = `${maj}.${min + 1}.0`;
else if (arg === "major") next = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else {
  console.error(`Invalid argument: "${arg}". Use patch, minor, major, or x.y.z`);
  process.exit(1);
}

console.log(`Bumping ${current} -> ${next}\n`);

// ── Update all package.json files ──────────────────────────────────────────
for (const file of PACKAGE_FILES) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = next;

  // Update optionalDependencies in the main package
  if (pkg.optionalDependencies) {
    for (const dep of OPTIONAL_DEP_NAMES) {
      if (dep in pkg.optionalDependencies) {
        pkg.optionalDependencies[dep] = next;
      }
    }
  }

  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  updated ${file.replace(ROOT, ".")}`);
}

console.log(`\nAll packages bumped to ${next}.`);
console.log("Next: git add -A && git commit && git tag v" + next);
