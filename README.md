# pi-island

A macOS Dynamic-Island-style status capsule for the
[pi coding agent](https://github.com/badlogic/pi-mono).
Pinned at the top of your screen, live on every turn.

<video src="https://github.com/user-attachments/assets/db5cd9a6-d949-4094-800e-e7aa36c143a3" controls muted autoplay playsinline width="640"></video>

---

## Install

Requires **macOS** + **pi** + Xcode Command Line Tools
(`xcode-select --install`).

```bash
pi install npm:pi-island
```

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
| Notch wrap    | `auto` / `normal` / `notch`         | `auto` detects. Forcing off/on also supported. |

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
/island reset         # or: clear   — evict phantom rows, keep the companion alive
/island reload        # or: restart — respawn the companion (heavier reset)
```

Run pi in multiple terminals — each session gets its own row,
stacked into one continuous capsule.

### Stuck rows?

If a pi terminal is force-quit (SIGKILL, crash, lost SSH, …) its row
can stay "Working" forever because the cleanup message never shipped.

- `/island reset`  → wipes every row; surviving sessions re-draw
  themselves on the next event.
- `/island reload` → fully respawns the companion daemon
  (also recovers from window-level quirks after display changes).

Both commands are also safe to run at any time as a quick refresh.

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
