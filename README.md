# pi-island

A macOS Dynamic-Island-style status capsule for the
[pi coding agent](https://github.com/badlogic/pi-mono).
Pinned at the top of your screen, live on every turn.

<video src="https://github.com/phun333/pi-island/raw/main/assets/demo.mov" controls muted autoplay playsinline width="640"></video>

---

## Install

Requires **macOS** + **pi** + Xcode Command Line Tools
(`xcode-select --install`).

```bash
pi install npm:pi-island
```

## Use

Inside any pi session:

```
/island     toggle the capsule on/off
/island2    notch-wrap variant (for MacBooks with a notch)
```

Run pi in multiple terminals — each session gets its own row,
stacked into one continuous capsule.


## License

MIT — see [LICENSE](LICENSE).
Architecture notes & contributor docs live in [AGENT.md](AGENT.md).
