#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

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
const parenPath = join(imgDir, "Screen Shot (1).png");
const srcsetAltPath = join(imgDir, "srcset-large.png");
const relDir = mkdtempSync(join(ROOT, ".auto", "tmp-rel-images-"));
const cwdRelativePath = `./${relative(ROOT, join(relDir, "relative Screen Shot.png"))}`;
process.on("exit", () => {
  try { rmSync(relDir, { recursive: true, force: true }); } catch {}
});
writeFileSync(plainPath, tinyPng);
writeFileSync(spacedPath, tinyPng);
writeFileSync(extensionlessPath, tinyPng);
writeFileSync(parenPath, tinyPng);
writeFileSync(srcsetAltPath, tinyPng);
writeFileSync(join(ROOT, cwdRelativePath), tinyPng);

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

    const fileUrl = pathToFileURL(spacedPath).href;
    const fileUrlImages = mod.normalizePromptImages(undefined, `attached via url ${fileUrl} should render`);
    const fileUrlDisplay = displayFn(`attached via url ${fileUrl} should render`);
    check(
      "file:// image URL with escaped spaces renders and is hidden from display prompt",
      fileUrlImages.count === 1 && fileUrlImages.images.length === 1 && !fileUrlDisplay.includes(fileUrl) && !fileUrlDisplay.includes("Screen%20Shot"),
      `count=${fileUrlImages.count} images=${fileUrlImages.images.length} display=${fileUrlDisplay}`,
    );

    const shellEscapedPath = spacedPath.replace(/ /g, "\\\\ ");
    const shellEscapedImages = mod.normalizePromptImages(undefined, `shell pasted ${shellEscapedPath} should render`);
    const shellEscapedDisplay = displayFn(`shell pasted ${shellEscapedPath} should render`);
    check(
      "shell-escaped image path with spaces renders and is hidden from display prompt",
      shellEscapedImages.count === 1 && shellEscapedImages.images.length === 1 && !shellEscapedDisplay.includes(shellEscapedPath) && !shellEscapedDisplay.includes(basename(spacedPath)),
      `count=${shellEscapedImages.count} images=${shellEscapedImages.images.length} display=${shellEscapedDisplay}`,
    );

    const duplicatePathVariantsPrompt = `compare ${spacedPath} and ${shellEscapedPath}`;
    const duplicatePathVariantsImages = mod.normalizePromptImages(undefined, duplicatePathVariantsPrompt);
    const duplicatePathVariantsDisplay = displayFn(duplicatePathVariantsPrompt);
    check(
      "duplicate raw path variants to same image clean every occurrence without duplicate thumbnails",
      duplicatePathVariantsImages.count === 1 && duplicatePathVariantsImages.images.length === 1 && !duplicatePathVariantsDisplay.includes(spacedPath) && !duplicatePathVariantsDisplay.includes(shellEscapedPath) && !duplicatePathVariantsDisplay.includes(basename(spacedPath)),
      `count=${duplicatePathVariantsImages.count} images=${duplicatePathVariantsImages.images.length} display=${duplicatePathVariantsDisplay}`,
    );

    const relativePlainPath = relative(ROOT, plainPath);
    const relativePathImages = mod.normalizePromptImages(undefined, `relative screenshot ${relativePlainPath} should render`);
    const relativePathDisplay = displayFn(`relative screenshot ${relativePlainPath} should render`);
    check(
      "relative local image path renders and is hidden from display prompt",
      relativePathImages.count === 1 && relativePathImages.images.length === 1 && !relativePathDisplay.includes(relativePlainPath) && !relativePathDisplay.includes(basename(plainPath)),
      `relative=${relativePlainPath} count=${relativePathImages.count} images=${relativePathImages.images.length} display=${relativePathDisplay}`,
    );

    const cwdRelativeImages = mod.normalizePromptImages(undefined, `cwd relative screenshot ${cwdRelativePath} should render`);
    const cwdRelativeDisplay = displayFn(`cwd relative screenshot ${cwdRelativePath} should render`);
    check(
      "cwd-relative ./ image path renders and is hidden from display prompt",
      cwdRelativeImages.count === 1 && cwdRelativeImages.images.length === 1 && !cwdRelativeDisplay.includes(cwdRelativePath) && !cwdRelativeDisplay.includes("relative Screen Shot.png"),
      `relative=${cwdRelativePath} count=${cwdRelativeImages.count} images=${cwdRelativeImages.images.length} display=${cwdRelativeDisplay}`,
    );

    const atAbsolutePrompt = `inspect @${plainPath} please`;
    const atAbsoluteImages = mod.normalizePromptImages(undefined, atAbsolutePrompt);
    const atAbsoluteDisplay = displayFn(atAbsolutePrompt);
    check(
      "@-prefixed absolute image path renders and hides whole token",
      atAbsoluteImages.count === 1 && atAbsoluteImages.images.length === 1 && !atAbsoluteDisplay.includes("@") && !atAbsoluteDisplay.includes(plainPath) && !atAbsoluteDisplay.includes(basename(plainPath)),
      `count=${atAbsoluteImages.count} images=${atAbsoluteImages.images.length} display=${atAbsoluteDisplay}`,
    );

    const atRelativePrompt = `inspect @${cwdRelativePath} please`;
    const atRelativeImages = mod.normalizePromptImages(undefined, atRelativePrompt);
    const atRelativeDisplay = displayFn(atRelativePrompt);
    check(
      "@-prefixed relative image path renders and hides whole token",
      atRelativeImages.count === 1 && atRelativeImages.images.length === 1 && !atRelativeDisplay.includes("@") && !atRelativeDisplay.includes(cwdRelativePath) && !atRelativeDisplay.includes("relative Screen Shot.png"),
      `count=${atRelativeImages.count} images=${atRelativeImages.images.length} display=${atRelativeDisplay}`,
    );

    const parenthesized = displayFn(`look at (${plainPath}) please`);
    check(
      "parenthesized image path is hidden cleanly from display prompt",
      !parenthesized.includes(plainPath) && !parenthesized.includes(basename(plainPath)) && !/[([{<]\s*[)\]}>]/.test(parenthesized),
      parenthesized,
    );

    const bracketed = displayFn(`look at <${plainPath}> please`);
    check(
      "angle-bracketed image path is hidden cleanly from display prompt",
      !bracketed.includes(plainPath) && !bracketed.includes(basename(plainPath)) && !/[([{<]\s*[)\]}>]/.test(bracketed),
      bracketed,
    );

    const markdownImagePrompt = `see ![bug screenshot](${plainPath}) before fixing`;
    const markdownImage = mod.normalizePromptImages(undefined, markdownImagePrompt);
    const markdownDisplay = displayFn(markdownImagePrompt);
    check(
      "markdown image syntax renders as attachment and leaves clean alt text",
      markdownImage.count === 1 && markdownImage.images.length === 1 && markdownDisplay.includes("bug screenshot") && !markdownDisplay.includes("![") && !markdownDisplay.includes("](") && !markdownDisplay.includes(plainPath) && !markdownDisplay.includes(basename(plainPath)),
      `count=${markdownImage.count} images=${markdownImage.images.length} display=${markdownDisplay}`,
    );

    const markdownAnglePrompt = `see ![space shot](<${spacedPath}>) now`;
    const markdownAngleImage = mod.normalizePromptImages(undefined, markdownAnglePrompt);
    const markdownAngleDisplay = displayFn(markdownAnglePrompt);
    check(
      "markdown image syntax with angle-wrapped spaced path renders and leaves clean alt text",
      markdownAngleImage.count === 1 && markdownAngleImage.images.length === 1 && markdownAngleDisplay.includes("space shot") && !markdownAngleDisplay.includes("![") && !markdownAngleDisplay.includes("](") && !markdownAngleDisplay.includes(basename(spacedPath)),
      `count=${markdownAngleImage.count} images=${markdownAngleImage.images.length} display=${markdownAngleDisplay}`,
    );

    const markdownParenPrompt = `see ![paren shot](${parenPath}) now`;
    const markdownParenImage = mod.normalizePromptImages(undefined, markdownParenPrompt);
    const markdownParenDisplay = displayFn(markdownParenPrompt);
    check(
      "markdown image syntax with parenthesized filename renders and leaves clean alt text",
      markdownParenImage.count === 1 && markdownParenImage.images.length === 1 && markdownParenDisplay.includes("paren shot") && !markdownParenDisplay.includes("![") && !markdownParenDisplay.includes("](") && !markdownParenDisplay.includes(basename(parenPath)),
      `count=${markdownParenImage.count} images=${markdownParenImage.images.length} display=${markdownParenDisplay}`,
    );

    const markdownLinkPrompt = `see [linked screenshot](${plainPath}) before fixing`;
    const markdownLinkImage = mod.normalizePromptImages(undefined, markdownLinkPrompt);
    const markdownLinkDisplay = displayFn(markdownLinkPrompt);
    check(
      "markdown link to local image renders as attachment and leaves clean link text",
      markdownLinkImage.count === 1 && markdownLinkImage.images.length === 1 && markdownLinkDisplay.includes("linked screenshot") && !markdownLinkDisplay.includes("[") && !markdownLinkDisplay.includes("](") && !markdownLinkDisplay.includes(plainPath) && !markdownLinkDisplay.includes(basename(plainPath)),
      `count=${markdownLinkImage.count} images=${markdownLinkImage.images.length} display=${markdownLinkDisplay}`,
    );

    const duplicateMarkdownPrompt = `compare ![before](${plainPath}) and ![after](${plainPath})`;
    const duplicateMarkdownImage = mod.normalizePromptImages(undefined, duplicateMarkdownPrompt);
    const duplicateMarkdownDisplay = displayFn(duplicateMarkdownPrompt);
    check(
      "duplicate markdown refs to same local image clean all wrappers without duplicate thumbnails",
      duplicateMarkdownImage.count === 1 && duplicateMarkdownImage.images.length === 1 && duplicateMarkdownDisplay.includes("before") && duplicateMarkdownDisplay.includes("after") && !duplicateMarkdownDisplay.includes("![") && !duplicateMarkdownDisplay.includes("](") && !duplicateMarkdownDisplay.includes(plainPath) && !duplicateMarkdownDisplay.includes(basename(plainPath)),
      `count=${duplicateMarkdownImage.count} images=${duplicateMarkdownImage.images.length} display=${duplicateMarkdownDisplay}`,
    );

    const htmlImgPrompt = `see <img src="${plainPath}" alt="bug screenshot"> before fixing`;
    const htmlImg = mod.normalizePromptImages(undefined, htmlImgPrompt);
    const htmlImgDisplay = displayFn(htmlImgPrompt);
    check(
      "html img tag local src renders and leaves clean alt text",
      htmlImg.count === 1 && htmlImg.images.length === 1 && htmlImgDisplay.includes("bug screenshot") && !htmlImgDisplay.includes("<img") && !htmlImgDisplay.includes("src=") && !htmlImgDisplay.includes(plainPath) && !htmlImgDisplay.includes(basename(plainPath)),
      `count=${htmlImg.count} images=${htmlImg.images.length} display=${htmlImgDisplay}`,
    );

    const htmlImgAltFirstPrompt = `see <img alt='space shot' src="${spacedPath}"> now`;
    const htmlImgAltFirst = mod.normalizePromptImages(undefined, htmlImgAltFirstPrompt);
    const htmlImgAltFirstDisplay = displayFn(htmlImgAltFirstPrompt);
    check(
      "html img tag with alt before src and spaced local path renders cleanly",
      htmlImgAltFirst.count === 1 && htmlImgAltFirst.images.length === 1 && htmlImgAltFirstDisplay.includes("space shot") && !htmlImgAltFirstDisplay.includes("<img") && !htmlImgAltFirstDisplay.includes("src=") && !htmlImgAltFirstDisplay.includes(basename(spacedPath)),
      `count=${htmlImgAltFirst.count} images=${htmlImgAltFirst.images.length} display=${htmlImgAltFirstDisplay}`,
    );

    const htmlImgSrcsetPrompt = `see <img srcset="${plainPath} 1x" alt="bug srcset"> before fixing`;
    const htmlImgSrcset = mod.normalizePromptImages(undefined, htmlImgSrcsetPrompt);
    const htmlImgSrcsetDisplay = displayFn(htmlImgSrcsetPrompt);
    check(
      "html img srcset local image renders and leaves clean alt text",
      htmlImgSrcset.count === 1 && htmlImgSrcset.images.length === 1 && htmlImgSrcsetDisplay.includes("bug srcset") && !htmlImgSrcsetDisplay.includes("<img") && !htmlImgSrcsetDisplay.includes("srcset=") && !htmlImgSrcsetDisplay.includes(plainPath) && !htmlImgSrcsetDisplay.includes(basename(plainPath)),
      `count=${htmlImgSrcset.count} images=${htmlImgSrcset.images.length} display=${htmlImgSrcsetDisplay}`,
    );

    const htmlImgMultiSrcsetPrompt = `see <img srcset="${plainPath} 1x, ${srcsetAltPath} 2x" alt="multi srcset"> before fixing`;
    const htmlImgMultiSrcset = mod.normalizePromptImages(undefined, htmlImgMultiSrcsetPrompt);
    const htmlImgMultiSrcsetDisplay = displayFn(htmlImgMultiSrcsetPrompt);
    check(
      "html img multi-candidate srcset counts as one semantic attachment",
      htmlImgMultiSrcset.count === 1 && htmlImgMultiSrcset.images.length === 1 && htmlImgMultiSrcsetDisplay.includes("multi srcset") && !htmlImgMultiSrcsetDisplay.includes("<img") && !htmlImgMultiSrcsetDisplay.includes("srcset=") && !htmlImgMultiSrcsetDisplay.includes(plainPath) && !htmlImgMultiSrcsetDisplay.includes(srcsetAltPath),
      `count=${htmlImgMultiSrcset.count} images=${htmlImgMultiSrcset.images.length} display=${htmlImgMultiSrcsetDisplay}`,
    );

    const htmlSourceSrcsetPrompt = `see <source srcset="${plainPath} 1x" media="(min-width: 1px)"> before fixing`;
    const htmlSourceSrcset = mod.normalizePromptImages(undefined, htmlSourceSrcsetPrompt);
    const htmlSourceSrcsetDisplay = displayFn(htmlSourceSrcsetPrompt);
    check(
      "html source srcset local image renders and removes source tag from display",
      htmlSourceSrcset.count === 1 && htmlSourceSrcset.images.length === 1 && !htmlSourceSrcsetDisplay.includes("<source") && !htmlSourceSrcsetDisplay.includes("srcset=") && !htmlSourceSrcsetDisplay.includes(plainPath) && !htmlSourceSrcsetDisplay.includes(basename(plainPath)),
      `count=${htmlSourceSrcset.count} images=${htmlSourceSrcset.images.length} display=${htmlSourceSrcsetDisplay}`,
    );

    const htmlSourceSrcPrompt = `see <source src="${plainPath}" type="image/png"> before fixing`;
    const htmlSourceSrc = mod.normalizePromptImages(undefined, htmlSourceSrcPrompt);
    const htmlSourceSrcDisplay = displayFn(htmlSourceSrcPrompt);
    check(
      "html source src local image renders and removes source tag from display",
      htmlSourceSrc.count === 1 && htmlSourceSrc.images.length === 1 && !htmlSourceSrcDisplay.includes("<source") && !htmlSourceSrcDisplay.includes("src=") && !htmlSourceSrcDisplay.includes(plainPath) && !htmlSourceSrcDisplay.includes(basename(plainPath)),
      `count=${htmlSourceSrc.count} images=${htmlSourceSrc.images.length} display=${htmlSourceSrcDisplay}`,
    );

    const htmlAnchorPrompt = `see <a href="${plainPath}">linked screenshot</a> before fixing`;
    const htmlAnchor = mod.normalizePromptImages(undefined, htmlAnchorPrompt);
    const htmlAnchorDisplay = displayFn(htmlAnchorPrompt);
    check(
      "html anchor local image href renders and leaves clean link text",
      htmlAnchor.count === 1 && htmlAnchor.images.length === 1 && htmlAnchorDisplay.includes("linked screenshot") && !htmlAnchorDisplay.includes("<a") && !htmlAnchorDisplay.includes("href=") && !htmlAnchorDisplay.includes("</a>") && !htmlAnchorDisplay.includes(plainPath) && !htmlAnchorDisplay.includes(basename(plainPath)),
      `count=${htmlAnchor.count} images=${htmlAnchor.images.length} display=${htmlAnchorDisplay}`,
    );

    const htmlAnchorFileUrlPrompt = `see <a href="${fileUrl}">space shot</a> now`;
    const htmlAnchorFileUrl = mod.normalizePromptImages(undefined, htmlAnchorFileUrlPrompt);
    const htmlAnchorFileUrlDisplay = displayFn(htmlAnchorFileUrlPrompt);
    check(
      "html anchor file URL image href renders and leaves clean link text",
      htmlAnchorFileUrl.count === 1 && htmlAnchorFileUrl.images.length === 1 && htmlAnchorFileUrlDisplay.includes("space shot") && !htmlAnchorFileUrlDisplay.includes("<a") && !htmlAnchorFileUrlDisplay.includes("href=") && !htmlAnchorFileUrlDisplay.includes("</a>") && !htmlAnchorFileUrlDisplay.includes(fileUrl) && !htmlAnchorFileUrlDisplay.includes("Screen%20Shot"),
      `count=${htmlAnchorFileUrl.count} images=${htmlAnchorFileUrl.images.length} display=${htmlAnchorFileUrlDisplay}`,
    );

    const fileTagPrompt = `describe attached image\n<file name="${plainPath}"></file>\nplease inspect it`;
    const fileTagFallback = mod.normalizePromptImages(undefined, fileTagPrompt);
    check(
      "image path inside CLI file tag renders as fallback attachment",
      fileTagFallback.count === 1 && fileTagFallback.images.length === 1,
      `count=${fileTagFallback.count} images=${fileTagFallback.images.length}`,
    );

    const fileTagWithDirectImage = mod.normalizePromptImages([{ type: "image", data: tinyPngBase64, mimeType: "image/png" }], fileTagPrompt);
    check(
      "direct image plus matching CLI file tag does not duplicate thumbnail count",
      fileTagWithDirectImage.count === 1 && fileTagWithDirectImage.images.length === 1,
      `count=${fileTagWithDirectImage.count} images=${fileTagWithDirectImage.images.length}`,
    );

    const fileTagDisplay = displayFn(fileTagPrompt);
    check(
      "image CLI file tag is hidden from display prompt after thumbnail extraction",
      !fileTagDisplay.includes("<file") && !fileTagDisplay.includes("</file>") && !fileTagDisplay.includes(plainPath) && !fileTagDisplay.includes(basename(plainPath)) && fileTagDisplay.includes("describe attached image") && fileTagDisplay.includes("please inspect it"),
      fileTagDisplay,
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
