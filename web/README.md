# pi-island · web

Informational site for [`pi-island`](../README.md).
Next.js 16 + Tailwind v4, using the [pi.dev](https://pi.dev) color palette.

## Local dev

```bash
cd web
npm install
npm run dev          # http://localhost:3000
```

## Build

```bash
npm run build
npm start
```

## Deploy to Vercel

Import the repo on [vercel.com/new](https://vercel.com/new) and set:

- **Root Directory** → `web`
- **Framework preset** → Next.js (auto-detected)
- **Build Command** → `npm run build` (default)
- **Output Directory** → `.next` (default)

That's it. No `vercel.json` needed — the extension package at the repo root is
ignored because the build only runs inside `web/`.

## Structure

```
web/
├── app/
│   ├── layout.tsx       # fonts, metadata
│   ├── page.tsx         # single-page site
│   └── globals.css      # pi.dev palette as CSS vars + Tailwind theme
├── components/
│   ├── Sidebar.tsx      # sticky left nav (desktop)
│   ├── CopyCommand.tsx  # click-to-copy install line
│   └── DemoVideo.tsx    # macOS-chrome framed demo
└── public/
    └── demo.mov         # synced from ../assets/demo.mov
```

## Palette

Lifted directly from [pi.dev/style.css](https://pi.dev/style.css). See the
`:root` block in `app/globals.css`.

| Token        | Value                 | Use                      |
| ------------ | --------------------- | ------------------------ |
| `--accent`   | `#f97316`             | links, underlines, brand |
| `--background` | `#fff`              | page surface             |
| `--foreground` | `oklch(0.145 0 0)`  | body text                |
| `--foreground-dim` | `#777`          | secondary text           |
| `--terminal-bg` | `#18181b`          | code blocks              |
| `--link`     | `#0066cc`             | inline links             |
