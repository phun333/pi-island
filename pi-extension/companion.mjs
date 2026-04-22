#!/usr/bin/env node
// pi-island companion daemon
// ----------------------------
// Single long-lived process per user that:
//   1. Owns the one native WebView window (top of primary screen).
//   2. Runs a Unix socket server at ~/.pi/pi-island.sock.
//   3. Accepts JSON-line messages from every pi extension client and
//      renders each connected session as its own row in the stack.
//
// Protocol (client → server, one JSON object per line):
//   { "id": "<session-uuid>", "type": "update",
//     "project": "...", "status": "thinking", "detail": "...",
//     "prompt": "...", "ctxPct": 34, "frozenElapsed": <ms>|null }
//   { "id": "<session-uuid>", "type": "remove" }
//   { "id": "<session-uuid>", "type": "mode",    "mode":  "normal"|"notch" }
//   { "id": "<session-uuid>", "type": "scale",   "scale": "small"|"medium"|"large" }
//   { "id": "<session-uuid>", "type": "respawn" }
//
// On startup the companion also reads ~/.pi/pi-island.json for settings it
// owns (screen, notchMode). Clients bump those via the `respawn` message
// after updating the pref file — NSWindow geometry is fixed at spawn so a
// live screen change requires a fresh process.
//
// When the last client disconnects we keep the window for 6s so a quick
// reconnect (pi /new, /reload, etc.) doesn't flash the capsule closed,
// then exit cleanly.

import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { openFixed } from "./open-fixed.mjs";
import { buildIslandHTML } from "./island.html.mjs";
import { SOCK } from "./socket-path.mjs";

// ---- User preference --------------------------------------------------
// Small subset of ~/.pi/pi-island.json that this process cares about.
// The client-side extension owns the full schema; we only read the two
// fields that drive geometry (screen + notchMode) and silently ignore
// the rest so old/new formats coexist.
const PREF_FILE = join(homedir(), ".pi", "pi-island.json");

