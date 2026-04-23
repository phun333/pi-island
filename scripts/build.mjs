#!/usr/bin/env node
// Compiles the native host binary for the current platform.
//
// macOS:   swiftc hosts/macos/island-host.swift → pi-extension/island-host-bin
// Windows: dotnet publish hosts/windows/...     → pi-extension/island-host-win.exe
//
// This is the LOCAL DEV build path. End users get pre-built binaries
// from platform packages (@pi-island/darwin-arm64, win32-x64, etc.)
// via postinstall.mjs. This script is only needed when developing
// from a git clone or when the platform package is unavailable.

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// ── macOS ──────────────────────────────────────────────────────────────────
if (process.platform === "darwin") {
  const swiftFile = join(repoRoot, "hosts", "macos", "island-host.swift");
  // Fallback: check old location too (pre-refactor installs via npm)
  const swiftFallback = join(repoRoot, "pi-extension", "island-host.swift");
  const source = existsSync(swiftFile) ? swiftFile : swiftFallback;
  const outputBin = join(repoRoot, "pi-extension", "island-host-bin");

  if (!existsSync(source)) {
    console.error("[pi-island] Missing Swift source:", swiftFile);
    process.exit(1);
  }

  const result = spawnSync("swiftc", ["-O", source, "-o", outputBin], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    console.error("[pi-island] swiftc failed with status", result.status);
    process.exit(result.status ?? 1);
  }

  console.log("[pi-island] Built", outputBin);
  process.exit(0);
}

// ── Windows ────────────────────────────────────────────────────────────────
if (process.platform === "win32") {
  const csproj = join(repoRoot, "hosts", "windows", "island-host.csproj");
  // Build output goes directly into pi-extension/hosts/windows/ where
  // open-fixed.mjs expects it. Framework-dependent builds produce multiple
  // files (.exe + .dll + .deps.json + runtimes/) that must stay together.
  const outDir = join(repoRoot, "pi-extension", "hosts", "windows");
  const outputExe = join(outDir, "island-host-win.exe");

  if (!existsSync(csproj)) {
    console.error("[pi-island] Missing csproj:", csproj);
    process.exit(1);
  }

  // Check for dotnet CLI
  const dotnetCheck = spawnSync("dotnet", ["--version"], { encoding: "utf8" });
  if (dotnetCheck.error || dotnetCheck.status !== 0) {
    console.error(
      "[pi-island] dotnet CLI not found. Install .NET 8 SDK:\n" +
      "    winget install Microsoft.DotNet.SDK.8"
    );
    process.exit(1);
  }

  console.log("[pi-island] Building Windows host (this may take a minute on first run)...");
  const result = spawnSync("dotnet", [
    "publish", csproj,
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "false",
    "-o", outDir,
    "--nologo",
  ], { stdio: "inherit" });

  if (result.status !== 0) {
    console.error("[pi-island] dotnet publish failed with status", result.status);
    process.exit(result.status ?? 1);
  }

  if (!existsSync(outputExe)) {
    console.error("[pi-island] Build succeeded but exe not found at", outputExe);
    process.exit(1);
  }

  console.log("[pi-island] Built", outputExe);
  process.exit(0);
}

// ── Unsupported ────────────────────────────────────────────────────────────
console.log("[pi-island] Unsupported platform:", process.platform, "— skipping build.");
process.exit(0);
