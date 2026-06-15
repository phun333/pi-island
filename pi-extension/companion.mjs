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
//   { "id": "<session-uuid>", "type": "mode",         "mode":  "normal"|"notch" }
//   { "id": "<session-uuid>", "type": "scale",        "scale": "small"|"medium"|"large"|"xlarge" }
//   { "id": "<session-uuid>", "type": "prompt-hover", "enabled": true|false }
//   { "id": "<session-uuid>", "type": "respawn" }
//   { "id": "<session-uuid>", "type": "hello",        "version": "0.2.1" }
//
// Server → client (only for version handshake, one JSON object per line):
//   { "type": "hello-ack", "version": "0.2.1" }
//
// Unknown message types are IGNORED (not upserted). This is a deliberate
// break from pre-0.2.1 companions which treated the default branch as an
// upsert — older clients sending unknown types produced empty "ghost"
// rows. Every concrete type is dispatched explicitly now.
//
// On startup the companion also reads ~/.pi/pi-island.json for settings it
// owns at spawn time (screen, notchMode, initial promptHover). Clients
// bump geometry settings via the `respawn` message after updating the pref
// file. For OS display hot-plug/unplug, this daemon keeps client sockets
// alive and recreates only the native host window because host geometry is
// fixed at spawn.
//
// When the last client disconnects we keep the window for 6s so a quick
// reconnect (pi /new, /reload, etc.) doesn't flash the capsule closed,
// then exit cleanly.

import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openFixed } from "./open-fixed.mjs";
import { buildIslandHTML } from "./island.html.mjs";
import { SOCK } from "./socket-path.mjs";
import { getScreenGeometry, getDisplaySignature, computeWindowPosition, resolveNotchMode } from "./platform.mjs";

// ---- Version handshake ----------------------------------------------------
// Used by the client so it can notice a version mismatch (e.g. user ran
// `npm i pi-island` but we're still alive in-memory from the previous
// version) and trigger a self-respawn. See `versionHandshake` / auto-heal
// in pi-extension/index.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
function readCompanionVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch { return "0.0.0"; }
}
const COMPANION_VERSION = readCompanionVersion();

// ---- Status vocabulary ----------------------------------------------------
// Must stay in sync with the STATUS table in island.html.mjs and the
// toolToIsland map in index.ts. Updates with any other value are dropped
// at the companion boundary so malformed / version-mismatched clients
// can't leak empty "ghost" rows into the WebView. See AGENT.md §5.
const VALID_STATUS = new Set([
  "thinking", "reading", "editing", "writing",
  "running",  "searching", "done",    "error",
]);

// ---- User preference --------------------------------------------------
// Small subset of ~/.pi/pi-island.json that this process cares about.
// The client-side extension owns the full schema; we read geometry fields
// (screen + notchMode) plus the initial prompt-hover flag and silently
// ignore the rest so old/new formats coexist.
const PREF_FILE = join(homedir(), ".pi", "pi-island.json");

