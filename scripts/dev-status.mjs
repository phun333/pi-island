#!/usr/bin/env node
// Print whether `pi` is currently using the LINKED repo or the NPM install.
//
//   npm run dev:status
//
// Useful sanity check before releasing — you don't want to think you're
// testing the published tarball when you're actually testing a symlink.

import { execSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = resolve(new URL("..", import.meta.url).pathname);

let globalRoot;
try {
  globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
} catch {
  console.log("✗ could not run `npm root -g`");
  process.exit(1);
}

const installed = join(globalRoot, "pi-island");
if (!existsSync(installed)) {
  console.log("· pi-island not installed globally");
  console.log("  run: npm i -g pi-island   (or)   npm run dev:link");
  process.exit(0);
}

const real = realpathSync(installed);
const version = (() => {
  try { return JSON.parse(execSync(`cat ${JSON.stringify(join(real, "package.json"))}`, { encoding: "utf8" })).version; }
  catch { return "?"; }
})();

if (real === HERE) {
  console.log(`✓ LINKED   → ${real}`);
  console.log(`  version ${version} (live edits from this repo)`);
} else {
  console.log(`● NPM      → ${real}`);
  console.log(`  version ${version} (published tarball)`);
}
