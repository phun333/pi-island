#!/usr/bin/env node
// Visual demo that exercises the multi-session stack WITHOUT running pi.
// Spawns the companion, then plays back a script with two simulated pi
// sessions so you can see rows appear, update, and stack vertically.
//
//   node pi-extension/demo.mjs                       # stack demo (default)
//   node pi-extension/demo.mjs single                # single-row walkthrough
//   node pi-extension/demo.mjs overlap               # long project name + long prompt
//   node pi-extension/demo.mjs long                  # 1000s elapsed, ticks forever (Ctrl+C to quit)
//   node pi-extension/demo.mjs sizes                 # one row per preset stacked (xlarge→small)
//   node pi-extension/demo.mjs single large          # scale preset (small|medium|large)
//   node pi-extension/demo.mjs stack small
//   node pi-extension/demo.mjs overlap large
//   node pi-extension/demo.mjs long large            # also works for long

import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCK } from "./socket-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(HERE, "companion.mjs");
const MODE  = process.argv[2] || "stack";
const SCALE = process.argv[3] || null; // optional: "small" | "medium" | "large"

// ---- Ensure companion is running and get a connected socket ---------------
function tryConnect() {
  return new Promise((resolve) => {
    const s = connect(SOCK);
    s.once("connect", () => resolve(s));
    s.once("error",   () => resolve(null));
  });
}

