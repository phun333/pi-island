#!/usr/bin/env node
// Runs after `npm install` / `pi install`.
//
// Strategy (in order):
//   1. Try to find the pre-built binary from the platform-specific
//      optional package (@pi-island/darwin-arm64, win32-x64, etc.).
//      This is the normal path for end users — no compiler needed.
//   2. If not found (git clone, npm link, network failure), fall back
//      to compiling from source if the right compiler is available.
//   3. If neither works, write a .build-skipped marker and exit cleanly.
//      The extension will no-op until `npm run build` succeeds.

import { copyFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const skippedMarker = join(repoRoot, ".build-skipped");
const buildScript = join(here, "build.mjs");

rmSync(skippedMarker, { force: true });

// ── Platform detection ─────────────────────────────────────────────────────
const PLATFORM_MAP = {
  "darwin-arm64": { pkg: "@pi-island/darwin-arm64", bin: "island-host-bin",     out: "island-host-bin" },
  "darwin-x64":   { pkg: "@pi-island/darwin-x64",   bin: "island-host-bin",     out: "island-host-bin" },
  "win32-x64":    { pkg: "@pi-island/win32-x64",    bin: "island-host-win.exe", out: "island-host-win.exe" },
};

const key = `${process.platform}-${process.arch}`;
const entry = PLATFORM_MAP[key];

if (!entry) {
  if (process.platform === "darwin" || process.platform === "win32") {
    console.log(`[pi-island] ${key}: no pre-built binary available. Trying source build...`);
    fallbackBuild();
  } else {
    console.log(`[pi-island] ${process.platform} is not supported — extension will no-op.`);
  }
  process.exit(0);
}

// ── Step 1: Try platform package ───────────────────────────────────────────
const dst = join(repoRoot, "pi-extension", entry.out);

try {
  // Use createRequire to resolve the platform package from the install tree.
  const require = createRequire(join(repoRoot, "package.json"));
  const pkgJsonPath = require.resolve(`${entry.pkg}/package.json`);
  const pkgDir = dirname(pkgJsonPath);
  const src = join(pkgDir, entry.bin);

  if (existsSync(src)) {
    copyFileSync(src, dst);
    if (process.platform !== "win32") chmodSync(dst, 0o755);
    console.log(`[pi-island] Installed ${key} host binary from ${entry.pkg}.`);
    process.exit(0);
  }
} catch {
  // Platform package not found — fall through to source build.
}

// ── Step 2: Fallback to source build ───────────────────────────────────────
console.log(`[pi-island] ${entry.pkg} not found — trying source build...`);
fallbackBuild();

function fallbackBuild() {
  if (process.platform === "darwin") {
    if (!hasCommand("swiftc")) {
      skip(
        "swiftc not found. Install Xcode Command Line Tools:\n" +
        "    xcode-select --install\n" +
        "then run: npm run build"
      );
      return;
    }
  } else if (process.platform === "win32") {
    if (!hasCommand("dotnet")) {
      skip(
        "dotnet not found. Install .NET 8 SDK:\n" +
        "    winget install Microsoft.DotNet.SDK.8\n" +
        "then run: npm run build"
      );
      return;
    }
  } else {
    skip(`${process.platform} is not supported.`);
    return;
  }

  const result = spawnSync(process.execPath, [buildScript], { stdio: "inherit" });
  if (result.status !== 0) {
    skip("Source build failed. Run `npm run build` manually for details.");
  }
}

function hasCommand(cmd) {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8", stdio: "pipe" });
  return !r.error && r.status === 0;
}

function skip(msg) {
  writeFileSync(skippedMarker, msg + "\n");
  console.warn("[pi-island] " + msg);
}
