#!/usr/bin/env node
// Runs after `npm install` / `pi install`. Compiles the native Swift
// host binary on macOS. On other platforms or when swiftc is missing we
// skip gracefully — the extension itself no-ops off macOS.

import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const buildScript = join(here, "build.mjs");
const skippedMarker = join(repoRoot, ".build-skipped");

rmSync(skippedMarker, { force: true });

if (process.platform !== "darwin") {
  console.log("[pi-island] Not macOS — extension will no-op. Install complete.");
  process.exit(0);
}

function hasSwiftc() {
  const r = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

if (!hasSwiftc()) {
  const msg =
    "swiftc not found. Install Xcode Command Line Tools with:\n" +
    "    xcode-select --install\n" +
    "then run:  npm run build   (inside pi-island)";
  writeFileSync(skippedMarker, msg + "\n");
  console.warn("[pi-island] " + msg);
  process.exit(0);
}

const result = spawnSync(process.execPath, [buildScript], { stdio: "inherit" });
process.exit(result.status ?? 1);