async function getClient() {
  if (existsSync(SOCK)) {
    const s = await tryConnect();
    if (s) return s;
  }
  const child = spawn(process.execPath, [COMPANION], {
    detached: true, stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const s = await tryConnect();
    if (s) return s;
  }
  throw new Error("companion didn't come up");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendMsg = (s, obj) => s.write(JSON.stringify(obj) + "\n");

// Play back a timeline for one simulated session.
// We only include fields that the step actually defines so the companion's
// merge preserves earlier values (the user's prompt in particular).
async function playSession(sock, id, project, timeline) {
  const startedAt = Date.now();
  for (const step of timeline) {
    await sleep(step.delay);
    const msg = {
      id, type: "update",
      project,
      status: step.status,
      startedAt,
      frozenElapsed: step.freeze ? (Date.now() - startedAt) : null,
    };
    if (step.prompt != null) msg.prompt = step.prompt;
    if (step.detail != null) msg.detail = step.detail;
    if (step.ctx    != null) msg.ctxPct = step.ctx;
    sendMsg(sock, msg);
  }
}

// ---- Demo scripts ---------------------------------------------------------
const SCRIPT_A = [
  { delay:    0, status: "thinking",  prompt: "fix the auth bug in login.ts", ctx: 12 },
  { delay: 2000, status: "reading",   detail: "login.ts", ctx: 14 },
  { delay: 1500, status: "editing",   detail: "login.ts", ctx: 19 },
  { delay: 2500, status: "running",   detail: "npm",      ctx: 22 },
  { delay: 2000, status: "done",      prompt: "fix the auth bug in login.ts", ctx: 24, freeze: true },
];

const SCRIPT_B = [
  { delay:    0, status: "thinking",  prompt: "refactor payments module", ctx: 34 },
  { delay: 1800, status: "searching", detail: "TODO", ctx: 36 },
  { delay: 2200, status: "reading",   detail: "payments.ts", ctx: 41 },
  { delay: 1800, status: "editing",   detail: "payments.ts", ctx: 48 },
  { delay: 2000, status: "error",     detail: "edit" },
  { delay: 1500, status: "thinking",  prompt: "refactor payments module", ctx: 55 },
  { delay: 2000, status: "done",      prompt: "refactor payments module", ctx: 62, freeze: true },
];

const SCRIPT_C = [
  { delay:    0, status: "thinking",  prompt: "add dark mode toggle", ctx: 8  },
  { delay: 2500, status: "reading",   detail: "theme.tsx", ctx: 11 },
  { delay: 1500, status: "writing",   detail: "dark-mode.css", ctx: 18 },
  { delay: 2000, status: "running",   detail: "npm", ctx: 24 },
  { delay: 2500, status: "done",      prompt: "add dark mode toggle", ctx: 27, freeze: true },
];

const SCRIPT_SINGLE = [
  { delay:    0, status: "thinking",  prompt: "fix the auth bug in login.ts", ctx: 12 },
  { delay: 2500, status: "reading",   detail: "extensions.md", ctx: 14 },
  { delay: 1800, status: "editing",   detail: "index.ts", ctx: 34 },
  { delay: 1800, status: "running",   detail: "npm test", ctx: 52 },
  { delay: 1800, status: "searching", detail: "TODO", ctx: 62 },
  { delay: 1500, status: "error",     detail: "bash" },
  { delay: 1500, status: "thinking",  prompt: "fix the auth bug in login.ts", ctx: 78 },
  { delay: 2500, status: "done",      prompt: "fix the auth bug in login.ts", ctx: 88, freeze: true },
];

// Regression demo for the project-name/prompt overlap (GitHub issue #4).
// Long project basename on the left + long prompt in the middle exercises
// both the TS source-side truncation and the CSS ellipsis safety net.
const SCRIPT_OVERLAP = [
  { delay:    0, status: "thinking",  prompt: "this is a deliberately long prompt to stress the middle slot", ctx: 5 },
  { delay: 2000, status: "editing",   detail: "index.ts", ctx: 12 },
  { delay: 2000, status: "running",   detail: "npm",      ctx: 18 },
  { delay: 2500, status: "done",      prompt: "this is a deliberately long prompt to stress the middle slot", ctx: 20, freeze: true },
];

// ---- Main -----------------------------------------------------------------
const sock = await getClient();

// Apply size preset up-front if requested. Unknown values fall back to
// medium on the WebView side, so typos don't break the demo.
if (SCALE) {
  sendMsg(sock, { id: "sess-demo", type: "scale", scale: SCALE });
  await sleep(50);
}

if (MODE === "sizes") {
  // Showcase demo: one row per size preset, stacked largest-on-top. Each
  // row gets its own `rowScale` so CSS --scale is set inline on that row
  // specifically (the island.html renderer applies it). Great for a
  // promo video — Ctrl+C to exit.
  const scales = ["xlarge", "large", "medium", "small"];
  const now = Date.now();
  for (let i = 0; i < scales.length; i++) {
    const s = scales[i];
    sendMsg(sock, {
      id: `sess-${s}`,
      type: "update",
      project: "pi-island",
      status: "thinking",
      prompt: `size: ${s}`,
      startedAt: now - (i + 1) * 1000 * 3,
      ctxPct: 20 + i * 15,
      rowScale: s,
    });
    await sleep(600); // stagger enter animations so rows fade in one by one
  }
  console.log("\n4 sizes stacked (xlarge → small). Ctrl+C to exit.\n");
  process.on("SIGINT", () => {
    for (const s of scales) sendMsg(sock, { id: `sess-${s}`, type: "remove" });
    setTimeout(() => { sock.end(); process.exit(0); }, 300);
  });
  await new Promise(() => {});
} else if (MODE === "long") {
  // Long-running task demo. Sends one upsert with startedAt set 1000s in
  // the past so the elapsed readout starts at 16m 40s and keeps climbing
  // live (the WebView's 250ms ticker does the ongoing increments). The
  // client keeps the socket open forever — Ctrl+C to exit. While the
  // socket is alive the companion never idle-exits, so this is the
  // right mode for "leave the island up and stare at it".
  const id = "sess-long";
  const startedAt = Date.now() - 1000 * 1000;
  sendMsg(sock, {
    id, type: "update",
    project: "pi-island",
    status: "thinking",
    prompt: "long running task",
    startedAt,
    ctxPct: 42,
  });
  console.log("\nisland is pinned — elapsed shows 16m 40s and climbs. Ctrl+C to quit.\n");
  // Clean up on SIGINT so the companion idle-exits promptly.
  process.on("SIGINT", () => {
    sendMsg(sock, { id, type: "remove" });
    setTimeout(() => { sock.end(); process.exit(0); }, 200);
  });
  // Block forever.
  await new Promise(() => {});
} else if (MODE === "single") {
  await playSession(sock, "sess-single", "pi-test", SCRIPT_SINGLE);
  await sleep(3000);
  sendMsg(sock, { id: "sess-single", type: "remove" });
} else if (MODE === "overlap") {
  // Long basename the extension would have (pre-truncation) next to a
  // long prompt. The extension truncates to 20 chars; here we send raw
  // so we can see what CSS does on its own too.
  await playSession(
    sock,
    "sess-overlap",
    "pi-pi-pi-pi-pi-pi-pi-pi-pi-pi-pi-pi-pi",
    SCRIPT_OVERLAP,
  );
  await sleep(3000);
  sendMsg(sock, { id: "sess-overlap", type: "remove" });
} else {
  // Three concurrent sessions, staggered so you can watch them stack.
  const a = playSession(sock, "sess-a", "pi-auth",      SCRIPT_A);
  await sleep(1200);
  const b = playSession(sock, "sess-b", "pi-payments",  SCRIPT_B);
  await sleep(1400);
  const c = playSession(sock, "sess-c", "pi-dashboard", SCRIPT_C);
  await Promise.all([a, b, c]);
  await sleep(3000);
  sendMsg(sock, { id: "sess-a", type: "remove" });
  await sleep(700);
  sendMsg(sock, { id: "sess-b", type: "remove" });
  await sleep(700);
  sendMsg(sock, { id: "sess-c", type: "remove" });
}

await sleep(1200);
sock.end();
