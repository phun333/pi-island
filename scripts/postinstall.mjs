#!/usr/bin/env node
// Runs after `npm install` / `pi install`. Compiles the native host
// binary for the current platform. On macOS this needs swiftc (Xcode
// CLI Tools), on Windows this needs the .NET 8 SDK.
//
// If the required compiler is missing, writes a .build-skipped marker
// and exits cleanly — the extension will no-op until `npm run build`.

import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const buildScript = join(here, "build.mjs");
const skippedMarker = join(repoRoot, ".build-skipped");

rmSync(skippedMarker, { force: true });

function hasCommand(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
  return !r.error && r.status === 0;
}

function hasDotnetSdk() {
  const r = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8", stdio: "pipe" });
  return !r.error && r.status === 0 && Boolean(r.stdout.trim());
}

if (process.platform === "darwin" && !hasCommand("swiftc")) {
  const msg =
    "swiftc not found. Install Xcode Command Line Tools:\n" +
    "    xcode-select --install\n" +
    "then run: npm run build";
  writeFileSync(skippedMarker, msg + "\n");
  console.warn("[pi-island] " + msg);
  process.exit(0);
}

if (process.platform === "win32" && !hasDotnetSdk()) {
  const msg =
    ".NET 8 SDK not found. Install it:\n" +
    "    winget install Microsoft.DotNet.SDK.8\n" +
    "then run: npm run build";
  writeFileSync(skippedMarker, msg + "\n");
  console.warn("[pi-island] " + msg);
  process.exit(0);
}

if (!["darwin", "win32"].includes(process.platform)) {
  console.log(`[pi-island] ${process.platform} is not supported — extension will no-op.`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [buildScript], { stdio: "inherit" });
process.exit(result.status ?? 1);
