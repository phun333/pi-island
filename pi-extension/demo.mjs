#!/usr/bin/env node
// Visual demo that exercises the multi-session stack WITHOUT running pi.
// Spawns the companion, then plays back a script with two simulated pi
// sessions so you can see rows appear, update, and stack vertically.
//
//   node pi-extension/demo.mjs          # stack demo (default)
//   node pi-extension/demo.mjs single   # single-row walkthrough

import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCK } from "./socket-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(HERE, "companion.mjs");
const MODE = process.argv[2] || "stack";

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

// ---- Main -----------------------------------------------------------------
const sock = await getClient();

if (MODE === "single") {
  await playSession(sock, "sess-single", "pi-test", SCRIPT_SINGLE);
  await sleep(3000);
  sendMsg(sock, { id: "sess-single", type: "remove" });
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
