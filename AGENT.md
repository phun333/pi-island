# AGENT.md — pi-island

> Working memory for any AI agent (or human) continuing this project.
> Read this first before touching the codebase. Keep it in sync whenever
> you land a change that future-you will wish was documented.

---

## 1. What this is

**pi-island** is a macOS Dynamic-Island-style status capsule for the
[pi coding agent](https://github.com/badlogic/pi-mono). It lives flush
with the top edge of the primary screen and shows, in real time, what
each running pi session is doing:

- Left:   braille spinner + project name
- Middle: the user's original prompt (stable, doesn't move)
- Right:  status label + elapsed timer + context % usage

Multiple concurrent pi sessions (different terminals / projects) stack
as rows beneath one another, forming one continuous black capsule with
only the bottom row rounded.

The WebView is rendered by a tiny custom Swift host (`island-host`)
built as part of this repo. Two non-negotiable behaviors pin the
window above the menu bar and let it wrap the MacBook notch:
`window.level = .statusBar` and a no-op `constrainFrameRect` override.

---

## 2. Repo layout

```
pi-island/
├── AGENT.md                  ← you are here
├── README.md                 ← user-facing docs
├── LICENSE                   ← MIT (© phun333)
├── package.json              ← npm + pi extension manifest
├── .github/
│   └── workflows/
│       └── publish.yml       ← auto npm publish on `v*` tag push
├── scripts/
│   ├── build.mjs             ← swiftc island-host.swift → island-host-bin
│   └── postinstall.mjs       ← runs build.mjs on install (darwin only)
└── pi-extension/
    ├── index.ts              ← pi extension: event wiring + /island commands
    ├── companion.mjs         ← long-lived daemon that owns the WebView
    ├── island.html.mjs       ← HTML/CSS/JS inside the WebView
    ├── open-fixed.mjs        ← native host spawn wrapper (--x/--y Cocoa fix)
    ├── socket-path.mjs       ← ~/.pi/pi-island.sock helper
    ├── demo.mjs              ← visual demo, no pi required
    ├── island-host.swift     ← Swift source for the native WebView host
    └── island-host-bin       ← compiled binary (produced on install)
```

**Build artifacts (never commit):**
- `pi-extension/island-host-bin` — architecture-specific Mach-O, built
  per-machine by `scripts/postinstall.mjs`.
- `.build-skipped` — marker file written when `swiftc` is missing so we
  don't fail install; the extension then no-ops until `npm run build`.

**Not ours, leave alone:**
- `~/.pi/companion.json` — belongs to pi itself, unrelated to our
  companion daemon.
- `~/.pi/agent/` — pi's own state.

Our own runtime state lives **only** at `~/.pi/pi-island.sock`.

---

## 3. Architecture at a glance

```
┌──────────────────┐   unix socket   ┌──────────────────┐   stdin JSONL   ┌──────────────────┐
│  pi (session A)  │ ──────────────▶ │                  │ ──────────────▶ │  island-host     │
│  pi-extension    │                 │  companion.mjs   │                 │  (Swift + WKWeb) │
│  index.ts        │ ──────────────▶ │  one per user    │ ◀────────────── │  island.html     │
│  pi (session B)  │   ~/.pi/sock    │                  │   stdout JSONL  │                  │
└──────────────────┘                 └──────────────────┘                 └──────────────────┘
```

Three processes, three protocols:
1. **pi-extension ↔ companion** — Unix socket, line-delimited JSON
   (see §5: socket contract).
2. **companion ↔ island-host** — stdin/stdout line-delimited JSON, via
   `open-fixed.mjs` (see §7: host binary protocol).
3. **companion → WebView JS** — `win.send(js)` calls `evaluateJavaScript`
   inside the Swift host. The JS exposes `window.island.{upsertRow,
   removeRow, setMode}` (see `island.html.mjs`).

Inside the WebView, a single 80 ms braille ticker and a single 250 ms
elapsed ticker update all rows in sync. Rows are merged via
`upsertRow(id, data)` so partial updates don't clobber the saved prompt.

The companion shuts itself down 6 s after the last client disconnects
(see `scheduleIdleExit` in `companion.mjs`). This means: quit pi, wait
6 s, and the daemon+window go away with no leftover process.

---

## 4. Runtime model — pi events → island state

### 4.1. Event lifecycle (from `pi-extension/index.ts`)

