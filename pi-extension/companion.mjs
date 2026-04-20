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
//   { "id": "<session-uuid>", "type": "mode", "mode": "normal"|"notch" }
//
// When the last client disconnects we keep the window for 6s so a quick
// reconnect (pi /new, /reload, etc.) doesn't flash the capsule closed,
// then exit cleanly.

import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { openFixed } from "./open-fixed.mjs";
import { buildIslandHTML } from "./island.html.mjs";
import { SOCK } from "./socket-path.mjs";

// ---- Screen geometry ------------------------------------------------------
// Same JXA probe used by earlier single-window mode. We target NSScreen.
// screens[0] (the primary / menu-bar screen) so the window stays put when
// focus moves between displays.
function getScreenGeometry() {
  try {
    const script =
      "ObjC.import('AppKit');" +
      "const s = $.NSScreen.screens.js[0];" +
      "const f = s.frame;" +
      "const sa = (s.safeAreaInsets && s.safeAreaInsets.top) || 0;" +
      "JSON.stringify({w: f.size.width, h: f.size.height, notch: sa})";
    const out = execSync(`osascript -l JavaScript -e ${JSON.stringify(script)}`, {
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    const j = JSON.parse(out);
    if (Number.isFinite(j.w) && Number.isFinite(j.h)) {
      return {
        width:  Math.round(j.w),
        height: Math.round(j.h),
        notch:  Math.round(j.notch || 0),
      };
    }
  } catch { /* fall through */ }
  return { width: 1440, height: 900, notch: 0 };
}

// ---- Window setup ---------------------------------------------------------
// Tall enough to fit several stacked rows without ever needing a resize
// (the host window can't be resized after spawn). The extra vertical area
// is transparent + clickThrough so it doesn't affect anything.
const WIN_W = 640;
const WIN_H = 420; // room for ~10 rows comfortably

const { width: screenW, height: screenH, notch: notchH } = getScreenGeometry();
const x = Math.max(0, Math.round((screenW - WIN_W) / 2));
const y = Math.max(0, screenH - WIN_H);

const autoMode = notchH > 0 ? "notch" : "normal";

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
