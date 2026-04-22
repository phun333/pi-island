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
import { DynamicBorder, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@mariozechner/pi-tui";
import { connect, type Socket } from "node:net";
import { spawn, execSync } from "node:child_process";
import { basename, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { SOCK } from "./socket-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(HERE, "companion.mjs");
const SESSION_ID = randomUUID().slice(0, 8);

// ── Persistent user preference ─────────────────────────────────────────────
// Every user-visible setting that survives restarts lives in ~/.pi/pi-island.json.
// Fields are all optional in the on-disk file — missing ones fall back to
// sensible defaults so old installs keep working on upgrade.
//
//   {
//     "enabled":   true,            // visibility toggle
//     "scale":     "medium",        // size preset
//     "screen":    "primary",       // which display
//     "notchMode": "auto"           // notch-wrap policy
//   }
//
// The companion reads the same file at spawn time for settings it owns
// (screen + notch). Settings that change live (size, visibility) are
// delivered over the socket as well.
const PREF_DIR  = join(homedir(), ".pi");
const PREF_FILE = join(PREF_DIR, "pi-island.json");

// Scale presets — mirrors SCALES in island.html.mjs. Adding a preset
// requires updates in BOTH files (the list here drives the settings
// menu / validation; the map over there drives the actual CSS scale).
const SCALES = ["small", "medium", "large", "xlarge"] as const;
type Scale = typeof SCALES[number];
const DEFAULT_SCALE: Scale = "medium";

// Screen preference:
//   "primary" → NSScreen.screens[0] (menu-bar screen, AGENT.md §6.1 original)
//   "active"  → screen under the mouse cursor at companion spawn (PR #3)
//   "2"..."N" → specific monitor by index (1 == primary, so the menu hides it)
type ScreenPref = string;
const DEFAULT_SCREEN: ScreenPref = "primary";

// Notch wrap policy:
//   "auto"   → companion auto-detects via safeAreaInsets (default, pre-0.2 behaviour)
//   "normal" → force disable (useful if auto-detection misfires)
//   "notch"  → force enable (replaces the removed /island2 command)
const NOTCH_MODES = ["auto", "normal", "notch"] as const;
type NotchMode = typeof NOTCH_MODES[number];
const DEFAULT_NOTCH: NotchMode = "auto";

type Preference = {
  enabled:   boolean;
  scale:     Scale;
  screen:    ScreenPref;
  notchMode: NotchMode;
};

function isScale(v: unknown): v is Scale {
  return typeof v === "string" && (SCALES as readonly string[]).includes(v);
}
function isNotchMode(v: unknown): v is NotchMode {
  return typeof v === "string" && (NOTCH_MODES as readonly string[]).includes(v);
}
// "primary" | "active" | "1" | "2" | ... — numeric must be a clean integer ≥ 1.
function isScreen(v: unknown): v is ScreenPref {
  if (typeof v !== "string") return false;
  if (v === "primary" || v === "active") return true;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && String(n) === v;
}

function readPreference(): Preference {
  const fallback: Preference = {
    enabled:   true,
    scale:     DEFAULT_SCALE,
    screen:    DEFAULT_SCREEN,
    notchMode: DEFAULT_NOTCH,
  };
  try {
    if (!existsSync(PREF_FILE)) return fallback;
    const data = JSON.parse(readFileSync(PREF_FILE, "utf8"));
    return {
      enabled:   data?.enabled   !== false,
      scale:     isScale(data?.scale)          ? data.scale     : DEFAULT_SCALE,
      screen:    isScreen(data?.screen)        ? data.screen    : DEFAULT_SCREEN,
      notchMode: isNotchMode(data?.notchMode)  ? data.notchMode : DEFAULT_NOTCH,
    };
  } catch {
    return fallback;
  }
}

function writePreference(p: Preference): void {
  try {
    if (!existsSync(PREF_DIR)) mkdirSync(PREF_DIR, { recursive: true });
    writeFileSync(PREF_FILE, JSON.stringify(p, null, 2) + "\n");
  } catch { /* best-effort — don't crash the session over a cache file */ }
}

// Query macOS for the number of attached displays. Used to build the
// Screen dropdown in the settings menu; capped at something sane so a
// weird system with 20 fake displays doesn't produce a 20-entry menu.
function getScreenCount(): number {
  try {
    const out = execSync(
      `osascript -l JavaScript -e "ObjC.import('AppKit'); $.NSScreen.screens.js.length"`,
      { encoding: "utf8", timeout: 1500 },
    ).trim();
    const n = parseInt(out, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, 9);
  } catch { return 1; }
}

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

// Project names come from `basename(process.cwd())` — usually short
// (`pi-island`, `my-app`) but occasionally pathological. Clamp at the
// source so the socket never ships 200-char strings; CSS adds a second
// ellipsis safety net in case this ever regresses.
function truncateProject(s: string, max = 20): string {
  const clean = String(s || "");
  if (!clean) return "";
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

// ── extension entry ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin") return; // mac-only by design

  // ── Client state ─────────────────────────────────────────────────────────
  let sock: Socket | null = null;
  let connecting = false;
  const pref = readPreference();
  let shownForSession    = pref.enabled;
  let currentScale:     Scale      = pref.scale;
  let currentScreen:    ScreenPref = pref.screen;
  let currentNotchMode: NotchMode  = pref.notchMode;
  let hideTimer: NodeJS.Timeout | null = null;

  const project = truncateProject(basename(process.cwd()));
  let lastCtx: any = null;
  let activeToolCount = 0;
  let inAgent = false;
  let currentPrompt = "";
  let startedAt: number | null = null;
  let frozenElapsed: number | null = null;

  function persistPref() {
    writePreference({
      enabled:   shownForSession,
      scale:     currentScale,
      screen:    currentScreen,
      notchMode: currentNotchMode,
    });
  }

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

  // Tell the companion the client's current visual scale. Pushed on every
  // fresh connect so a freshly-spawned companion (medium by default) picks
  // up the user's pref without waiting for an explicit size change.
  function syncScale() {
    writeMessage({ id: SESSION_ID, type: "scale", scale: currentScale });
  }

  async function ensureConnection(): Promise<boolean> {
    if (sock && !sock.destroyed) return true;
    if (connecting) return false;
    connecting = true;
    try {
      // Try connecting to an existing companion first.
      if (existsSync(SOCK) && await connectToCompanion()) { syncScale(); return true; }

      // Otherwise spawn the companion and poll until the socket is up.
      if (!existsSync(COMPANION)) return false;
      const child = spawn(process.execPath, [COMPANION], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await connectToCompanion()) { syncScale(); return true; }
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

  // Ask the companion to evict EVERY row from the webview. Used by
  // /island reset to clear phantom rows left behind when other pi
  // sessions died without sending their own `remove` (SIGKILL'd
  // terminal, OS reboot, lost socket, …). The current session's row
  // is re-upserted immediately after so the user's own capsule doesn't
  // flicker away.
  async function sendClear() {
    if (!sock) { if (!(await ensureConnection())) return; }
    writeMessage({ id: SESSION_ID, type: "clear" });
  }

  // Ask the companion to cleanly exit so the client's next event respawns
  // it with fresh pref values. Used for settings that need a new NSWindow
  // (screen position, notch mode) — NSWindow geometry is fixed after spawn.
  async function respawnCompanion() {
    if (sock && !sock.destroyed) {
      writeMessage({ id: SESSION_ID, type: "respawn" });
      try { sock.end(); } catch {}
      sock = null;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (shownForSession) await ensureConnection();
  }

  // ── Setting actions (shared between /island subcommands and the menu) ────
  async function doEnable(ctx: any) {
    shownForSession = true;
    persistPref();
    await ensureConnection();
    ctx.ui.notify("Island enabled", "info");
  }

  async function doDisable(ctx: any) {
    shownForSession = false;
    persistPref();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    await sendRemove();
    ctx.ui.notify("Island disabled", "info");
  }

  async function doSetScale(next: Scale, ctx: any) {
    currentScale = next;
    persistPref();
    // Scale is live — no companion respawn needed. CSS var flips instantly.
    if (sock && !sock.destroyed) {
      syncScale();
    } else if (shownForSession) {
      if (await ensureConnection()) syncScale();
    }
    ctx.ui.notify(`Island size → ${next}`, "info");
  }

  async function doSetScreen(next: ScreenPref, ctx: any) {
    currentScreen = next;
    persistPref();
    await respawnCompanion();
    ctx.ui.notify(`Island screen → ${next}`, "info");
  }

  async function doSetNotchMode(next: NotchMode, ctx: any) {
    currentNotchMode = next;
    persistPref();
    await respawnCompanion();
    ctx.ui.notify(`Island notch wrap → ${next}`, "info");
  }

  // `/island reset` — lightweight phantom sweep.
  //
  // Sends a single `clear` message so the companion calls
  // `window.island.removeAllRows()`. Any still-alive pi session will
  // re-upsert its own row on the next tool / message event, so only the
  // orphaned rows (SIGKILL'd terminals etc.) stay gone. We also re-send
  // the current session's state right away so the user who typed the
  // command sees their own row reappear immediately instead of waiting
  // for the next agent tick.
  async function doReset(ctx: any) {
    if (!shownForSession) {
      ctx.ui.notify("Island is disabled — nothing to reset", "info");
      return;
    }
    if (!(await ensureConnection())) {
      ctx.ui.notify("Couldn't reach the island companion", "error");
      return;
    }
    await sendClear();
    // Re-show our own row so the reset feels instant for the active session.
    if (inAgent) {
      await sendUpdate("thinking", "");
    } else if (startedAt != null) {
      // Between agent runs: replay the last "done" so the user sees their
      // capsule briefly and the 5s retract timer (if any) was already set.
      await sendUpdate("done", "");
    }
    ctx.ui.notify("Island reset — phantom rows cleared", "info");
  }

  // `/island reload` — full daemon restart.
  //
  // Same hammer as respawnCompanion() but user-initiated. Closes the
  // NSWindow, drops the socket, spawns a fresh companion which re-reads
  // `~/.pi/pi-island.json` and gets a clean slate of rows. Heavier than
  // /island reset but also recovers from window-level weirdness (wrong
  // screen, stuck notch mode, stale CSS, …). Other live pi sessions
  // will reconnect on their next event.
  async function doReload(ctx: any) {
    await respawnCompanion();
    // Re-upsert our row against the fresh companion so the user sees
    // something right away. If !inAgent we skip — the next event will
    // bring us back, same as a cold start.
    if (shownForSession && inAgent) {
      await sendUpdate("thinking", "");
    }
    ctx.ui.notify("Island reloaded — companion respawned", "info");
  }

  // ── Settings menu — same UX as pi's /settings ────────────────────────────
  // Uses pi-tui's SettingsList component via ctx.ui.custom(). Each row
  // shows a label + current value; Enter/Space cycles through `values`.
  // The action callbacks are the same helpers the /island subcommands use,
  // so menu and CLI stay perfectly in sync.
  //
  // IMPORTANT pattern notes (learned the hard way):
  //   - Do NOT pass { overlay: true }. It puts us in a narrow floating box
  //     that bleeds terminal scrollback through the transparent areas
  //     (rendering garbage). Full-width in-flow render — same layout as
  //     pi's own /settings — needs no options at all.
  //   - The factory MUST return an object with explicit render/invalidate/
  //     handleInput — NOT the Container directly. Container doesn't route
  //     keystrokes to its active focusable child, so the list would never
  //     see Enter/Space/arrows and the terminal looks frozen.
  //   - handleInput must call tui.requestRender() after each keystroke or
  //     the cycled value doesn't repaint until the next unrelated event.
  async function openSettingsMenu(ctx: any) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Settings menu needs an interactive UI. Try /island size|screen|notch <value>",
        "info",
      );
      return;
    }

    const screenCount = getScreenCount();
    const screenValues: string[] = ["primary", "active"];
    for (let i = 2; i <= screenCount; i++) screenValues.push(String(i));

    await ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: (r?: void) => void) => {
      const items: SettingItem[] = [
          {
            id: "visibility",
            label: "Visibility",
            description: "Show or hide the Dynamic Island capsule at the top of the screen",
            currentValue: shownForSession ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "size",
            label: "Size",
            description: "Font size / row height preset (live — no restart needed)",
            currentValue: currentScale,
            values: [...SCALES],
          },
          {
            id: "screen",
            label: "Screen",
            description: "Display to host the capsule (primary = menu-bar screen; active = follow mouse; 2/3/… = monitor index)",
            currentValue: currentScreen,
            values: screenValues,
          },
          {
            id: "notch",
            label: "Notch wrap",
            description: "Wrap the MacBook notch (auto = detect; normal = force off; notch = force on)",
            currentValue: currentNotchMode,
            values: [...NOTCH_MODES],
          },
        ];

      const container = new Container();
      const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
      container.addChild(border());

      const list = new SettingsList(
        items,
        10,
        getSettingsListTheme(),
        (id: string, newValue: string) => {
          // Fire-and-forget — SettingsList doesn't await us. Any failure
          // just leaves the displayed value updated but the real setting
          // unchanged. In practice all our do*() helpers are robust.
          (async () => {
            if (id === "visibility") {
              if (newValue === "enabled") await doEnable(ctx);
              else await doDisable(ctx);
            } else if (id === "size" && isScale(newValue)) {
              await doSetScale(newValue, ctx);
            } else if (id === "screen" && isScreen(newValue)) {
              await doSetScreen(newValue, ctx);
            } else if (id === "notch" && isNotchMode(newValue)) {
              await doSetNotchMode(newValue, ctx);
            }
          })();
          list.updateValue(id, newValue);
        },
        () => done(undefined),
        { enableSearch: false },
      );
      container.addChild(list);
      container.addChild(border());

      // Explicit Component-shaped return so keystrokes actually reach the
      // SettingsList (Container alone swallows them). See header comment.
      return {
        render(width: number) { return container.render(width); },
        invalidate()            { container.invalidate(); },
        handleInput(data: string) {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  // ── Event handlers ───────────────────────────────────────────────────────
  pi.on("session_start", async (_evt, ctx) => {
    lastCtx = ctx;
    // Don't auto-show on session start — the island appears on the first
    // agent_start event (when there's actually something to show).
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

  // ── /island command ──────────────────────────────────────────────────────
  //
  //   /island                   → open settings menu (canonical)
  //   /island on | enable       → show + persist
  //   /island off | disable     → hide + persist
  //   /island toggle            → flip current visibility
  //   /island size <preset>     → set scale (small | medium | large)
  //   /island screen <value>    → set screen (primary | active | 2 | 3 ...)
  //   /island notch <mode>      → set notch wrap (auto | normal | notch)
  //   /island reset             → clear phantom rows (keeps companion alive)
  //   /island reload            → respawn companion (heavier reset)
  //
  // Subcommands let power users / scripts skip the menu. With no args the
  // menu is the friendlier path — same UX as pi's own /settings.
  pi.registerCommand("island", {
    description: "Open pi-island settings (or /island size|screen|notch <value> | reset | reload)",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        await openSettingsMenu(ctx);
        return;
      }
      const sub = parts[0]?.toLowerCase();

      if (sub === "on" || sub === "enable") { await doEnable(ctx);  return; }
      if (sub === "off" || sub === "disable") { await doDisable(ctx); return; }
      if (sub === "toggle") {
        if (shownForSession) await doDisable(ctx); else await doEnable(ctx);
        return;
      }

      // Phantom-row sweep: webview-only, keeps companion alive.
      if (sub === "reset" || sub === "clear") { await doReset(ctx);  return; }
      // Full companion respawn: heavier, also recovers NSWindow-level issues.
      if (sub === "reload" || sub === "restart") { await doReload(ctx); return; }

      if (sub === "size") {
        const next = parts[1]?.toLowerCase();
        if (!next) {
          ctx.ui.notify(`Size: ${currentScale} — try /island size <${SCALES.join("|")}>`, "info");
          return;
        }
        if (!isScale(next)) {
          ctx.ui.notify(`Unknown size "${next}". Use one of: ${SCALES.join(", ")}`, "error");
          return;
        }
        await doSetScale(next, ctx);
        return;
      }

      if (sub === "screen") {
        const next = parts[1]?.toLowerCase();
        if (!next) {
          ctx.ui.notify(
            `Screen: ${currentScreen} — try /island screen <primary|active|2|3|...>`,
            "info",
          );
          return;
        }
        if (!isScreen(next)) {
          ctx.ui.notify(
            `Unknown screen "${next}". Use: primary, active, or a monitor index (1..N)`,
            "error",
          );
          return;
        }
        await doSetScreen(next, ctx);
        return;
      }

      if (sub === "notch") {
        const next = parts[1]?.toLowerCase();
        if (!next) {
          ctx.ui.notify(
            `Notch wrap: ${currentNotchMode} — try /island notch <${NOTCH_MODES.join("|")}>`,
            "info",
          );
          return;
        }
        if (!isNotchMode(next)) {
          ctx.ui.notify(
            `Unknown notch mode "${next}". Use one of: ${NOTCH_MODES.join(", ")}`,
            "error",
          );
          return;
        }
        await doSetNotchMode(next, ctx);
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand "${sub}". Try: /island (menu)  or  /island size|screen|notch <value>  or  /island reset|reload`,
        "error",
      );
    },
  });
}