| pi event              | What we do                                                               | Sends status      |
|-----------------------|--------------------------------------------------------------------------|-------------------|
| `session_start`       | Stash the `ctx` for later `getContextUsage()` calls. Do **not** show. | –                 |
| `before_agent_start`  | Capture `evt.prompt` (truncated to 48 chars) into `currentPrompt`.       | –                 |
| `agent_start`         | Clear active-tool count, reset timer, emit first update.                 | `thinking`        |
| `message_update`      | If no tool is running, refresh the row with current elapsed / ctx%.      | `thinking`        |
| `tool_execution_start`| Increment active-tool count, emit tool-specific status.                  | per §4.2 below    |
| `tool_execution_end`  | Decrement. If `isError`: emit `error`, auto-revert to `thinking` in 1.5 s. Otherwise if no active tools: back to `thinking`. | `error` / `thinking` |
| `agent_end`           | Freeze elapsed timer, emit `done`, schedule row retract after 5 s.       | `done`            |
| `session_shutdown`    | Remove row, end socket, nullify refs.                                    | (remove)          |

### 4.2. Tool → status map (`toolToIsland` in `index.ts`)

| pi tool name | Island status | Detail field shown                          |
|--------------|---------------|---------------------------------------------|
| `read`       | `reading`     | `basename(args.path)`                       |
| `edit`       | `editing`     | `basename(args.path)`                       |
| `write`      | `writing`     | `basename(args.path)`                       |
| `bash`       | `running`     | first token of `args.command` (e.g. `npm`)  |
| `ls`         | `searching`   | `basename(args.path)` or `.`                |
| `grep`       | `searching`   | `args.pattern`                              |
| `find`       | `searching`   | `args.pattern` or `args.path`               |
| *(anything else)* | `running` | the tool name itself                        |

**Adding a new pi tool:** if pi ever ships a new built-in tool, the
default branch already gives it a generic "Running" visual. Upgrade it
to a proper status by (a) extending `toolToIsland`, (b) picking a
color+label in the `STATUS` table (see §6.3), (c) adding a row to the
README color table.

### 4.3. Prompt handling

- User prompt is captured in `before_agent_start` and truncated via
  `truncatePrompt(str, 48)` — collapses whitespace, ellipsis if longer.