function readPref() {
  try {
    if (!existsSync(PREF_FILE)) return {};
    const data = JSON.parse(readFileSync(PREF_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch { return {}; }
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
const PROMPT_HOVER_PREF = _pref.promptHover !== false;

let currentMode = "normal";
let currentScale = null;
let currentPromptHover = PROMPT_HOVER_PREF;
let currentScreenGeo = null;
let cleaned = false;
let win = null;
let winReady = false;
const pending = [];
const ignoredHostCloses = new WeakSet();
const rowState = new Map();

function send(js) {
  if (winReady && win) try { win.send(js); } catch {}
  else pending.push(js);
}

function openIslandWindow() {
  currentScreenGeo = getScreenGeometry(SCREEN_PREF);
  const { x, y } = computeWindowPosition(currentScreenGeo, WIN_W, WIN_H);
  currentMode = resolveNotchMode(NOTCH_PREF, currentScreenGeo.notch);

  const nextWin = openFixed(buildIslandHTML(), {
    width: WIN_W, height: WIN_H, x, y,
    frameless: true, floating: true, transparent: true,
    clickThrough: true, noDock: true,
  });

  win = nextWin;
  winReady = false;

  nextWin.on("ready", () => {
    if (win !== nextWin) return;
    winReady = true;
    nextWin.send(`window.island.setMode(${JSON.stringify(currentMode)})`);
    nextWin.send(`window.island.setPromptHover(${currentPromptHover ? "true" : "false"})`);
    if (currentScale) nextWin.send(`window.island.setScale(${JSON.stringify(currentScale)})`);
    for (const [id, row] of rowState) {
      nextWin.send(`window.island.upsertRow(${JSON.stringify(id)},${JSON.stringify(row)})`);
    }
    for (const js of pending.splice(0)) nextWin.send(js);
  });

  nextWin.on("closed", () => {
    if (ignoredHostCloses.has(nextWin)) {
      ignoredHostCloses.delete(nextWin);
      return;
    }
    cleanup();
    process.exit(0);
  });
  nextWin.on("error", () => { /* keep running; the host may emit harmless errors */ });
}

function reloadIslandWindow() {
  if (cleaned) return;
  const oldWin = win;
  if (oldWin) ignoredHostCloses.add(oldWin);
  openIslandWindow();
  if (oldWin) { try { oldWin.close(); } catch {} }
}

openIslandWindow();

// Display hot-plug watcher --------------------------------------------------
// macOS may move a borderless statusBar-level window to a weird center-ish
// fallback position when an external monitor is attached/detached. The host
// window geometry is fixed at spawn, so keep the companion + sockets alive but
// recreate just the native host and replay the latest row state.
const DISPLAY_POLL_MS = 1500;
const DISPLAY_RELOAD_DEBOUNCE_MS = 700;
let displaySignature = getDisplaySignature();
let displayReloadTimer = null;
const displayPollTimer = setInterval(() => {
  const next = getDisplaySignature();
  if (!next || next === displaySignature) return;
  displaySignature = next;
  if (displayReloadTimer) clearTimeout(displayReloadTimer);
  displayReloadTimer = setTimeout(() => {
    displayReloadTimer = null;
    displaySignature = getDisplaySignature();
    reloadIslandWindow();
  }, DISPLAY_RELOAD_DEBOUNCE_MS);
}, DISPLAY_POLL_MS);

// ---- Socket server --------------------------------------------------------
// Unix sockets leave a file on disk that must be cleaned up before
// re-listening. Named pipes (Windows) are kernel objects — no cleanup
// needed, and unlinkSync would throw on a pipe path anyway.
if (process.platform !== "win32" && existsSync(SOCK)) {
  try { unlinkSync(SOCK); } catch {}
}

const clients = new Set();
// Per-socket id tracker — every distinct `id` we've ever seen on this
// socket. On disconnect we issue `removeRow` for ALL of them, not just
// the last one. Fixes the "Single socket carries multiple session IDs"
// limitation documented in the pre-0.2.1 AGENT.md §14.
const socketIds = new WeakMap();
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
  socketIds.set(sock, new Set());
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

  const rl = createInterface({ input: sock, crlfDelay: Infinity });

  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    // Track every distinct id seen on this socket for cleanup on close.
    if (typeof msg.id === "string" && msg.id) {
      socketIds.get(sock)?.add(msg.id);
    }

    // ── Explicit dispatch — no default-upsert ─────────────────────────────
    // Pre-0.2.1 companions treated anything with an id as an upsert. That
    // turned protocol-mismatched messages (e.g. a new client sending
    // `type:"scale"` to an old companion) into empty ghost rows. We now
    // dispatch by exact type and silently ignore anything we don't know.

    if (msg.type === "hello") {
      // Version handshake — client uses this to detect a version mismatch
      // and trigger a self-respawn. We just reply with our own version;
      // the client decides whether to respawn us.
      try {
        sock.write(JSON.stringify({
          type: "hello-ack",
          version: COMPANION_VERSION,
        }) + "\n");
      } catch {}
      return;
    }

    if (msg.type === "update") {
      // Require a valid status — empty / unknown statuses are dropped at
      // the boundary so malformed clients can't create ghost rows.
      if (!msg.id || !VALID_STATUS.has(msg.status)) return;
      // Image previews are no longer supported. Drop legacy base64 payloads
      // from older clients instead of forwarding them to the WebView.
      delete msg.promptImages;
      delete msg.promptImageCount;
      const merged = Object.assign({}, rowState.get(msg.id) || {}, msg);
      rowState.set(msg.id, merged);
      send(`window.island.upsertRow(${JSON.stringify(msg.id)},${JSON.stringify(msg)})`);
      return;
    }

    if (msg.type === "remove") {
      if (!msg.id) return;
      rowState.delete(msg.id);
      send(`window.island.removeRow(${JSON.stringify(msg.id)})`);
      return;
    }

    if (msg.type === "mode" && (msg.mode === "normal" || msg.mode === "notch")) {
      currentMode = msg.mode;
      send(`window.island.setMode(${JSON.stringify(msg.mode)})`);
      return;
    }

    if (msg.type === "scale" && typeof msg.scale === "string") {
      // WebView clamps unknown scales to medium — we don't need to validate
      // here, just forward. This keeps the companion agnostic to the preset
      // list so new sizes can land in index.ts + island.html.mjs without a
      // companion change.
      currentScale = msg.scale;
      send(`window.island.setScale(${JSON.stringify(msg.scale)})`);
      return;
    }

    if (msg.type === "prompt-hover" && typeof msg.enabled === "boolean") {
      // Live toggle: prompt text stays hidden in the compact row; this only
      // controls whether hover expands the row to reveal it.
      currentPromptHover = msg.enabled;
      send(`window.island.setPromptHover(${msg.enabled ? "true" : "false"})`);
      return;
    }

    if (msg.type === "respawn") {
      // Graceful shutdown so the client's next ensureConnection() spawns
      // a fresh companion that re-reads the pref file (new screen / notch)
      // or runs the newly-installed code (auto-heal after `npm update`).
      cleanup();
      process.exit(0);
      return;
    }

    // Unknown type — ignore. No row created.
  });

  sock.on("close", () => {
    clients.delete(sock);
    const ids = socketIds.get(sock);
    if (ids) {
      for (const id of ids) {
        rowState.delete(id);
        send(`window.island.removeRow(${JSON.stringify(id)})`);
      }
      socketIds.delete(sock);
    }
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
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { clearInterval(displayPollTimer); } catch {}
  if (displayReloadTimer) { try { clearTimeout(displayReloadTimer); } catch {} displayReloadTimer = null; }
  try { server.close(); } catch {}
  if (process.platform !== "win32") { try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {} }
  try { win?.close(); } catch {}
}
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT",  () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
