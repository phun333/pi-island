#!/usr/bin/env node
// Stop any already-running pi-island companion/native host so the next pi
// status frame respawns them from the current install/link. This is useful
// after `npm link`, `pi update`, or native host rebuilds: the companion is a
// long-lived daemon and otherwise keeps old HTML/JS/native code in memory.

import { spawnSync } from "node:child_process";

function run(cmd, args) {
  spawnSync(cmd, args, { stdio: "ignore" });
}

if (process.platform === "win32") {
  run("taskkill.exe", ["/F", "/T", "/IM", "island-host-win.exe"]);
  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$ErrorActionPreference='SilentlyContinue'; " +
      "Get-CimInstance Win32_Process | " +
      "Where-Object { $_.CommandLine -match 'pi-island[\\\\/]pi-extension[\\\\/]companion\\.mjs' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
  ]);
} else {
  run("pkill", ["-TERM", "-f", "pi-island/pi-extension/companion.mjs"]);
  run("pkill", ["-TERM", "-f", "pi-island/pi-extension/island-host-bin"]);
}

console.log("[pi-island] stopped existing companion/host if one was running");
