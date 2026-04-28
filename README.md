<div align="center">

# pi-island

**A Dynamic-Island-style status capsule for the [pi coding agent](https://github.com/badlogic/pi-mono).**
Native, pinned to the top of your screen, live on every turn.

[![npm version](https://img.shields.io/npm/v/pi-island?style=flat-square&color=333&label=npm)](https://www.npmjs.com/package/pi-island)
[![npm downloads](https://img.shields.io/npm/dw/pi-island?style=flat-square&color=33&label=downloads)](https://www.npmjs.com/package/pi-island)
[![License: MIT](https://img.shields.io/npm/l/pi-island?style=flat-square&color=333)](LICENSE)
[![Node ≥ 18](https://img.shields.io/node/v/pi-island?style=flat-square&color=333)](package.json)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-333?style=flat-square)](#platform-support)
[![CI](https://img.shields.io/github/actions/workflow/status/phun333/pi-island/publish.yml?style=flat-square&color=333&label=ci)](https://github.com/phun333/pi-island/actions/workflows/publish.yml)
[![GitHub stars](https://img.shields.io/github/stars/phun333/pi-island?style=flat-square&color=333)](https://github.com/phun333/pi-island/stargazers)

[Website](https://pi-island.vercel.app) · [Install](#install) · [Settings](#settings) · [How it works](#how-it-works) · [Troubleshooting](#troubleshooting)

</div>

---

<div align="center">

<video src="https://github.com/user-attachments/assets/db5cd9a6-d949-4094-800e-e7aa36c143a3" controls muted autoplay playsinline width="720"></video>

</div>

> On **macOS** the capsule wraps the MacBook notch natively.
> On **Windows** it pins to the top-center of the active display.
> Always above every Space, full-screen app, and virtual desktop.

---

## Highlights

- **Native rendering on every platform.** WKWebView (Swift) on macOS, WebView2 (C#) on Windows — no Electron, no shipped Chromium, no taskbar entry.
- **Notch-aware.** On MacBooks with a notch the capsule splits to wrap around it. On other displays it falls back to a single rounded pill.
- **One row per pi session.** Run pi in five terminals, get five stacked rows in a single capsule.
- **Click-through, frameless, always-on-top.** Never steals focus, never blocks what's behind it.
- **Live config.** Type `/island` in any pi session to change size, screen, or notch behavior without restarting.
- **Zero runtime dependencies.** The npm package has `"dependencies": {}`. The native host is the only binary.
- **Compile on install.** Postinstall builds the host for your platform; missing toolchain is a soft-fail, never a crash.

## Platform support

| OS      | Host                                  | Toolchain                                     | Notch wrap |
|---------|---------------------------------------|-----------------------------------------------|------------|
| macOS   | Swift + WKWebView                     | Xcode Command Line Tools (`swiftc`)           | Yes        |
| Windows | C# + WinForms + WebView2              | .NET 8 SDK (`dotnet`)                         | N/A        |
| Linux   | _Tracked in [#6](https://github.com/phun333/pi-island/issues/6)_ | —                | —          |

## Install

```bash
pi install npm:pi-island
```

That's it. The island turns on automatically for every pi session after install. Type `/island` any time to tweak it.

### Toolchain requirements

The postinstall step compiles the native host for your platform.

<details>
<summary><strong>macOS</strong> — Xcode Command Line Tools</summary>

```bash
xcode-select --install
```
</details>

<details>
<summary><strong>Windows</strong> — .NET 8 SDK</summary>

```powershell
winget install Microsoft.DotNet.SDK.8
```
</details>

If the required toolchain is missing, install still succeeds — the extension simply no-ops and writes a `.build-skipped` marker. Once you install the toolchain, run:

```bash
npm run build
```

…to compile the host without reinstalling the package.

## Settings

Inside any pi session, open the settings panel:

```
/island
```

A drop-down opens with four rows. Cycle any row's value with **Enter** or **Space**.

| Setting     | Values                                       | Notes                                                                                          |
|-------------|----------------------------------------------|------------------------------------------------------------------------------------------------|
| Visibility  | `enabled` &middot; `disabled`                | Remembered across restarts.                                                                    |
| Size        | `small` &middot; `medium` &middot; `large` &middot; `xlarge` | Live — no respawn.                                                                  |
| Screen      | `primary` &middot; `active` &middot; `2` &middot; `3` … | `primary` = menu-bar display, `active` = under the mouse, numbers for multi-monitor.    |
| Notch wrap  | `auto` &middot; `normal` &middot; `notch`    | macOS only. `auto` detects automatically; you can also force on/off. Inert on Windows.         |

Choices persist in `~/.pi/pi-island.json` and survive every pi restart.

### Quick actions (skip the menu)

For muscle memory and scripts:

```bash
/island on            # alias: enable
/island off           # alias: disable
/island toggle
/island size large
/island screen primary
/island notch notch
/island reload        # reset companion state (emergency eject)
```

Run pi in multiple terminals — each session gets its own row, stacked into one continuous capsule sized to the longest row.

## How it works

```
┌─────────────────────────────────────────────────────────────────────┐
│  pi session  ──►  pi-extension/index.ts                              │
│                       │                                              │
│                       │  per-turn status                             │
│                       ▼                                              │
│                   companion.mjs   ──►   Unix socket / Named pipe     │
│                                                  │                   │
│                                                  ▼                   │
│                                         native host (per OS)         │
│                                         ┌──────────────────┐         │
│                                         │ macOS:  Swift +  │         │
│                                         │         WKWebView│         │
│                                         │ Win:    C#    +  │         │
│                                         │         WebView2 │         │
│                                         └──────────────────┘         │
│                                                  │                   │
│                                                  ▼                   │
│                                         status capsule (HTML/CSS)    │
│                                         pinned, frameless, always   │
│                                         on top, click-through       │
└─────────────────────────────────────────────────────────────────────┘
```

1. **The pi extension** (`pi-extension/index.ts`) hooks every turn and pushes a JSON status frame.
2. **A long-lived companion** (`pi-extension/companion.mjs`) owns the IPC channel — Unix domain socket on macOS, named pipe on Windows.
3. **A native host** renders the capsule from raw HTML/CSS, pinned above every window, click-through and borderless.
4. **Multi-session stacking** is handled by the companion: every session adds a row; rows fold into a single visual capsule.
5. **Notch detection** uses `safeAreaInsets.top` on macOS. On notch-equipped MacBooks the capsule splits around the cutout; otherwise it stays as a single pill.

For a deeper architecture write-up, see [`AGENT.md`](AGENT.md).

## Troubleshooting

### Empty or frozen rows stuck in the capsule

After upgrading while pi was running you may see rows with no project name and a spinner that never advances. Reset the companion:

```bash
# Inside any pi session:
/island reload

# Or from a normal shell:
pkill -f pi-island/pi-extension/companion.mjs       # macOS / Linux
taskkill /F /IM "island-host-win.exe"                # Windows
```

pi-island 0.2.1+ auto-detects and heals a version mismatch on the next `/island` use, so upgrades from 0.2.1 onward should be silent.

### "swiftc not found" or ".NET 8 SDK not found"

Install the toolchain (see [Install](#install)) and run:

```bash
npm run build
```

### Capsule does not appear

Verify the host binary built:

```bash
# macOS
ls $(npm root -g)/pi-island/pi-extension/island-host-bin

# Windows
dir "%APPDATA%\npm\node_modules\pi-island\pi-extension\hosts\windows"
```

If missing, run `npm run build` from the package directory.

## Configuration file

Settings live at `~/.pi/pi-island.json`:

```json
{
  "enabled": true,
  "size": "medium",
  "screen": "primary",
  "notchWrap": "auto"
}
```

Edit it directly if you prefer — companion picks up changes on the next status frame.

## Project layout

```
pi-island/
├── pi-extension/        Extension entry, companion, platform abstraction
│   ├── index.ts         Hooks pi turns, streams status frames
│   ├── companion.mjs    Long-lived IPC + host process owner
│   └── platform.mjs     OS-specific screen, geometry, notch logic
├── hosts/
│   ├── macos/           Swift + WKWebView source
│   └── windows/         C# + WinForms + WebView2 source
├── scripts/
│   ├── build.mjs        Per-platform build dispatcher
│   ├── postinstall.mjs  Compile-on-install with graceful fallback
│   └── pack-test.mjs    Pre-publish smoke test
├── docs/RELEASING.md    Three-loop dev/release workflow
├── web/                 Next.js 16 informational site (pi-island.vercel.app)
└── AGENT.md             Architecture notes & contributor docs
```

## Development

The dev/release workflow is documented in [`docs/RELEASING.md`](docs/RELEASING.md). Highlights:

- `npm run dev:link` — symlink the global `pi-island` to this repo for live edits
- `npm run pack:test` — produce the exact tarball `npm publish` would upload, install it globally, and run real pi flows against it
- `npm run release:patch` / `:minor` / `:major` — bump, commit, tag, push (CI publishes to npm)
- `npm run release:beta` — bump to a `-beta.N` pre-release; CI routes it to the `beta` npm dist-tag

Architecture notes for contributors live in [`AGENT.md`](AGENT.md).

## Roadmap

- [x] macOS host (Swift + WKWebView)
- [x] Windows host (C# + WinForms + WebView2)
- [ ] Linux host — [#6](https://github.com/phun333/pi-island/issues/6)
- [ ] Custom themes / per-row color
- [ ] Optional click-through toggle (interactive mode)

## Contributing

Issues and PRs welcome. Before submitting a PR:

1. Read [`AGENT.md`](AGENT.md) for architecture conventions.
2. Read [`docs/RELEASING.md`](docs/RELEASING.md) — dev mode is `npm run dev:link`.
3. Keep PR scope tight; pre-1.0 we accept breaking changes in `minor` bumps but document them in the release notes.

## License

[MIT](LICENSE) © [phun333](https://github.com/phun333)

Built on top of [pi](https://pi.dev), the open-source coding agent by [badlogic](https://github.com/badlogic/pi-mono).