- The middle slot **always** prefers `d.prompt`. `d.detail` is only a
  fallback when there is no prompt (shouldn't happen for real sessions).
- Visual styling switches via class: `.prompt` (italic, quoted) vs
  `.detail` (monospace).

### 4.4. Context % & timer

- Context: `ctx.getContextUsage()?.percent`, rounded. Shown as `34%`.
  Color gates: ≥60 → amber, ≥85 → red.
- Timer: `(Date.now() - startedAt) / 1000`, formatted `1.2s / 42s /
  1m 47s / 2h 15m`. Note the space between `1m` and `47s` — user-
  requested readability fix, don't collapse.

### 4.5. The `/island` vs `/island2` commands

Both commands are registered in `index.ts` via `pi.registerCommand`.
Since **v0.1.1** the island is ON by default — user preference is
persisted in `~/.pi/pi-island.json` (`{"enabled": true|false}`) and
read on extension load. `/island` flips + writes the new value, so the
choice survives every pi restart until explicitly toggled again.

| Command     | Effect                                                                                            |
|-------------|---------------------------------------------------------------------------------------------------|
| `/island`   | Toggle visibility AND persist to `~/.pi/pi-island.json`. Off → row retracts, no updates sent. On → capsule appears on next agent turn. |
| `/island2`  | Force `shownForSession = true`, persist enabled, AND send `{type:"mode", mode:"notch"}` to the companion. |

**Known limitation:** there is no `/island3` or "go back to normal
mode" toggle. If you hit `/island2` on a non-notched Mac and want
the middle content back, you have to kill the companion
(`pkill -f companion.mjs`) and `/island` again. Tracked in §11.

The companion ALSO auto-detects the notch on spawn via JXA
`safeAreaInsets.top`. So on a MacBook with a notch, you get notch mode
automatically without typing `/island2`.

---

## 5. Socket protocol — extension → companion

One JSON object per line. Writer: `writeMessage` in `index.ts`. Reader:
`rl.on("line")` in `companion.mjs`.

```jsonc
// Client → companion, normal update (most common)
{ "id":             "<8-char-uuid>",   // stable per pi session (randomUUID().slice(0,8))
  "type":           "update",
  "project":        "pi-auth",         // basename(cwd)
  "status":         "editing",         // see STATUS table in island.html.mjs
  "detail":         "login.ts",        // optional, tool-specific short string
  "prompt":         "fix the auth…",   // already truncated to ≤48 chars
  "ctxPct":         34,                // 0-100, null if unknown
  "startedAt":      1713622000000,     // ms epoch, set on agent_start
  "frozenElapsed":  null               // non-null ms = stop ticking timer
}

// Remove a row (pi session retracted or shut down)
{ "id": "...", "type": "remove" }

// Force notch mode on the WebView
{ "id": "...", "type": "mode", "mode": "normal" | "notch" }
```

**Required vs optional:**
- Required on `update`: `id`, `type`, `status`.
- Everything else is optional. Companion passes the JSON straight
  through; the WebView's `upsertRow` merges with previous state, so a
  partial update (`{id, type, status, detail}`) keeps the earlier
  `prompt` / `startedAt`. This is why the demo can omit `prompt` on
  every step after the first.

**Status vocabulary** — must match keys in the `STATUS` table in
`island.html.mjs`:
```
thinking | reading | editing | writing | running | searching | done | error
```

Unknown statuses fall back to `thinking` visual.

---

## 6. Key design decisions (don't undo these)

### 6.1. Pin to `NSScreen.screens[0]` — the menu-bar screen
`mainScreen` follows the focused window; it caused the capsule to jump
displays when the user dragged focus. Geometry is re-probed via JXA on
every companion spawn so arrangement changes are picked up live.

### 6.2. Window level = `.statusBar` + `constrainFrameRect` override
Two lines inside `island-host.swift` that make Dynamic-Island
positioning possible:
1. `window.level = .statusBar` — draws above the menu bar
2. Overriding `constrainFrameRect` — AppKit normally yanks any window
   back inside `visibleFrame`; we refuse.

Without **both**, the capsule sits below the menu bar or drifts downward
after spawning. This is why we ship our own native Swift host instead
of relying on any generic WebView shell.

### 6.3. Middle slot = absolute-centered, not grid
CSS grid with `130px 1fr 170px` was almost stable but showed sub-pixel
jitter on the middle text when the right-side label cycled
(`Editing ↔ Writing ↔ Running`). Current layout:
- Row: `display: flex; justify-content: space-between; position: relative`
- Middle `.slot.mid`: `position: absolute; left: 50%; transform: translateX(-50%)`

This pins the user's prompt **pixel-perfectly** regardless of right-slot
reflow. Verify with `node pi-extension/demo.mjs single`.

### 6.4. Stack = one capsule, not separate pills
Consecutive rows share a 1 px `rgba(255,255,255,0.08)` divider; only the
last row rounds its bottom corners. No per-row drop-shadow (shadow
bled into the screen edge as a visible black corner).

### 6.5. Notch mode — auto on spawn, manual override via `/island2`
`companion.mjs` sets `autoMode = notchH > 0 ? "notch" : "normal"` based
on JXA `safeAreaInsets.top` and applies it when the WebView signals
`ready`. `/island2` overrides to `"notch"` on demand (no reverse
command exists — see §11).

### 6.6. Demo matches production sizing
`demo.mjs` routes through the **same** companion / WebView as real pi,
so row size is intrinsically identical. Do not re-introduce a
standalone demo HTML — it drifts.

### 6.7. Sizing constants (all live in `companion.mjs` + `island.html.mjs`)

| Constant              | Value       | Where / why                                                    |
|-----------------------|-------------|----------------------------------------------------------------|
| `WIN_W`               | 640 px      | `companion.mjs` — outer WebView window width (wider than the capsule itself so we have breathing room; the extra is transparent + clickThrough). |
| `WIN_H`               | 420 px      | `companion.mjs` — window height, room for ~10 stacked rows. NSWindow can't be resized after spawn so we reserve. |
| Window position       | `x = (screenW-WIN_W)/2, y = screenH-WIN_H` | Center horizontally; Cocoa origin is bottom-left, so `screenH-WIN_H` puts the TOP of the window at the TOP of the screen. |
| Row width             | 460 px      | `island.html.mjs .row` — chosen by eye to match iPhone Dynamic Island proportions. |
| Row height            | 34 px       | `island.html.mjs .row` — same. Animated via `max-height` for fade-in. |
| Row grid (left/mid/right) | auto / 150 px max / auto | Flex layout with middle absolute-centered; 150 px middle keeps clear of left (~130 content) + right (~170 content). |
| JXA fallback geometry | `1440×900, notch=0` | If the osascript probe fails (should never). |
| JXA probe timeout     | 1500 ms     | `getScreenGeometry()` in `companion.mjs`. |
| Idle-exit delay       | 6000 ms     | `scheduleIdleExit()` in `companion.mjs`. |
| Done-row retract      | 5000 ms     | `hideTimer` in `index.ts` after `agent_end`. |
| Error auto-revert     | 1500 ms     | `tool_execution_end` error branch in `index.ts`. |
| Braille tick          | 80 ms       | `tickerB` in `island.html.mjs`. |
| Elapsed tick          | 250 ms      | `tickerT` in `island.html.mjs`. |
| Prompt truncation     | 48 chars    | `truncatePrompt()` in `index.ts`. |

---

## 7. Host binary protocol — companion ↔ island-host

The Swift host (`island-host-bin`) reads one JSON object per line from
stdin and writes one JSON object per line to stdout. See
`open-fixed.mjs` for the Node side and `island-host.swift` for the
Swift side.

### 7.1. argv flags we use

```
--width N --height N --x N --y N
--frameless --floating --transparent --click-through --no-dock
```

Flags present but unused: `--title`, `--hidden`. Harmless to leave but
could be removed.

**Important quirk:** `--x` and `--y` MUST be passed as two argv entries
(`--x 100`), not `--x=100`. The Swift argument parser silently drops
the `=` form and positions the window at screen center. This is why
`open-fixed.mjs` exists.

### 7.2. Node → Swift messages (stdin)

```jsonc
{ "type": "eval", "js": "window.island.upsertRow(...)" }  // run JS in WebView
{ "type": "html", "html": "<base64-encoded-document>" }   // set page content
{ "type": "close" }                                       // close window
```

### 7.3. Swift → Node messages (stdout)

```jsonc
{ "type": "ready",   "screen": {...}, "appearance": "...", "cursor": {...} }
{ "type": "message", "data": <any JSON from window.islandHost.send(...)> }
{ "type": "click" }     // unused by us
{ "type": "closed" }
```

We currently consume only `ready` (to flush pending HTML) and `closed`
(to shut down the companion). `message` and `click` are passed through
as events — none of our code subscribes to them yet.

### 7.4. The JS bridge inside the WebView

`island-host.swift` injects a `window.islandHost` object with
`send(data)` and `close()`. Our `island.html.mjs` does NOT use this —
everything flows via `win.send(js)` → `evaluateJavaScript` from Node
side. The bridge is available if we ever want the WebView to call
back (e.g. click-to-dismiss).

---

## 8. What is done

- ✅ Window pinned top-of-screen above menu bar (all Macs)
- ✅ Notch wrap via `/island2` + auto-detect on spawn
- ✅ Compact fixed size (no resize on state change)
- ✅ Dot-loader + per-status colors (matches pi's own loader set)
- ✅ Context % + elapsed timer (tabular-nums; space between `1m` and `47s`)
- ✅ Multi-monitor: always targets menu-bar screen
- ✅ Multi-session stack (rows fuse into one capsule, shared dividers)
- ✅ Demo mirrors real runtime dimensions
- ✅ Middle slot is pixel-stable (absolute centered)
- ✅ Auto idle-exit of companion 6 s after last client disconnects
- ✅ GitHub Actions auto-publish on `v*` tag push
- ✅ Default-on with persisted user preference (v0.1.1)

---

## 9. Release process

Target: publishable open-source npm package installable via
`pi install npm:pi-island`.

### 9.1. Pre-flight cleanup
- [x] `.gitignore` covers `node_modules/`, `.DS_Store`,
      `pi-extension/island-host-bin`, `pi-session-*.html`, `.build-skipped`
- [x] `package.json` author/repo URLs point at `phun333`
- [x] `README.md` documents real script names (`demo` + `demo:single`)
- [x] `files:` whitelist contains source only, no build artifacts
- [x] No `pi-session-*.html` export in repo root

### 9.2. Local smoke test
- [ ] Fresh clone into `/tmp` → `npm install` → `npm run demo`
      (verifies postinstall produces `island-host-bin`)
- [ ] `pi install /absolute/path/to/pi-island` then `/island` inside pi
      → capsule appears, updates, disappears after `agent_end`.

### 9.3. Commit strategy
Goal: clean history for an open-source first impression. Proposed
sequence of commits (squash/collapse as needed):

1. `chore: .gitignore + MIT license`
2. `feat: native Swift host with top-pin + no-constrain patches`
3. `feat: companion daemon + socket protocol`
4. `feat: pi extension with /island and /island2 commands`
5. `feat: stacked multi-session capsule with pixel-stable middle`
6. `feat: visual demo (stack + single modes)`
7. `ci: auto-publish to npm on v* tag push`
8. `docs: README + AGENT.md`

### 9.4. Tag + push
```bash
git tag -a v0.1.0 -m "pi-island v0.1.0 — initial public release"
git push origin main
git push origin v0.1.0
```
Pushing the tag triggers `.github/workflows/publish.yml`.

### 9.5. npm publish — first time

**Before tag push**, set the GitHub repo secret:
- Settings → Secrets and variables → Actions → **New repository secret**
- Name: `NPM_TOKEN`
- Value: an npm access token (create at npmjs.com → Access Tokens →
  Generate → "Automation" type so it bypasses 2FA).

Optionally dry-run from local before CI takes over:
```bash
npm login
npm publish --access public --dry-run   # inspect tarball file list
```

The workflow runs `npm publish --access public` on `macos-latest` with
`NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}` — macOS is required so
`postinstall` can compile the Swift host.

### 9.6. Verify after publish
- `npm view pi-island version` → matches tag
- On a clean Mac: `pi install npm:pi-island` → `/island` works
- GitHub Release page: create one from the tag with human-readable notes.

### 9.7. Post-v0.1.0 polish (nice-to-have, not blocking)
- [ ] Demo GIF in README
- [ ] Badges: npm version, license, macOS-only
- [ ] Troubleshooting section in README

---

## 10. Developer workflow

Three ways to iterate, ranked by inner-loop speed:

### 10.1. Fastest — demo only
```bash
node pi-extension/demo.mjs          # stacked demo
node pi-extension/demo.mjs single   # single-row cycle
```
No pi involved. Edit `island.html.mjs` / `companion.mjs` then re-run.
If the companion was running, kill it first:
```bash
pkill -f pi-island/pi-extension/companion.mjs
```

### 10.2. Medium — pi with local path install
```bash
pi install /absolute/path/to/pi-island
```
Inside pi:
- `/reload` picks up `index.ts` changes without restarting pi.
- `/island` toggles the capsule.
- Changes to Swift or the companion STILL require `pkill` + next run.

### 10.3. Slow — real npm install
```bash
pi install npm:pi-island
```
Only useful for smoke-testing the published tarball. Don't iterate here.

---

## 11. Debugging recipes

### 11.1. The capsule is stuck / still showing
The companion daemon is still alive. Kill it:
```bash
pkill -f pi-island/pi-extension/companion.mjs
rm -f ~/.pi/pi-island.sock
```
Next `/island` will respawn cleanly.

### 11.2. `/island` does nothing after toggling on
Possible causes:
- Swift host failed to build → check `pi-extension/island-host-bin`
  exists. If not: `cd pi-island && npm run build`.
- `.build-skipped` marker present → swiftc missing. Run
  `xcode-select --install`, then `npm run build`.
- Companion crashed silently on spawn. Run it in foreground to see
  stderr:
  ```bash
  node pi-extension/companion.mjs
  ```

### 11.3. See what the companion is receiving
Run the companion in foreground (previous tip). Every socket message
flows through `rl.on("line")`. Drop a `console.error(JSON.stringify(msg))`
there to trace.

### 11.4. Window is in the wrong place
Re-probe geometry:
```bash
osascript -l JavaScript -e "ObjC.import('AppKit'); const s = $.NSScreen.screens.js[0]; JSON.stringify({w: s.frame.size.width, h: s.frame.size.height, notch: (s.safeAreaInsets && s.safeAreaInsets.top) || 0})"
```
Compare with the companion's assumptions (`WIN_W`, centering math).

### 11.5. Middle text is jittering again
`island.html.mjs .slot.mid` lost its `position: absolute`. Restore it.
Test via `node pi-extension/demo.mjs single` and watch the prompt as
the right label cycles.

### 11.6. Rebuilding Swift after editing `island-host.swift`
```bash
npm run build           # recompile
pkill -f pi-island/pi-extension/companion.mjs   # drop running companion
rm -f ~/.pi/pi-island.sock
# next /island or demo spawns a fresh companion with the new binary
```

### 11.7. Multiple pi-island checkouts on the same machine
All companions share `~/.pi/pi-island.sock`. If two checkouts both
spawn companions, the second sees `EADDRINUSE` and exits silently
(`server.on("error")` in `companion.mjs`). Rule of thumb: one
working tree at a time. **Do not keep an old `~/Desktop/pi-island`
alive alongside the real repo** — it happened during bootstrap and
caused confusing "why is the old binary running?" sessions.

---

## 12. Conventions for future agents

- **Never** remove the `constrainFrameRect` override or change
  `window.level` without re-verifying top-pin on at least one Mac
  with a notch AND one without.
- **Never** switch middle slot back to a grid track. Absolute center
  is a hard requirement for stable text (see §6.3).
- **Never** auto-commit `pi-extension/island-host-bin` — it's
  architecture-dependent and rebuilt per-install.
- **Never** introduce a dependency on the upstream/external WebView
  shell this was originally prototyped against. Our patches ARE the
  project; swapping the host defeats the point.
- When adding a new status, update three places:
  1. `STATUS` table in `island.html.mjs`
  2. `toolToIsland` map in `index.ts` (if tool-triggered)
  3. README color-table row
- When adding a new socket field, update:
  1. Message construction in `index.ts` (`sendUpdate`)
  2. `renderRowContent` in `island.html.mjs`
  3. §5 of this file (socket contract)
- Keep `AGENT.md` §6.7 (sizing table) in sync with any constant change.
- Turkish user comms are fine; code / commits / docs stay English.

---

## 13. Known non-goals

- **Linux/Windows UI** — extension no-ops off darwin, intentional.
- **Custom color themes** — fixed palette matches pi-agent loader colors.
- **Click interactions on the capsule** — it's `clickThrough: true` by
  design (must not steal input at the top of the screen).
- **Code-signing / notarization of the binary** — we compile on the
  user's machine via swiftc, so Gatekeeper does not intercept. If we
  ever distribute a prebuilt binary, this becomes a hard requirement.

---

## 14. Known limitations / quirks

- **`/island2` has no toggle-back** — once you switch to notch mode,
  there's no command to return to normal mode without killing the
  companion. Fix: add `/island3` or make `/island2` toggle.
- **Single socket carries multiple session IDs** — when one pi process
  sends removes for id A then id B on the same socket, the companion's
  `sock.on("close")` only knows the *last* clientId. If the socket
  dies mid-stream, stale rows can remain until idle-exit fires. Low
  impact; fix by tracking all ids seen on a given socket.
- **Resizing not supported** — `NSWindow` after spawn cannot change
  size. If we ever need dynamic sizing, `island-host.swift` needs a
  `{type:"resize"}` stdin handler.
- **Peer dependency is `"*"`** — `@mariozechner/pi-coding-agent` pinned
  to any version. If the extension API changes, install may succeed
  but `index.ts` will crash on load. Pin when pi reaches 1.0.
- **No uninstall cleanup hook** — `npm uninstall` / `pi uninstall`
  leaves `~/.pi/pi-island.sock` if the companion was killed mid-run.
  Harmless on next run (auto-unlinked).

---

## 15. Future improvement backlog

Not planned for v0.1.0 but worth tracking:

- `/island3` command to revert notch → normal at runtime.
- Expand/collapse animation on hover (hover is currently blocked by
  `clickThrough: true`; would need mouse-tracking area).
- Show the tool's actual target in `detail` for `bash` (current first
  token is coarse — `npm test` vs `npm install` both show `npm`).
- Optional per-session color (e.g. hash project name → hue) so users
  with many stacked pi runs can tell rows apart at a glance.
- CPU cost audit: two intervals (80 ms + 250 ms) always on while
  spinning. Probably fine but not measured.
- Recorded demo GIF, tested on a notched MacBook AND an external
  display (cross-env parity check).
- Linux equivalent someday — probably a separate project, given
  Linux has no "floating status-bar-level WebView" primitive like
  `.statusBar`.
