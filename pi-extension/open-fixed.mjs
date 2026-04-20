// Spawn wrapper for the native Swift host that renders the island.
//
// Two things this file takes care of:
//
//   1. Passes --x / --y as TWO separate argv entries, not --x=N
//      (the Swift host parses them as `--x N` and silently ignores
//      `--x=N`, which caused the window to land in screen-center instead
//      of where we asked).
//
//   2. Points at OUR host binary (island-host-bin next to this file),
//      which sets window.level = .statusBar (above the menu bar) and
//      overrides NSWindow.constrainFrameRect to a no-op, so the capsule
//      can actually sit at the top edge / notch area.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function resolveBinary() {
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "island-host-bin");
  if (existsSync(bin)) return bin;
  throw new Error(
    "pi-island: native host binary not found at " + bin + "\n" +
    "Run `npm run build` inside the pi-island directory (requires Xcode " +
    "Command Line Tools: `xcode-select --install`)."
  );
}

class FixedWindow extends EventEmitter {
  #proc;
  #closed = false;
  #pending = null;

  constructor(proc, html) {
    super();
    this.#proc = proc;
    this.#pending = html;

    proc.stdin.on("error", () => {});
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      switch (msg.type) {
        case "ready":
          if (this.#pending) {
            this.setHTML(this.#pending);
            this.#pending = null;
          } else {
            this.emit("ready", { screen: msg.screen, appearance: msg.appearance, cursor: msg.cursor });
          }
          break;
        case "message": this.emit("message", msg.data); break;
        case "click":   this.emit("click"); break;
        case "closed":
          if (!this.#closed) { this.#closed = true; this.emit("closed"); }
          break;
      }
    });
    proc.on("error", (e) => this.emit("error", e));
    proc.on("exit", () => {
      if (!this.#closed) { this.#closed = true; this.emit("closed"); }
    });
  }

  #write(obj) {
    if (this.#closed) return;
    try { this.#proc.stdin.write(JSON.stringify(obj) + "\n"); } catch {}
  }

  send(js)        { this.#write({ type: "eval", js }); }
  setHTML(html)   { this.#write({ type: "html", html: Buffer.from(html).toString("base64") }); }
  close()         { this.#write({ type: "close" }); }
}

export function openFixed(html, options = {}) {
  const bin = resolveBinary();
  const args = [];

  if (options.width  != null) args.push("--width",  String(options.width));
  if (options.height != null) args.push("--height", String(options.height));
  if (options.title  != null) args.push("--title",  options.title);

  if (options.frameless)    args.push("--frameless");
  if (options.floating)     args.push("--floating");
  if (options.transparent)  args.push("--transparent");
  if (options.clickThrough) args.push("--click-through");
  if (options.noDock)       args.push("--no-dock");
  if (options.hidden)       args.push("--hidden");

  // THE FIX: Swift parses --x / --y as TWO args, not --x=N.
  if (options.x != null) args.push("--x", String(options.x));
  if (options.y != null) args.push("--y", String(options.y));

  const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
  return new FixedWindow(proc, html);
}
