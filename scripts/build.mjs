#!/usr/bin/env node
// Compiles pi-extension/island-host.swift into a native binary.
// Produces: pi-extension/island-host-bin (macOS only)
//
// The Swift host is a tiny Cocoa + WebKit shell that opens a single
// WKWebView window. Two things it does that a generic WebView host
// doesn't, and that Dynamic-Island positioning requires:
//   1. window.level = .statusBar  (draws above the menu bar, not below)
//   2. constrainFrameRect override (keeps the window where we place it
//      instead of letting AppKit pull it into visibleFrame)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const swiftFile = join(repoRoot, "pi-extension", "island-host.swift");
const outputBin = join(repoRoot, "pi-extension", "island-host-bin");

if (process.platform !== "darwin") {
  console.log("[pi-island] Not macOS — skipping native build.");
  process.exit(0);
}

if (!existsSync(swiftFile)) {
  console.error("[pi-island] Missing swift source:", swiftFile);
  process.exit(1);
}

const swiftc = spawnSync("swiftc", ["-O", swiftFile, "-o", outputBin], {
  stdio: "inherit",
});

if (swiftc.status !== 0) {
  console.error("[pi-island] swiftc failed with status", swiftc.status);
  process.exit(swiftc.status ?? 1);
}

console.log("[pi-island] Built", outputBin);
