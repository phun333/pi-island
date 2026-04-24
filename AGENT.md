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
├── package.json              ← npm + pi extension manifest + optionalDependencies
├── .github/
│   └── workflows/
│       └── publish.yml       ← build 3 platform binaries + publish 4 npm packages
├── packages/                 ← platform-specific npm packages (binary only)
│   ├── darwin-arm64/         ← @pi-island/darwin-arm64
│   ├── darwin-x64/           ← @pi-island/darwin-x64
│   └── win32-x64/            ← @pi-island/win32-x64
├── hosts/                    ← native host source code (one per platform)
│   ├── macos/
│   │   └── island-host.swift ← Cocoa + WKWebView (statusBar level + constrainFrameRect)
│   └── windows/
│       ├── island-host.cs    ← WPF + WebView2 (AllowsTransparency + --disable-gpu)
│       └── island-host.csproj
├── scripts/
│   ├── build.mjs             ← platform routing: swiftc (macOS) / dotnet (Windows)
│   ├── postinstall.mjs       ← resolve binary from platform pkg OR fallback build
│   └── bump-version.mjs      ← sync versions across all 4 packages
└── pi-extension/
    ├── index.ts              ← pi extension: event wiring + /island commands
    ├── companion.mjs         ← long-lived daemon that owns the WebView
    ├── island.html.mjs       ← HTML/CSS/JS inside the WebView (platform-agnostic)
    ├── open-fixed.mjs        ← host spawn wrapper (platform binary routing)
    ├── platform.mjs          ← screen geometry, coordinates, notch (per-platform)
    ├── socket-path.mjs       ← Unix socket (macOS) / named pipe (Windows)
    ├── demo.mjs              ← visual demo, no pi required
    ├── island-host.swift     ← Swift source (kept for npm tarball backward compat)
    ├── island-host-bin       ← macOS binary (built on install or from platform pkg)
    └── island-host-win.exe   ← Windows binary (built on install or from platform pkg)
