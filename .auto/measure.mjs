#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ROOT = process.cwd();
const INDEX = join(ROOT, "pi-extension", "index.ts");
const JITI = "/Users/emre/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

function buildProbeModule() {
  let code = readFileSync(INDEX, "utf8");
  code = code.replace(/import type[^;]+;\n/g, "");
  code = code.replace(
    /import \{ DynamicBorder, getSettingsListTheme \} from "@mariozechner\/pi-coding-agent";\n/,
    "class DynamicBorder { constructor(...args:any[]){} }\nconst getSettingsListTheme = () => ({});\n",
  );
  code = code.replace(
    /import \{ Container, SettingsList, type SettingItem \} from "@mariozechner\/pi-tui";\n/,
    "class Container { addChild(...args:any[]){} invalidate(){} render(){return [];} }\nclass SettingsList { constructor(...args:any[]){} updateValue(...args:any[]){} handleInput(...args:any[]){} }\ntype SettingItem = any;\n",
  );
  code = code.replace(
    /import \{ SOCK \} from "\.\/socket-path\.mjs";\n/,
    "const SOCK = \"/tmp/pi-island-autoresearch.sock\";\n",
  );
  const exports = ["normalizePromptImages", "extractPromptImagePaths", "normalizePrompt"];
  if (/function\s+normalizePromptForDisplay\s*\(/.test(code)) exports.push("normalizePromptForDisplay");
  code += `\nexport { ${exports.join(", ")} };\n`;
  const dir = mkdtempSync(join(tmpdir(), "pi-island-probe-"));
  const file = join(dir, "index-probe.ts");
  writeFileSync(file, code);
  return file;
}

const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const tinyPng = Buffer.from(tinyPngBase64, "base64");
const imgDir = mkdtempSync(join(tmpdir(), "pi-island-images-"));
const plainPath = join(imgDir, "clipboard-2026-06-12-114401-8AB7154E.png");
const spacedPath = join(imgDir, "Screen Shot 2026-06-12 at 11.44.01.png");
const extensionlessPath = join(imgDir, "clipboard-image-without-extension");
writeFileSync(plainPath, tinyPng);
writeFileSync(spacedPath, tinyPng);
writeFileSync(extensionlessPath, tinyPng);

let failures = 0;
let tests = 0;
function check(name, ok, details = "") {
  tests++;
  if (ok) {
    console.log(`TEST PASS ${name}`);
  } else {
    failures++;
    console.log(`TEST FAIL ${name}${details ? ` :: ${details}` : ""}`);
  }
}

try {
  const { createJiti } = await import(JITI);
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, interopDefault: true });
  const mod = await jiti.import(buildProbeModule());

  const direct = mod.normalizePromptImages([{ type: "image", data: tinyPngBase64, mimeType: "image/png" }], "describe this");
  check("direct ImageContent attachment renders", direct.count === 1 && direct.images.length === 1 && direct.images[0]?.mimeType === "image/png");

  const plain = mod.normalizePromptImages(undefined, `please inspect ${plainPath} thanks`);
  check("plain local image path renders", plain.count === 1 && plain.images.length === 1 && plain.images[0]?.data);

  const quotedSpaced = mod.normalizePromptImages(undefined, `please inspect "${spacedPath}" thanks`);
  check("quoted image path with spaces renders", quotedSpaced.count === 1 && quotedSpaced.images.length === 1);

  const slashWithSpaced = `/skill:autoresearch-create inspect attached screenshot ${spacedPath} bu sekilde olmamali`;
  const slashSpaced = mod.normalizePromptImages(undefined, slashWithSpaced);
  check(
    "slash/skill prompt with unquoted spaced image path renders",
    slashSpaced.count === 1 && slashSpaced.images.length === 1,
    `count=${slashSpaced.count} images=${slashSpaced.images.length}`,
  );

  const extensionless = mod.normalizePromptImages(undefined, `clipboard file ${extensionlessPath} should sniff as png`);
  check("extensionless clipboard image path is sniffed", extensionless.count === 1 && extensionless.images.length === 1);

  const extracted = mod.extractPromptImagePaths(`/skill:autoresearch-create ${plainPath} devam`);
  check(
    "path extractor ignores slash-command prefix and returns real path only",
    extracted.length === 1 && extracted[0] === plainPath,
    JSON.stringify(extracted),
  );

  const displayFn = mod.normalizePromptForDisplay;
  check("display prompt sanitizer is present", typeof displayFn === "function");
  if (typeof displayFn === "function") {
    const raw = `/skill:autoresearch-create resim attachlenirse prompta gozukmuyor ${plainPath} bu sekilde oluyor`;
    const display = displayFn(raw);
    check(
      "display prompt hides local image path text but keeps surrounding words",
      !display.includes(plainPath) && !display.includes(basename(plainPath)) && display.includes("resim attachlenirse") && display.includes("bu sekilde oluyor"),
      display,
    );
  } else {
    check("display prompt hides local image path text but keeps surrounding words", false, "normalizePromptForDisplay missing");
  }
} catch (err) {
  failures++;
  console.log("TEST FAIL harness exception :: " + (err?.stack || err));
}

console.log(`METRIC failures=${failures}`);
console.log(`METRIC tests=${tests}`);