function readPref() {
  try {
    if (!existsSync(PREF_FILE)) return {};
    const data = JSON.parse(readFileSync(PREF_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch { return {}; }
}

// ---- Screen geometry ------------------------------------------------------
// Pick the target NSScreen based on the user preference:
//
//   "primary"  → NSScreen.screens[0]  (menu-bar screen, AGENT.md §6.1 original)
//   "active"   → screen under the mouse cursor at spawn (multi-monitor follow)
//   "N" (1..)  → specific display index (1 == screens[0] == primary)
//
// Any unknown / missing value falls back to primary. We still return the
// screen's *global* origin so the caller can place the window in global
// coordinate space (Cocoa uses bottom-left) on multi-monitor setups.
function buildScreenSelectorJXA(screenPref) {
  if (screenPref === "active") {
    return (
      "const mouse = $.NSEvent.mouseLocation;" +
      "const all = $.NSScreen.screens.js;" +
      "for (const scr of all) {" +
      "  const f = scr.frame;" +
      "  if (mouse.x >= f.origin.x && mouse.x < f.origin.x + f.size.width &&" +
      "      mouse.y >= f.origin.y && mouse.y < f.origin.y + f.size.height) {" +
      "    s = scr; break;" +
      "  }" +
      "}" +
      "if (!s) s = $.NSScreen.mainScreen;"
    );
  }
  const idx = parseInt(screenPref, 10);
  if (Number.isFinite(idx) && idx >= 1) {
    // Clamp to available screens inside the JXA runtime so out-of-range
    // indices don't explode — fall back to screens[0].
    return (
      "const all = $.NSScreen.screens.js;" +
      `s = all[${idx - 1}] || all[0];`
    );
  }
  // "primary" or anything unknown.
  return "s = $.NSScreen.screens.js[0];";
}

function getScreenGeometry(screenPref) {
  try {
    const script =
      "ObjC.import('AppKit');" +
      "let s = null;" +
      buildScreenSelectorJXA(screenPref) +
      "if (!s || !s.frame) s = $.NSScreen.screens.js[0];" +
      "const f = s.frame;" +
      "const sa = (s.safeAreaInsets && s.safeAreaInsets.top) || 0;" +
      "JSON.stringify({x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height, notch: sa})";
    const out = execSync(`osascript -l JavaScript -e ${JSON.stringify(script)}`, {
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    const j = JSON.parse(out);
    if (Number.isFinite(j.w) && Number.isFinite(j.h)) {
      return {
        x:      Math.round(j.x || 0),
        y:      Math.round(j.y || 0),
        width:  Math.round(j.w),
        height: Math.round(j.h),
        notch:  Math.round(j.notch || 0),
      };
    }
  } catch { /* fall through */ }
  return { x: 0, y: 0, width: 1440, height: 900, notch: 0 };
}

// ---- Window setup ---------------------------------------------------------
// Tall enough to fit several stacked rows without ever needing a resize
// (the host window can't be resized after spawn). The extra vertical area
// is transparent + clickThrough so it doesn't affect anything.
const WIN_W = 640;
const WIN_H = 420; // room for ~10 rows comfortably

// Pull settings from the pref file (client may have written them before
// spawning us). Missing / bogus values fall back to safe defaults.
const _pref = readPref();
const SCREEN_PREF =
  typeof _pref.screen === "string" && _pref.screen.length > 0
    ? _pref.screen
    : "primary";
const NOTCH_PREF =
  _pref.notchMode === "normal" || _pref.notchMode === "notch"
    ? _pref.notchMode
    : "auto";

const {
  x: screenX,
  y: screenY,
  width:  screenW,
  height: screenH,
  notch:  notchH,
} = getScreenGeometry(SCREEN_PREF);

// Place the window top-center of the chosen screen, in the global
// coordinate space (macOS uses bottom-left origin; larger y = further up).
const x = Math.round(screenX + (screenW - WIN_W) / 2);
const y = Math.round(screenY + screenH - WIN_H);

// Resolve the notch policy:
//   "normal"  → force off regardless of detection
//   "notch"   → force on regardless of detection
//   anything else ("auto") → use the detected value
const autoMode =
  NOTCH_PREF === "normal" ? "normal" :
  NOTCH_PREF === "notch"  ? "notch"  :
  (notchH > 0 ? "notch" : "normal");

const win = openFixed(buildIslandHTML(), {
  width: WIN_W, height: WIN_H, x, y,
  frameless: true, floating: true, transparent: true,
  clickThrough: true, noDock: true,
});

let winReady = false;
const pending = [];
function send(js) {
  if (winReady) try { win.send(js); } catch {}
  else pending.push(js);
}

win.on("ready", () => {
  winReady = true;
  send(`window.island.setMode(${JSON.stringify(autoMode)})`);
  for (const js of pending.splice(0)) win.send(js);
});
win.on("closed", () => { cleanup(); process.exit(0); });
win.on("error", () => { /* keep running; the host may emit harmless errors */ });

// ---- Socket server --------------------------------------------------------
if (existsSync(SOCK)) {
  try { unlinkSync(SOCK); } catch {}
}

const clients = new Set();
let idleTimer = null;

function scheduleIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (clients.size === 0) {
      cleanup();
      process.exit(0);
    }
  }, 6000);
}

const server = createServer((sock) => {
  clients.add(sock);
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

  let clientId = null;
  const rl = createInterface({ input: sock, crlfDelay: Infinity });

  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || !msg.id) return;
    clientId = msg.id;

    if (msg.type === "remove") {
      send(`window.island.removeRow(${JSON.stringify(msg.id)})`);
      return;
    }
    if (msg.type === "mode" && (msg.mode === "normal" || msg.mode === "notch")) {
      send(`window.island.setMode(${JSON.stringify(msg.mode)})`);
      return;
    }
    if (msg.type === "scale" && typeof msg.scale === "string") {
      // WebView clamps unknown scales to medium — we don't need to validate
      // here, just forward. This keeps the companion agnostic to the preset
      // list so new sizes can land in index.ts + island.html.mjs without a
      // companion change.
      send(`window.island.setScale(${JSON.stringify(msg.scale)})`);
      return;
    }
    if (msg.type === "respawn") {
      // Graceful shutdown so the client's next ensureConnection() spawns
      // a fresh companion that re-reads the pref file (new screen / notch).
      cleanup();
      process.exit(0);
      return;
    }
    // Default: treat as an upsert.
    send(`window.island.upsertRow(${JSON.stringify(msg.id)},${JSON.stringify(msg)})`);
  });

  sock.on("close", () => {
    clients.delete(sock);
    if (clientId) send(`window.island.removeRow(${JSON.stringify(clientId)})`);
    if (clients.size === 0) scheduleIdleExit();
  });
  sock.on("error", () => {});
});

server.on("error", (err) => {
  // Another companion is already running. Exit silently — the extension
  // will just connect to the existing one.
  if (err && err.code === "EADDRINUSE") {
    cleanup();
    process.exit(0);
  }
});

server.listen(SOCK, () => { /* ready */ });

// ---- Cleanup --------------------------------------------------------------
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { server.close(); } catch {}
  try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {}
  try { win.close(); } catch {}
}
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT",  () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
