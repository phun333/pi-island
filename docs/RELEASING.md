# Releasing pi-island

This document is the single source of truth for the dev / release cycle.
If you remember nothing else, remember the **three loops**:

| Loop              | Question                         | Command               |
| ----------------- | -------------------------------- | --------------------- |
| 1. Inner (fast)   | Does my code work?               | `npm run dev:link`    |
| 2. Pre-publish    | Is the *package* correct?        | `npm run pack:test`   |
| 3. Release        | Ship to users.                   | `npm run release:patch` |

You should always know which loop you're in. Check with:

```bash
npm run dev:status
```

It prints either `✓ LINKED → <repo>` (loop 1) or `● NPM → <global>` (loops 2/3).

---

## One-time setup

Clone the repo, then:

```bash
cd pi-island
npm install
npm run dev:link       # symlinks the global pi-island → this repo
```

Now `pi` runs the code from this working tree. Every `edit` is live —
no copy, no reinstall, no restart of the `pi` CLI itself (the companion
daemon does need to respawn, which happens automatically when the
socket reopens).

---

## Loop 1 — daily development

```bash
git checkout -b fix/<short-name>
# …edit files…
# …test with real pi commands; changes are live because of the link…
git commit -am "fix: <what>"
git push -u origin HEAD
gh pr create --fill
```

Merge the PR when green. **Do not** bump the version or publish yet —
that's loop 3.

---

## Loop 2 — pre-publish smoke test

Before every release, run:

```bash
git checkout main && git pull
npm run pack:test
```

This:

1. Unlinks the dev symlink.
2. Runs `npm pack`, producing `pi-island-<version>.tgz` (exactly what
   `npm publish` would upload — respects the `files` array in
   `package.json`).
3. Installs that tarball globally.

Now `pi` is running the **future npm package**. Test the real flows:

```bash
pi /island                             # settings menu opens, 4 rows cycle cleanly
pi /island size large                  # quick-action applies live
node pi-extension/demo.mjs sizes       # all four presets stacked visually
node pi-extension/demo.mjs long        # long-running task, timer ticks
```

Also spot-check:

- Every row in the menu cycles its values on Enter/Space.
- Screen change respawns the companion and the capsule reappears on the
  picked display.
- Notch wrap `auto` / `normal` / `notch` respawns and re-detects.
- Pref file `~/.pi/pi-island.json` now contains all four fields.

If something is broken here that wasn't broken in loop 1, it's almost
always one of:

- A file you edited isn't in the `"files"` array in `package.json`.
- `scripts/postinstall.mjs` crashed on a clean install.
- A path that worked because of the symlink is actually wrong in a
  normal install layout.
- A new peer dependency is missing from `package.json`’s `peerDependencies`.

Fix, commit, merge, re-run `npm run pack:test`.

---

## Loop 3 — releasing

When `pack:test` is green, release with one command:

```bash
npm run release:patch      # 0.1.2 → 0.1.3   (bug fixes)
npm run release:minor      # 0.1.2 → 0.2.0   (new features — pre-1.0 may also include minor breaking changes)
npm run release:major      # 0.1.2 → 1.0.0   (breaking changes post-1.0)
```

Before 1.0 the project follows the looser pre-1.0 semver convention:
breaking changes are allowed in minor bumps, but still call them out
prominently in the release notes (`gh release create --notes`).
Command/flag removals go under a "Breaking" heading.

Each of these:

1. Bumps `package.json` version.
2. Creates a commit `chore: release v<version>`.
3. Creates a git tag `v<version>`.
4. Pushes commits **and** tags (`git push --follow-tags`).
5. Runs `npm publish`.

After it finishes, optionally create a GitHub release with notes:

```bash
gh release create v<version> --generate-notes
```

Then go back to dev mode:

```bash
npm run dev:link
```

---

## Safety / sanity rules

- **End every dev session linked or explicitly unlinked — never in an
  ambiguous state.** `npm run dev:status` makes this trivial.
- **Never publish from a dirty working tree.** `npm version` refuses
  by default; don't bypass it.
- **Never edit the global install directly** (`/opt/homebrew/lib/node_modules/pi-island/…`).
  It's a symlink in dev mode and gets overwritten on every `npm update`
  in prod mode. Edits go into this repo, full stop.
- **Tarballs (`pi-island-*.tgz`) are gitignored.** Don't commit them.
- **Pre-release channels:** for risky changes, publish to `next` first:
  ```bash
  npm publish --tag next
  # test: npm i -g pi-island@next
  # promote: npm dist-tag add pi-island@<version> latest
  ```
  `release:*` scripts don't do this automatically — run it manually when
  you need it.