```

**Build artifacts (never commit):**
- `pi-extension/island-host-bin` — macOS Mach-O binary.
- `pi-extension/island-host-win.exe` — Windows PE binary.
- `hosts/windows/bin/`, `hosts/windows/obj/`, `hosts/windows/out/` — .NET build intermediates.
- `packages/*/island-host-*` — CI-built binaries for platform packages.
- `.build-skipped` — marker file written when compiler is missing.

**Not ours, leave alone:**
- `~/.pi/companion.json` — belongs to pi itself.
- `~/.pi/agent/` — pi's own state.

Our own runtime state lives at:
- macOS: `~/.pi/pi-island.sock` (Unix domain socket)
- Windows: `//./pipe/pi-island` (named pipe)

---

## 3. Architecture at a glance

```
┌──────────────────┐   IPC (socket/pipe)  ┌──────────────────┐   stdin JSONL   ┌──────────────────┐
│  pi (session A)  │ ─────────────────▶ │                  │ ──────────────▶ │  island-host     │
│  pi-extension    │                    │  companion.mjs   │                 │  macOS: Swift    │
│  index.ts        │ ─────────────────▶ │  one per user    │ ◀────────────── │  Windows: C#     │
│  pi (session B)  │                    │                  │   stdout JSONL  │  island.html     │
└──────────────────┘                    └──────────────────┘                 └──────────────────┘

macOS IPC:   ~/.pi/pi-island.sock (Unix domain socket)
Windows IPC: //./pipe/pi-island   (named pipe)
```

Three processes, three protocols:
1. **pi-extension ↔ companion** — Unix socket (macOS) / named pipe (Windows),
   line-delimited JSON (see §5: socket contract).
2. **companion ↔ island-host** — stdin/stdout line-delimited JSON, via
   `open-fixed.mjs` (see §7: host binary protocol).
3. **companion → WebView JS** — `win.send(js)` calls `evaluateJavaScript`
   inside the Swift host. The JS exposes `window.island.{upsertRow,
   removeRow, setMode, setScale}` (see `island.html.mjs`).

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
- Timer: `(Date.now() - startedAt) / 1000`, formatted as integer
  seconds — `0s / 42s / 16m / 16m 52s / 2h 15m`. Note the space
  between `1m` and `47s` — user-requested readability fix, don't
  collapse. The "sub" unit (` 52s` after `16m`, ` 15m` after `2h`) is
  a separate span so notch mode can `display:none` it independently
  — in the notched first row the readout stays at 3–4 chars (`16m`,
  `1h`, `12h`) so the growing timer never slides behind the notch.

### 4.5. The `/island` command (v0.2.0+, `reload` added in v0.2.1)

`/island` is the single entry point — no more `/island2`. With no args it
opens a settings menu rendered via `ctx.ui.custom()` + pi-tui's
`SettingsList` (the same drop-down UX as pi's own `/settings`). Four
rows, each Enter/Space cycles its values:

| Setting      | Values                               | Apply method                           |
|--------------|--------------------------------------|----------------------------------------|
| Visibility   | `enabled` / `disabled`               | Live (send remove / ensureConnection). |
| Size         | `small` / `medium` / `large` / `xlarge` | Live (socket `scale` message).      |
| Screen       | `primary` / `active` / `2` / `3` …  | Respawn companion (NSWindow fixed).    |
| Notch wrap   | `auto` / `normal` / `notch`          | Respawn companion (read at spawn).     |

All four fields are persisted in `~/.pi/pi-island.json`:
```json
{ "enabled": true, "scale": "medium", "screen": "primary", "notchMode": "auto" }
```
Missing fields fall back to defaults, so a v0.1.x pref file (just
`{"enabled": true}`) upgrades cleanly with no user action.

**Quick-action subcommands** (skip the menu — same helpers, same persistence):
```
/island on | enable | off | disable | toggle
/island size   <small|medium|large|xlarge>
/island screen <primary|active|2|3|...>
/island notch  <auto|normal|notch>
/island reload | reset                      # v0.2.1: force companion respawn
```

The `reload` subcommand calls `forceRespawn()` which pkills any
pre-0.2.1 companion that doesn't understand the `respawn` message.
Also exposed as `reset` for discoverability.

**Removed in v0.2.0:** `/island2`. Its behaviour (force notch wrap)
moved into the menu's `Notch wrap` row — and unlike the old command,
there is now an `auto` value to revert to detection mode. Release notes
flagged this as a breaking change.

The companion still auto-detects the notch on spawn via JXA
`safeAreaInsets.top` whenever `notchMode` resolves to `auto`.

**See also:** helpers live in `index.ts` — `doEnable/doDisable/
doSetScale/doSetScreen/doSetNotchMode`, `openSettingsMenu`,
`respawnCompanion`. Menu and subcommands share the same helpers so
behaviour can't drift.

---

## 5. Socket protocol — extension → companion

One JSON object per line. Writer: `writeMessage` in `index.ts`. Reader:
`rl.on("line")` in `companion.mjs`.

```jsonc
// Client → companion, normal update (most common)
{ "id":             "<8-char-uuid>",   // stable per pi session (randomUUID().slice(0,8))
  "type":           "update",
  "project":        "pi-auth",         // basename(cwd), truncated to ≤20 chars
  "status":         "editing",         // see STATUS table in island.html.mjs
  "detail":         "login.ts",        // optional, tool-specific short string
  "prompt":         "fix the auth…",   // already truncated to ≤48 chars
  "ctxPct":         34,                // 0-100, null if unknown
  "startedAt":      1713622000000,     // ms epoch, set on agent_start
  "frozenElapsed":  null,              // non-null ms = stop ticking timer
  "rowScale":       "large"            // optional, DEMO-ONLY per-row scale override
}

// Remove a row (pi session retracted or shut down)
{ "id": "...", "type": "remove" }

// Notch mode — flips body.notch-mode class in the WebView (live, no respawn)
{ "id": "...", "type": "mode",    "mode":  "normal" | "notch" }

// Size preset — flips the global --scale CSS var (live, no respawn)
{ "id": "...", "type": "scale",   "scale": "small" | "medium" | "large" | "xlarge" }

// Graceful companion shutdown — client's next ensureConnection() spawns a
// fresh instance that re-reads ~/.pi/pi-island.json (used for screen and
// notchMode changes where NSWindow geometry is fixed at spawn).
{ "id": "...", "type": "respawn" }

// Version handshake (v0.2.1+). Client sends this on every fresh connect;
// companion replies with `hello-ack`. A mismatch (or timeout — pre-0.2.1
// companions don't respond) triggers the client to forceRespawn the
// companion. See §6.8 (auto-heal).
{ "id": "...", "type": "hello", "version": "0.2.1" }
```

**Server → client** messages (v0.2.1+, only in response to `hello`):
```jsonc
{ "type": "hello-ack", "version": "0.2.1" }
```

**Explicit dispatch — no default-upsert (v0.2.1+).** Pre-0.2.1 companions
treated any unknown message type as an upsert, which produced empty
"ghost" rows when a newer client sent a message an older companion
didn't know. Every message type is now dispatched by exact match;
unknown types are silently dropped. Consequence: **adding a new message
type requires an explicit handler in `companion.mjs` — it won't just
"work" via the default branch any more.**

**Required vs optional:**
- Required on `update`: `id`, `type`, and a `status` from the vocabulary
  below. Updates without a valid `status` are dropped at the companion
  (another ghost-row safety net).
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

**Preference schema** (`~/.pi/pi-island.json`) — owned by `index.ts`,
but also read directly by `companion.mjs` on spawn for `screen` and
`notchMode` (settings that determine NSWindow geometry and can't be
changed without a fresh window). All fields are optional; missing
values fall back to defaults.
```jsonc
{
  "enabled":     true,        // default true
  "scale":       "medium",    // default "medium"  (one of SCALES in §12)
  "screen":      "primary",   // default "primary" | "active" | "2" | "3" | …
  "notchMode":   "auto",      // default "auto"    | "normal" | "notch"
  "lastVersion": "0.2.1"      // (v0.2.1+) pi-island version that last ran;
                              // drives the one-time upgrade notify
}
```

---

## 6. Key design decisions (don't undo these)

### 6.1. Screen selection is a user preference (v0.2.0+)
Default is `NSScreen.screens[0]` (menu-bar screen, `"primary"`) — the
original stable anchor that avoided the "capsule jumps with focus" bug
that `mainScreen` caused. But users on multi-monitor setups can opt in
to `"active"` (screen under mouse at spawn, the PR #3 behaviour) or a
specific monitor index (`"2"`, `"3"` …). The selector runs in JXA inside
`companion.mjs::buildScreenSelectorJXA()`. Geometry is re-probed on
every companion spawn; changing the `screen` pref sends a `respawn`
message so the change is immediate.

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

### 6.5. Auto-heal via version handshake (v0.2.1+)
On every fresh socket connect the extension sends
`{type:"hello", version:"<current>"}`. The companion replies with
`{type:"hello-ack", version:"<its>"}`. Outcomes:

| Response | Interpretation | Action |
|----------|----------------|--------|
| Versions equal | compatible companion | proceed |
| Versions differ | stale companion after `npm update` | forceRespawn |
| No response within 1 s | pre-0.2.1 companion (no handler) | forceRespawn |

`forceRespawn()` is deliberately belt-and-braces:
1. Send a polite `remove` + `respawn` (pre-0.2.1 companions don't
   understand these, but sending them is harmless — they get dropped
   now that default-upsert is gone).
2. `pkill -f pi-island/pi-extension/companion.mjs` for pre-0.2.1
   companions that won't exit on their own.
3. `unlinkSync(SOCK)` in case the old process died without cleanup.
4. Wait 300 ms, reconnect — which spawns a fresh companion.

This is the invisible fix for the "user ran `npm i pi-island` and now
sees empty rows" bug (see §14 known-limitations history). Prior to
0.2.1 the only fix was `/island reload` (manual) or restarting the
terminal.

**Do not remove the handshake** without replacing it with another
way to detect state mismatch — the pre-0.2.1 ghost-row bug is not
hypothetical, it shipped to users.

### 6.6. Notch mode — pref-driven with an `auto` default (v0.2.0+)
`companion.mjs` reads `notchMode` from the pref file on spawn and
decides:
- `auto` (default) — `autoMode = notchH > 0 ? "notch" : "normal"`, the
  original behaviour via JXA `safeAreaInsets.top`.
- `normal` — force disabled regardless of detection.
- `notch` — force enabled regardless of detection (replaces the old
  `/island2` command).

The live `{type:"mode"}` socket message still exists for same-session
toggles, but settings-menu changes to `notchMode` round-trip through
`respawn` so `autoMode` is recomputed with the new pref.

### 6.7. Demo matches production sizing
`demo.mjs` routes through the **same** companion / WebView as real pi,
so row size is intrinsically identical. Do not re-introduce a
standalone demo HTML — it drifts.

### 6.8. Sizing constants

All numeric sizes in `island.html.mjs` that affect visual proportion are
multiplied by `var(--scale)`, a CSS custom property driven by the user's
`size` preset. Defaults below are at `medium` (`--scale: 1.0`).
`setScale(name)` on `window.island` flips the global scale; demo mode
can also set `--scale` inline on a single row via `rowScale` for the
"all presets stacked" showcase.

| Constant              | Value @ medium | Notes                                                       |
|-----------------------|----------------|-------------------------------------------------------------|
| `WIN_W`               | 640 px (fixed) | `companion.mjs`. Must fit the largest row (621 px at xlarge) plus clickThrough breathing room. |
| `WIN_H`               | 420 px (fixed) | `companion.mjs`. NSWindow can't be resized after spawn so we reserve room for ~9-10 stacked rows at any scale. |
| Window position       | `x = (screenW-WIN_W)/2, y = screenH-WIN_H` | Global coords; `y` places the TOP of the window at the TOP of the chosen screen. |
| `SCALES` (JS)         | `{small:0.88, medium:1.0, large:1.18, xlarge:1.35}` | `island.html.mjs`. Must match the `SCALES` string list in `index.ts`. 1.35 is the ceiling at `WIN_W=640`. |
| Row width             | `460 * scale`  | `.row` width — scales so left/middle/right proportions stay balanced. |
| Row height            | `34 * scale`   | `.row` height; `max-height` enter animation uses the same calc. |
| Left slot max-width   | `130 * scale`  | `.slot.left` clamps the project name via ellipsis so long basenames don't collide with the absolute-centered middle slot. |
| Middle slot max-width | `150 * scale`  | `.slot.mid`, absolute-centered. |
| Border radius (bottom corners of last row) | `22 * scale` | Capsule corner rounding. |
| JXA fallback geometry | `1440×900, notch=0` | If the osascript probe fails (should never).       |
| JXA probe timeout     | 1500 ms        | `getScreenGeometry()` in `companion.mjs`.                   |
| Idle-exit delay       | 6000 ms        | `scheduleIdleExit()` in `companion.mjs`.                    |
| Done-row retract      | 5000 ms        | `hideTimer` in `index.ts` after `agent_end`.                |
| Error auto-revert     | 1500 ms        | `tool_execution_end` error branch in `index.ts`.            |
| Braille tick          | 80 ms          | `tickerB` in `island.html.mjs`.                             |
| Elapsed tick          | 250 ms         | `tickerT` in `island.html.mjs`. Timer shows integer seconds. |
| Prompt truncation     | 48 chars       | `truncatePrompt()` in `index.ts`.                           |
| Project truncation    | 20 chars       | `truncateProject()` in `index.ts` (source-side guard; CSS ellipsis adds a second safety net). |

### 6.9. Windows host — design decisions (v0.3.0+)

The Windows host (`island-host-win.exe`) is a C# WPF + WebView2 app
that speaks the **same** stdin/stdout JSON protocol as the Swift host.
Key implementation decisions:

**AllowsTransparency + --disable-gpu:** WPF `AllowsTransparency=true`
creates a layered window (required for per-pixel transparency and
click-through). WebView2's GPU renderer crashes with layered windows
(`STATUS_ACCESS_VIOLATION`). Fix: pass `--disable-gpu` via
`CoreWebView2EnvironmentOptions.AdditionalBrowserArguments`. Software
rendering is fine for a tiny status capsule.

**Click-through:** `WS_EX_TRANSPARENT` on a layered window makes it
invisible to mouse hit-testing. No `WS_EX_LAYERED` needed because
`AllowsTransparency` already sets it.

**No taskbar / Alt+Tab:** `WS_EX_TOOLWINDOW` + `ShowInTaskbar=false`.

**Always on top:** `Topmost=true` (WPF) + `SetWindowPos(HWND_TOPMOST)`
(Win32 belt-and-braces).

**Physical pixel positioning:** `SetWindowPos` in `OnSourceInitialized`
bypasses WPF DPI scaling. The companion sends physical pixel coords
via `--x` / `--y` argv.

**Named pipe path:** Must be `//./pipe/pi-island` (forward slashes).
The backslash form `\\.\pipe\pi-island` causes `EACCES` in Node.js
on some Windows environments. Node.js `net` module handles both forms
but forward slashes are safer.

**Process exit:** `Environment.Exit(0)` with `Interlocked` guard
against double-exit. Stdin EOF triggers aggressive exit (try
Dispatcher.Invoke, then force-kill after 1s timeout).

**windowsHide:** All `spawn()` and `execSync()` calls in the JS layer
use `windowsHide: true` to prevent CMD window flash.

**WebView2 user data:** Stored in `%LOCALAPPDATA%/pi-island/webview2/`
to avoid colliding with other WebView2 apps.

### 6.10. Binary distribution (v0.3.0+)

Pre-built host binaries ship as platform-specific npm packages under
the `@pi-island` org (free public). npm `optionalDependencies` with
`os` + `cpu` fields ensure only the matching binary is downloaded.

| Package | Platform | Binary |
|---------|----------|--------|
| `@pi-island/darwin-arm64` | macOS Apple Silicon | `island-host-bin` (~2 MB) |
| `@pi-island/darwin-x64` | macOS Intel | `island-host-bin` (~2 MB) |
| `@pi-island/win32-x64` | Windows x64 | `island-host-win.exe` (~69 MB) |

The Windows binary is large because it bundles the .NET 8 runtime
(self-contained, `PublishSingleFile`). WPF does not support trimming.
End users install nothing — the binary runs standalone.

### 6.11. Beta releases (v0.3.0+)

`npm publish --tag beta` keeps pre-release versions off the default
install. Users get beta only via `npm install pi-island@beta`.
CI auto-detects beta from the git tag name (`v*beta*` -> `--tag beta`).

---

## 7. Host binary protocol — companion ↔ island-host

Both the Swift host (macOS) and C# host (Windows) read one JSON object
per line from stdin and write one JSON object per line to stdout. See
`open-fixed.mjs` for the Node side, `island-host.swift` for macOS,
and `island-host.cs` for Windows.

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

- [x] Window pinned top-of-screen above menu bar (all Macs)
- [x] Compact fixed-size window (no resize on state change)
- [x] Dot-loader + per-status colors (matches pi's own loader set)
- [x] Context % + elapsed timer (integer seconds, abbreviated in notch mode)
- [x] Multi-session stack (rows fuse into one capsule, shared dividers)
- [x] Demo mirrors real runtime dimensions
- [x] Middle slot is pixel-stable (absolute centered)
- [x] Auto idle-exit of companion 6 s after last client disconnects
- [x] GitHub Actions auto-publish on `v*` tag push
- [x] Default-on with persisted user preference (v0.1.1)
- [x] Settings menu via `ctx.ui.custom()` + pi-tui `SettingsList` (v0.2.0)
- [x] Size presets — `small`/`medium`/`large`/`xlarge` via `--scale` CSS var (v0.2.0)
- [x] Screen preference — `primary`/`active`/numeric index (v0.2.0)
- [x] Notch mode preference — `auto`/`normal`/`notch` (replaces `/island2`) (v0.2.0)
- [x] Project name overlap fix (issue #4) — source-side truncation + CSS ellipsis (v0.2.0)
- [x] Quick-action subcommands: `/island size|screen|notch|on|off|toggle` (v0.2.0)
- [x] Per-row `rowScale` demo hook for "all presets stacked" showcase (v0.2.0)
- [x] Ghost-row fix: explicit dispatch + per-socket id tracking + status whitelist (v0.2.1)
- [x] Auto-heal via version handshake — silent recovery after `npm update` (v0.2.1)
- [x] `/island reload` subcommand for manual state reset (v0.2.1)
- [x] One-time welcome notify on version change (v0.2.1)

---

## 9. Release process

> **Day-to-day dev/release workflow lives in [`docs/RELEASING.md`](docs/RELEASING.md).**
> It documents the three loops (`dev:link` → `pack:test` → `release:*`)
> and is the single source of truth once the project has been published.
>
> The subsections below (§9.1 – §9.7) describe the **one-off v0.1.0
> initial publish setup** (`NPM_TOKEN`, GitHub Actions workflow, first
> tarball). They are kept for historical reference. Don't follow them
> for routine releases — use `docs/RELEASING.md`.

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

Three loops, ranked by inner-loop speed. Full walkthrough in
[`docs/RELEASING.md`](docs/RELEASING.md).

### 10.1. Fastest — demo only
```bash
node pi-extension/demo.mjs           # stacked demo (default)
node pi-extension/demo.mjs single    # single-row walkthrough
node pi-extension/demo.mjs overlap   # long project name + long prompt regression test
node pi-extension/demo.mjs long      # 1000s task, ticks forever (Ctrl+C)
node pi-extension/demo.mjs sizes     # all four size presets stacked
```
No pi involved. Any of those accept an optional scale argument
(`node pi-extension/demo.mjs single large`). Edit `island.html.mjs` /
`companion.mjs`, `pkill -f pi-island/pi-extension/companion.mjs`, re-run.

### 10.2. Medium — `npm link`ed pi (loop 1 in RELEASING.md)
```bash
npm run dev:link     # global pi-island → symlinks to this repo
npm run dev:status   # confirm LINKED vs NPM mode before a release
```
`index.ts` edits go live via pi's `/reload`. Swift + companion changes
still need `pkill` + next invocation so the daemon respawns.

### 10.3. Pre-publish — real tarball (loop 2)
```bash
npm run pack:test    # unlinks dev symlink, runs npm pack, installs tarball
```
Now `pi` runs the exact bits npm will ship. Test every menu row, scale,
screen, notch mode, and the demo scripts here before publishing.

### 10.4. Release (loop 3)
```bash
npm run release:patch   # bug fixes
npm run release:minor   # new features (pre-1.0 may include breaking)
npm run release:major   # breaking changes, post-1.0
```
Then `npm run dev:link` again to resume development.

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
- Keep `AGENT.md` §6.8 (sizing table) in sync with any constant change.
- When adding a **new socket message type**, update FOUR places:
  1. Explicit dispatch in `companion.mjs` `rl.on("line")`. The default
     branch is "ignore" now — a missing handler means your message is
     silently dropped.
  2. Protocol doc in §5 of this file.
  3. Client-side writer in `index.ts` (usually a new `writeMessage`
     call or helper).
  4. If the new type is supposed to survive companion mismatch, bump
     the handshake expectation so older companions trigger auto-heal.
- When adding a **size preset**, update THREE places:
  1. `SCALES` string array in `index.ts` (menu + subcommand validation).
  2. `SCALES` number map in `island.html.mjs` (actual CSS scale).
  3. §6.7 sizing table in this file.
- When adding a **new preference field**, update FOUR places:
  1. `Preference` type + `readPreference()` + `writePreference()` in `index.ts`.
  2. `persistPref()` / helpers that call `writePreference`.
  3. Settings menu row in `openSettingsMenu()` if user-configurable.
  4. §5 pref schema in this file.
- Turkish user comms are fine; code / commits / docs stay English.
- **No emojis anywhere.** Not in code, comments, commit messages,
  release notes, docs, or UI strings. This includes decorative
  checkmarks (use `- [x]`), status indicators (use words like
  `OK` / `FAIL` / `RESOLVED`), tables, and README badges. Rationale:
  consistency with the pi/pi-mono project style, noise reduction for
  terminal rendering, and easier grep/diff. If a future agent adds
  emojis, strip them before committing.

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

- **Screen / notch change requires a respawn** — NSWindow geometry is
  fixed at spawn. `doSetScreen` / `doSetNotchMode` send `{type:"respawn"}`
  and the client's next `ensureConnection()` starts a fresh companion.
  The ~300 ms gap is visible as a brief capsule disappearance.
- ~~**Single socket carries multiple session IDs**~~ **RESOLVED in
  v0.2.1.** The companion now tracks every distinct id seen on a given
  socket (`socketIds: WeakMap<Socket, Set<string>>`) and removes all
  of them on `sock.on("close")`. Previously only the last id was
  cleaned up, which could leak ghost rows when a client multiplexed
  sessions or crashed mid-stream.
- **Resizing not supported** — `NSWindow` after spawn cannot change
  size. Size preset changes flip a CSS var live (no respawn needed)
  because `WIN_W`/`WIN_H` are reserved big enough for `xlarge`. A
  future `xxlarge` would need a `{type:"resize"}` handler in
  `island-host.swift` or a `WIN_W` bump.
- **Peer dependencies are `"*"`** — `@mariozechner/pi-coding-agent`
  and `@mariozechner/pi-tui` are both pinned to any version. If either
  API changes, install may succeed but the extension crashes on load.
  Pin when pi reaches 1.0.
- **No uninstall cleanup hook** — `npm uninstall` / `pi uninstall`
  leaves `~/.pi/pi-island.sock` and `~/.pi/pi-island.json` if the
  companion was killed mid-run. Harmless on next run (sock auto-
  unlinks, pref file is idempotent).

---

## 15. Future improvement backlog

Not planned yet but worth tracking:

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
