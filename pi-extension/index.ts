/**
 * pi-island — pi extension (socket client).
 *
 * Each pi instance running this extension connects to a shared companion
 * daemon over a Unix socket and streams its session's status updates.
 * The companion owns the single Dynamic-Island WebView window and stacks
 * all active sessions as rows — so running `pi` in two terminals at the
 * same time shows TWO rows, etc.
 *
 * If the companion isn't running, we spawn it (detached) and retry the
 * connection. The companion shuts itself down 6s after the last client
 * disconnects.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { basename, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { SOCK } from "./socket-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(HERE, "companion.mjs");
const SESSION_ID = randomUUID().slice(0, 8);

// ── tool name → island state (matches pi's built-in tool set) ──────────────
interface IslandUpdate {
  status: string;
  detail?: string;
}
function toolToIsland(toolName: string, args: any): IslandUpdate {
  const a = args ?? {};
  switch (toolName) {
    case "read":  return { status: "reading", detail: basename(a.path ?? "") };
    case "edit":  return { status: "editing", detail: basename(a.path ?? "") };
    case "write": return { status: "writing", detail: basename(a.path ?? "") };
    case "bash": {
      const cmd = String(a.command ?? "");
      const first = cmd.split(/\s+/)[0] || "bash";
      return { status: "running", detail: first };
    }
    case "ls":    return { status: "searching", detail: basename(a.path ?? "") || "." };
    case "grep":  return { status: "searching", detail: String(a.pattern ?? "") };
    case "find":  return { status: "searching", detail: String(a.pattern ?? a.path ?? "") };
    default:      return { status: "running",   detail: toolName };
  }
}

function truncatePrompt(s: string, max = 48): string {
  const clean = String(s || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

// ── extension entry ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin") return; // mac-only by design

  // ── Client state ─────────────────────────────────────────────────────────
  let sock: Socket | null = null;
  let connecting = false;
  let shownForSession = false;        // /island → on, /island (again) → off
  let hideTimer: NodeJS.Timeout | null = null;

  const project = basename(process.cwd());
  let lastCtx: any = null;
  let activeToolCount = 0;
  let inAgent = false;
  let currentPrompt = "";
  let startedAt: number | null = null;
  let frozenElapsed: number | null = null;

  // ── Socket connection ────────────────────────────────────────────────────
  function connectToCompanion(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = connect(SOCK);
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (ok) { sock = s; sock.on("close", () => { sock = null; }); sock.on("error", () => {}); }
        resolve(ok);
      };
      s.once("connect", () => done(true));
      s.once("error",   () => done(false));
    });
  }

  async function ensureConnection(): Promise<boolean> {
    if (sock && !sock.destroyed) return true;
    if (connecting) return false;
    connecting = true;
    try {
      // Try connecting to an existing companion first.
      if (existsSync(SOCK) && await connectToCompanion()) return true;

      // Otherwise spawn the companion and poll until the socket is up.
      if (!existsSync(COMPANION)) return false;
      const child = spawn(process.execPath, [COMPANION], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await connectToCompanion()) return true;
      }
      return false;
    } finally {
      connecting = false;
    }
  }

  function writeMessage(msg: any) {
    if (!sock || sock.destroyed) return;
    try { sock.write(JSON.stringify(msg) + "\n"); } catch { /* pipe might be closed */ }
  }

  async function sendUpdate(status: string, detail = "", opts: { resetTimer?: boolean } = {}) {
    if (!shownForSession) return;
    if (!sock) { if (!(await ensureConnection())) return; }
    if (opts.resetTimer || startedAt == null) {
      startedAt = Date.now();
      frozenElapsed = null;
    }
    let ctxPct: number | null = null;
    try {
      const usage = lastCtx?.getContextUsage?.();
      if (usage && usage.percent != null) ctxPct = Math.round(usage.percent);
    } catch {}
    writeMessage({
      id: SESSION_ID,
      type: "update",
      project,
      status,
      detail,
      prompt: currentPrompt,
      startedAt,
      frozenElapsed,
      ctxPct,
    });
  }

  async function sendRemove() {
    if (!sock) return;
    writeMessage({ id: SESSION_ID, type: "remove" });
  }

  // ── Event handlers ───────────────────────────────────────────────────────
  pi.on("session_start", async (_evt, ctx) => {
    lastCtx = ctx;
    // Don't auto-show on session start — user opts in via /island. This
    // mirrors the existing single-mode behaviour.
  });

  pi.on("session_shutdown", async () => {
    if (hideTimer) clearTimeout(hideTimer);
    await sendRemove();
    try { sock?.end(); } catch {}
    sock = null;
  });

  pi.on("before_agent_start", async (evt: any, ctx) => {
    lastCtx = ctx;
    currentPrompt = truncatePrompt(evt?.prompt ?? "", 48);
  });

  pi.on("agent_start", async (_evt, ctx) => {
    lastCtx = ctx;
    inAgent = true;
    activeToolCount = 0;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    await sendUpdate("thinking", "", { resetTimer: true });
  });

  pi.on("message_update", async (_evt, ctx) => {
    lastCtx = ctx;
    if (activeToolCount === 0 && inAgent) {
      await sendUpdate("thinking", "");
    }
  });

  pi.on("tool_execution_start", async (evt, ctx) => {
    lastCtx = ctx;
    activeToolCount++;
    const upd = toolToIsland(evt.toolName, (evt as any).args);
    await sendUpdate(upd.status, upd.detail ?? "");
  });

  pi.on("tool_execution_end", async (evt, ctx) => {
    lastCtx = ctx;
    activeToolCount = Math.max(0, activeToolCount - 1);
    if ((evt as any).isError) {
      await sendUpdate("error", (evt as any).toolName);
      setTimeout(async () => {
        if (inAgent && activeToolCount === 0) await sendUpdate("thinking", "");
      }, 1500);
      return;
    }
    if (activeToolCount === 0 && inAgent) {
      await sendUpdate("thinking", "");
    }
  });

  pi.on("agent_end", async (_evt, ctx) => {
    lastCtx = ctx;
    inAgent = false;
    if (startedAt != null) frozenElapsed = Date.now() - startedAt;
    await sendUpdate("done", "");
    // Retract the row 5s after done so the user can read the summary.
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(async () => { await sendRemove(); }, 5000);
  });

  // ── /island command — toggle visibility for this pi session ──────────────
  pi.registerCommand("island", {
    description: "Toggle the pi Dynamic Island for this session",
    handler: async (_args, ctx) => {
      if (shownForSession) {
        shownForSession = false;
        if (hideTimer) clearTimeout(hideTimer);
        await sendRemove();
        ctx.ui.notify("Island hidden for this session", "info");
      } else {
        shownForSession = true;
        await ensureConnection();
        ctx.ui.notify("Island shown for this session", "info");
      }
    },
  });

  // ── /island2 command — force notch-mode layout on the companion ──────────
  pi.registerCommand("island2", {
    description: "Force the companion into notch-wrap layout",
    handler: async (_args, ctx) => {
      shownForSession = true;
      if (!(await ensureConnection())) {
        ctx.ui.notify("Couldn't reach the island companion", "error");
        return;
      }
      writeMessage({ id: SESSION_ID, type: "mode", mode: "notch" });
      ctx.ui.notify("Island switched to notch-wrap mode", "info");
    },
  });
}
