# pi-island

A Dynamic-Island-style status capsule for the
[pi coding agent](https://github.com/badlogic/pi-mono).
Pinned at the top of your screen on **macOS** and **Windows**,
live on every turn.

> On macOS the capsule wraps the MacBook notch natively. On Windows
> it pins to the top-center of the active display.

<video src="https://github.com/user-attachments/assets/db5cd9a6-d949-4094-800e-e7aa36c143a3" controls muted autoplay playsinline width="640"></video>

---

## Install

Supported on **macOS** and **Windows**. You need **pi** plus the
toolchain for your platform:

- **macOS** — Xcode Command Line Tools (`xcode-select --install`)
- **Windows** — .NET 8 SDK (`winget install Microsoft.DotNet.SDK.8`)

Then:

```bash
pi install npm:pi-island
```

The postinstall step compiles the native host for your platform
(Swift on macOS, C# / WebView2 on Windows). If the required toolchain
is missing, the install still succeeds — the extension just no-ops
until you install it and run `npm run build`.

The island turns on automatically for every pi session after install.
Type `/island` any time to tweak it.

## Settings

Inside any pi session, type:

```
/island
```

A drop-down opens with four rows. Cycle each value with Enter or Space:

| Setting       | Values                              | Notes                                          |
|---------------|-------------------------------------|------------------------------------------------|
| Visibility    | `enabled` / `disabled`              | Remember the choice across restarts.           |
| Size          | `small` / `medium` / `large` / `xlarge` | Live — no respawn.                         |
| Screen        | `primary` / `active` / `2` / `3` …  | `primary` = menu-bar display, `active` = under mouse, numbers for multi-monitor. |
| Notch wrap    | `auto` / `normal` / `notch`         | macOS only. `auto` detects; forcing off/on also supported. On Windows this row is inert. |

Your choices are persisted in `~/.pi/pi-island.json` and survive
every pi restart.

### Quick-actions (skip the menu)

Muscle memory / scripts:

```
/island on            # or: enable
/island off           # or: disable
/island toggle
/island size large
/island screen primary
/island notch notch
/island reload        # reset companion state (emergency eject)
```

Run pi in multiple terminals — each session gets its own row,
stacked into one continuous capsule.

## Troubleshooting

### Empty / frozen rows stuck in the capsule

If you see rows with no project name and a spinner that never
advances (typically after upgrading pi-island while pi was running),
reset the companion in one of two ways:

1. Inside pi: `/island reload` — nukes state in place.
2. Outside pi:
   ```bash
   pkill -f pi-island/pi-extension/companion.mjs
   ```

Either one is a one-shot cleanup. pi-island 0.2.1+ auto-detects and
heals a version mismatch on the next `/island` use, so upgrading
from 0.2.1 onward should be silent.

## Website

A minimal informational site lives in [`web/`](web/) — built with Next.js 16
and the [pi.dev](https://pi.dev) palette, deployable to Vercel with
`Root Directory = web`. See [`web/README.md`](web/README.md).

## Development

Dev/release workflow (link, pack-test, publish) is documented in
[`docs/RELEASING.md`](docs/RELEASING.md).

## License

MIT — see [LICENSE](LICENSE).
Architecture notes & contributor docs live in [AGENT.md](AGENT.md).
