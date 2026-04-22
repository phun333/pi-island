#!/usr/bin/env node
// Pre-publish smoke test.
//
//   npm run pack:test
//
// Simulates what `npm publish` would actually ship:
//   1. Temporarily unlinks any `npm link`ed dev copy.
//   2. Runs `npm pack` to produce pi-island-<version>.tgz in this repo.
//   3. Installs THAT tarball globally — so `pi` now runs the exact bits
//      that would land on npm.
//   4. Prints next steps.
//
// After you've verified everything works, either:
//   - publish for real:   npm run release:patch   (or :minor / :major)
//   - go back to dev:     npm run dev:link

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const HERE = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(HERE, "package.json"), "utf8"));
const tgz = `${pkg.name}-${pkg.version}.tgz`;

function run(cmd, { ignoreFail = false } = {}) {
  console.log(`\n$ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: HERE });
  } catch (e) {
    if (!ignoreFail) throw e;
  }
}

// 1. Clear any existing link so the tarball install is authoritative.
run("npm unlink -g pi-island", { ignoreFail: true });

// 2. Clean up old tarballs in the repo root.
for (const f of readdirSync(HERE)) {
  if (f.startsWith(`${pkg.name}-`) && f.endsWith(".tgz")) {
    unlinkSync(resolve(HERE, f));
  }
}

// 3. Produce the tarball (this is what `npm publish` would upload).
run("npm pack");

if (!existsSync(resolve(HERE, tgz))) {
  console.error(`\n✗ expected ${tgz} but it was not produced`);
  process.exit(1);
}

// 4. Install it globally.
run(`npm i -g ./${tgz}`);

console.log(`
✓ installed ${tgz} globally

Now test with a real pi session. For example:
  pi /island
  node pi-extension/demo.mjs

When done:
  npm run release:patch   # bump, push, publish
  npm run dev:link        # go back to live-edit mode
`);
