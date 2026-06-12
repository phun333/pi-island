/**
 * pi-island — pi extension (socket client).
 *
 * Each pi instance running this extension connects to a shared companion
 * daemon over a Unix socket and streams its session's status updates.
 * The companion owns the single Dynamic-Island WebView window and stacks
 * all active sessions as rows — so running `pi` in two terminals at the
 * same time shows TWO rows, etc.
 *
 * If the companion isn't running, we spawn it (detached) and retry the
 * connection. The companion shuts itself down 6s after the last client
 * disconnects.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@mariozechner/pi-tui";
import { connect, type Socket } from "node:net";
import { spawn, execSync, execFileSync } from "node:child_process";
import { basename, join, dirname, extname, isAbsolute, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { SOCK } from "./socket-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(HERE, "companion.mjs");
const SESSION_ID = randomUUID().slice(0, 8);

// Version the extension is running at — shipped to the companion in the
// `hello` handshake. If the companion reports a different version we
// assume state may be corrupt (pre-0.2.1 ghost-row bug, protocol drift)
// and auto-heal by respawning it. See `versionHandshake()` below.
function readExtensionVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch { return "0.0.0"; }
}
const EXTENSION_VERSION = readExtensionVersion();

// ── Persistent user preference ─────────────────────────────────────────────
// Every user-visible setting that survives restarts lives in ~/.pi/pi-island.json.
// Fields are all optional in the on-disk file — missing ones fall back to
// sensible defaults so old installs keep working on upgrade.
//
//   {
//     "enabled":     true,            // visibility toggle
//     "scale":       "medium",        // size preset
//     "screen":      "primary",       // which display
//     "notchMode":   "auto",          // notch-wrap policy
//     "promptHover": true             // reveal prompt when hovering a row
//   }
//
// The companion reads the same file at spawn time for settings it owns
// (screen + notch). Settings that change live (size, visibility,
// prompt-hover) are delivered over the socket as well.
const PREF_DIR  = join(homedir(), ".pi");
const PREF_FILE = join(PREF_DIR, "pi-island.json");

// Scale presets — mirrors SCALES in island.html.mjs. Adding a preset
// requires updates in BOTH files (the list here drives the settings
// menu / validation; the map over there drives the actual CSS scale).
const SCALES = ["small", "medium", "large", "xlarge"] as const;
type Scale = typeof SCALES[number];
const DEFAULT_SCALE: Scale = "medium";

// Screen preference:
//   "primary" → NSScreen.screens[0] (menu-bar screen, AGENT.md §6.1 original)
//   "active"  → screen under the mouse cursor at companion spawn (PR #3)
//   "2"..."N" → specific monitor by index (1 == primary, so the menu hides it)
type ScreenPref = string;
const DEFAULT_SCREEN: ScreenPref = "primary";

// Notch wrap policy:
//   "auto"   → companion auto-detects via safeAreaInsets (default, pre-0.2 behaviour)
//   "normal" → force disable (useful if auto-detection misfires)
//   "notch"  → force enable (replaces the removed /island2 command)
const NOTCH_MODES = ["auto", "normal", "notch"] as const;
type NotchMode = typeof NOTCH_MODES[number];
const DEFAULT_NOTCH: NotchMode = "auto";

type Preference = {
  enabled:     boolean;
  scale:       Scale;
  screen:      ScreenPref;
  notchMode:   NotchMode;
  promptHover: boolean;
  // Version of pi-island that last wrote this file. Used to fire a
  // one-time welcome notify after `npm update` so the user knows the
  // upgrade happened (and that state was auto-healed if needed).
  lastVersion?: string;
};

function isScale(v: unknown): v is Scale {
  return typeof v === "string" && (SCALES as readonly string[]).includes(v);
}
function isNotchMode(v: unknown): v is NotchMode {
  return typeof v === "string" && (NOTCH_MODES as readonly string[]).includes(v);
}
// "primary" | "active" | "1" | "2" | ... — numeric must be a clean integer ≥ 1.
function isScreen(v: unknown): v is ScreenPref {
  if (typeof v !== "string") return false;
  if (v === "primary" || v === "active") return true;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && String(n) === v;
}
function parseToggle(v: unknown): boolean | null {
  if (typeof v !== "string") return null;
  switch (v.toLowerCase()) {
    case "on":
    case "enable":
    case "enabled":
    case "true":
    case "yes":
      return true;
    case "off":
    case "disable":
    case "disabled":
    case "false":
    case "no":
      return false;
    default:
      return null;
  }
}

function readPreference(): Preference {
  const fallback: Preference = {
    enabled:     true,
    scale:       DEFAULT_SCALE,
    screen:      DEFAULT_SCREEN,
    notchMode:   DEFAULT_NOTCH,
    promptHover: true,
  };
  try {
    if (!existsSync(PREF_FILE)) return fallback;
    const data = JSON.parse(readFileSync(PREF_FILE, "utf8"));
    return {
      enabled:     data?.enabled !== false,
      scale:       isScale(data?.scale)          ? data.scale     : DEFAULT_SCALE,
      screen:      isScreen(data?.screen)        ? data.screen    : DEFAULT_SCREEN,
      notchMode:   isNotchMode(data?.notchMode)  ? data.notchMode : DEFAULT_NOTCH,
      promptHover: data?.promptHover !== false,
      lastVersion: typeof data?.lastVersion === "string" ? data.lastVersion : undefined,
    };
  } catch {
    return fallback;
  }
}

function writePreference(p: Preference): void {
  try {
    if (!existsSync(PREF_DIR)) mkdirSync(PREF_DIR, { recursive: true });
    writeFileSync(PREF_FILE, JSON.stringify(p, null, 2) + "\n");
  } catch { /* best-effort — don't crash the session over a cache file */ }
}

// Screen count — delegated to platform.mjs so it works on macOS and Windows.
// Dynamic import because index.ts is the extension entry point and
// platform.mjs is an .mjs file (pure ESM).
let _platformGetScreenCount: (() => number) | null = null;
async function getScreenCount(): Promise<number> {
  try {
    if (!_platformGetScreenCount) {
      const mod = await import("./platform.mjs");
      _platformGetScreenCount = mod.getScreenCount;
    }
    return _platformGetScreenCount();
  } catch { return 1; }
}

// ── tool name → island state (matches pi's built-in tool set) ──────────────
interface IslandUpdate {
  status: string;
  detail?: string;
}
interface IslandPromptImage {
  data: string;
  mimeType: string;
}
function toolToIsland(toolName: string, args: any): IslandUpdate {
  const a = args ?? {};
  switch (toolName) {
    case "read":  return { status: "reading", detail: basename(a.path ?? "") };
    case "edit":  return { status: "editing", detail: basename(a.path ?? "") };
    case "write": return { status: "writing", detail: basename(a.path ?? "") };
    case "bash": {
      const cmd = String(a.command ?? "");
      const first = cmd.split(/\s+/)[0] || "bash";
      return { status: "running", detail: first };
    }
    case "ls":    return { status: "searching", detail: basename(a.path ?? "") || "." };
    case "grep":  return { status: "searching", detail: String(a.pattern ?? "") };
    case "find":  return { status: "searching", detail: String(a.pattern ?? a.path ?? "") };
    default:      return { status: "running",   detail: toolName };
  }
}

function normalizePrompt(s: string): string {
  return String(s || "").replace(/\s+/g, " ").trim();
}

const MAX_PROMPT_IMAGES = 4;
const MAX_PROMPT_IMAGE_PATHS = 12;
// Source images can be fairly large when they come from macOS screenshot / clipboard flows.
// We never ship the original over IPC when it is large: sips creates a tiny PNG thumbnail first.
const MAX_PROMPT_IMAGE_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_INLINE_PROMPT_IMAGE_BYTES = 512 * 1024;
const PROMPT_THUMBNAIL_PX = 160;
const DONE_HIDE_MS = 400;
const DONE_HIDE_WITH_IMAGES_MS = DONE_HIDE_MS;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".bmp":  "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".svg":  "image/svg+xml",
  ".tif":  "image/tiff",
  ".tiff": "image/tiff",
};

function promptImageMimeForPath(path: string): string | null {
  return IMAGE_MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

function sniffPromptImageMime(imagePath: string): string | null {
  // Extensionless temp files show up in some clipboard / drag-paste flows.
  // Sniff a small prefix so those still render instead of requiring a suffix.
  try {
    const st = statSync(imagePath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_PROMPT_IMAGE_SOURCE_BYTES) return null;
  } catch {
    return null;
  }
  const buf = Buffer.alloc(512);
  let bytesRead = 0;
  let fd: number | null = null;
  try {
    fd = openSync(imagePath, "r");
    bytesRead = readSync(fd, buf, 0, buf.length, 0);
  } catch {
    return null;
  } finally {
    if (fd != null) try { closeSync(fd); } catch {}
  }
  const head = buf.subarray(0, bytesRead);
  if (head.length >= 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
      head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (head.length >= 6 && (head.subarray(0, 6).toString("ascii") === "GIF87a" || head.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return "image/bmp";
  }
  if (head.length >= 4 &&
      ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
       (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a))) {
    return "image/tiff";
  }
  if (head.length >= 12 && head.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = head.subarray(8, Math.min(head.length, 32)).toString("ascii");
    if (/avif|avis/.test(brand)) return "image/avif";
    if (/heic|heix|hevc|hevx|mif1|msf1/.test(brand)) return "image/heic";
  }
  const ascii = head.toString("utf8").trimStart().slice(0, 128).toLowerCase();
  if (ascii.startsWith("<svg") || (ascii.startsWith("<?xml") && ascii.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

function promptImageMimeForFile(imagePath: string): string | null {
  // Extension checks alone are not enough here: prompt text often begins with
  // slash commands such as /skill:foo, and a naive "from the first slash to
  // .png" candidate can look image-like while not being a real file. Require
  // the file to exist before accepting either extension-based or sniffed MIME.
  try {
    const st = statSync(imagePath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_PROMPT_IMAGE_SOURCE_BYTES) return null;
  } catch {
    return null;
  }
  return promptImageMimeForPath(imagePath) ?? sniffPromptImageMime(imagePath);
}

function promptImageExtForMime(mimeType: string): string {
  const entry = Object.entries(IMAGE_MIME_BY_EXT).find(([, mime]) => mime === mimeType);
  return entry ? entry[0] : ".png";
}

function cleanBase64ImageData(data: string): string {
  const comma = data.indexOf(",");
  const raw = data.trim().startsWith("data:") && comma >= 0 ? data.slice(comma + 1) : data;
  return raw.replace(/\s+/g, "");
}

function promptImageMimeFromDataUrl(data: string): string | null {
  const match = String(data || "").trim().match(/^data:([^;,]+)(?:;[^,]*)?,/i);
  const mime = match?.[1]?.toLowerCase();
  return mime?.startsWith("image/") ? mime : null;
}

function base64ByteLength(data: string): number {
  const clean = cleanBase64ImageData(data);
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function promptImageBytesHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function promptImageHashFromBase64(data: string): string | null {
  try {
    const bytes = Buffer.from(cleanBase64ImageData(data), "base64");
    return bytes.length > 0 && bytes.length <= MAX_PROMPT_IMAGE_SOURCE_BYTES ? promptImageBytesHash(bytes) : null;
  } catch {
    return null;
  }
}

function promptImageHashFromFile(imagePath: string): string | null {
  try {
    const st = statSync(imagePath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_PROMPT_IMAGE_SOURCE_BYTES) return null;
    return promptImageBytesHash(readFileSync(imagePath));
  } catch {
    return null;
  }
}

function makePromptThumbnailFromFile(imagePath: string): IslandPromptImage | null {
  if (process.platform !== "darwin") return null;

  const outPath = join(tmpdir(), `pi-island-thumb-${randomUUID()}.png`);
  try {
    execFileSync(
      "sips",
      ["-s", "format", "png", "-Z", String(PROMPT_THUMBNAIL_PX), imagePath, "--out", outPath],
      { stdio: "ignore", timeout: 7000 },
    );
    const st = statSync(outPath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_INLINE_PROMPT_IMAGE_BYTES) return null;
    return { data: readFileSync(outPath).toString("base64"), mimeType: "image/png" };
  } catch {
    return null;
  } finally {
    try { unlinkSync(outPath); } catch {}
  }
}

function makePromptThumbnailFromBase64(data: string, mimeType: string): IslandPromptImage | null {
  if (process.platform !== "darwin") return null;

  const inputPath = join(tmpdir(), `pi-island-src-${randomUUID()}${promptImageExtForMime(mimeType)}`);
  try {
    writeFileSync(inputPath, Buffer.from(cleanBase64ImageData(data), "base64"));
    return makePromptThumbnailFromFile(inputPath);
  } catch {
    return null;
  } finally {
    try { unlinkSync(inputPath); } catch {}
  }
}

function makePromptImageFromFile(imagePath: string, mimeType: string): IslandPromptImage | null {
  const st = statSync(imagePath);
  if (!st.isFile() || st.size <= 0 || st.size > MAX_PROMPT_IMAGE_SOURCE_BYTES) return null;

  const thumbnail = makePromptThumbnailFromFile(imagePath);
  if (thumbnail) return thumbnail;

  if (st.size <= MAX_INLINE_PROMPT_IMAGE_BYTES) {
    return { data: readFileSync(imagePath).toString("base64"), mimeType };
  }
  return null;
}

function makePromptImageFromBase64(data: string, mimeType: string): IslandPromptImage | null {
  const bytes = base64ByteLength(data);
  if (bytes <= 0 || bytes > MAX_PROMPT_IMAGE_SOURCE_BYTES) return null;

  if (bytes <= MAX_INLINE_PROMPT_IMAGE_BYTES) {
    return { data: cleanBase64ImageData(data), mimeType };
  }
  return makePromptThumbnailFromBase64(data, mimeType);
}

function stripTrailingPathPunctuation(raw: string): string {
  let s = raw.trim();
  while (s && /[),.;:!?}\]]$/.test(s) && !promptImageMimeForPath(s)) {
    s = s.slice(0, -1).trimEnd();
  }
  return s;
}

function unescapeShellPath(s: string): string {
  // POSIX prompts often contain shell-escaped spaces, e.g.
  // /Users/me/Desktop/Screen\ Shot.png. On Windows, backslashes are path
  // separators, so leave native drive/UNC paths alone.
  if (process.platform === "win32" && (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s))) {
    return s;
  }
  return s.replace(/\\+([ \t\\'"`$&|;()<>\[\]{}!*?#])/g, "$1");
}

function decodeHtmlEntities(s: string): string {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (raw, entity) => {
    const e = String(entity).toLowerCase();
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : e.startsWith("#") ? parseInt(e.slice(1), 10) : NaN;
    return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
  });
}

function normalizePromptImagePath(raw: string): string | null {
  let s = stripTrailingPathPunctuation(raw);
  if (!s) return null;
  // Match pi's path UX: users (and models) often prefix file paths with @.
  // Treat @ as decoration only when it is immediately followed by a supported
  // path prefix, and keep it in the raw span so display cleanup removes it too.
  if (/^@(?=file:\/\/|~[\\/]|\.\.?[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/.test(s)) {
    s = s.slice(1);
  }

  try {
    if (/^file:\/\//i.test(s)) s = fileURLToPath(s);
  } catch {
    return null;
  }

  s = unescapeShellPath(stripTrailingPathPunctuation(s));
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    s = join(homedir(), s.slice(2));
  }

  if (!isAbsolute(s)) {
    // Users can type/path-complete cwd-relative images just like they do for
    // tools. Restrict this to explicit relative prefixes so ordinary words like
    // "diagram.png" don't trigger filesystem probes all over the prompt.
    if (!/^\.\.?[\\/]/.test(s)) return null;
    s = resolve(process.cwd(), s);
  }
  const resolveExistingImage = (candidate: string): string | null => {
    if (promptImageMimeForFile(candidate)) return candidate;
    const fallbacks: string[] = [];
    // Browser/rich clipboard text sometimes drops the file:// scheme but keeps
    // URL escapes (e.g. /tmp/Screen%20Shot.png). Prefer literal filenames first;
    // only fall back to decoding when the literal path did not resolve.
    if (candidate.includes("%")) {
      try {
        const decoded = decodeURI(candidate);
        if (decoded !== candidate) fallbacks.push(decoded);
      } catch { /* Invalid percent escapes: treat as a literal path. */ }
    }
    // HTML copied from browsers escapes attribute values, so local paths such as
    // R&D Screen Shot.png may arrive as R&amp;D Screen Shot.png. Decode only as a
    // fallback so literal filenames containing entity text still win.
    const htmlDecoded = decodeHtmlEntities(candidate);
    if (htmlDecoded !== candidate) fallbacks.push(htmlDecoded);
    for (const fallback of [...fallbacks]) {
      const decodedFallback = decodeHtmlEntities(fallback);
      if (decodedFallback !== fallback) fallbacks.push(decodedFallback);
    }
    const seenFallbacks = new Set<string>();
    for (const fallback of fallbacks) {
      if (seenFallbacks.has(fallback)) continue;
      seenFallbacks.add(fallback);
      if (promptImageMimeForFile(fallback)) return fallback;
    }
    return null;
  };

  const literal = resolveExistingImage(s);
  if (literal) return literal;

  // URL-ish local paths may carry cache-busting query/fragment suffixes. Try
  // the base path only after literal lookup so real filenames containing ?/#
  // still win when they exist.
  const suffixAt = s.search(/[?#]/);
  if (suffixAt > 0) return resolveExistingImage(s.slice(0, suffixAt));
  return null;
}

type PromptImagePathMatch = { raw: string; path: string; index: number };
type PromptImageFileTagMatch = { raw: string; path: string; index: number; end: number };

function extractPromptImageFileTagMatches(prompt: string): PromptImageFileTagMatch[] {
  const text = String(prompt || "");
  if (!text) return [];

  const matches: PromptImageFileTagMatch[] = [];
  const seen = new Set<string>();
  const fileTagRe = /<file\b[^>]*(?:\/\s*>|>[\s\S]*?<\/file>)/gi;
  let match: RegExpExecArray | null;
  while ((match = fileTagRe.exec(text))) {
    const raw = match[0];
    const openTag = raw.match(/^<file\b[^>]*>/i)?.[0] ?? raw;
    const candidate = htmlAttrValue(openTag, "name") ?? "";
    const path = normalizePromptImagePath(candidate);
    if (!path) continue;
    const key = `${match.index}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ raw, path, index: match.index, end: match.index + raw.length });
  }
  return matches;
}

function extractPromptImagePathMatches(prompt: string, opts: { dedupe?: boolean } = {}): PromptImagePathMatch[] {
  const text = String(prompt || "");
  if (!text) return [];

  const dedupe = opts.dedupe !== false;
  const matches: PromptImagePathMatch[] = [];
  const seen = new Set<string>();
  const seenSpans = new Set<string>();
  const add = (candidate: string, raw = candidate, index = -1): boolean => {
    const path = normalizePromptImagePath(candidate);
    if (!path) return false;
    // Return true for duplicates too: the caller found a real path and should
    // not keep walking inward to shorter suffixes like /image.png.
    const spanKey = `${index}:${raw}`;
    if (seenSpans.has(spanKey)) return true;
    if (dedupe && seen.has(path)) return true;
    if (dedupe) seen.add(path);
    seenSpans.add(spanKey);
    matches.push({ raw, path, index });
    return true;
  };

  // Quoted paths may contain spaces; remove the quotes from the display prompt
  // together with the path by keeping match[0] as the raw span.
  const quotedRe = /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = quotedRe.exec(text))) {
    add(match[1] ?? match[2] ?? match[3] ?? "", match[0], match.index);
  }

  const extAlternation = Object.keys(IMAGE_MIME_BY_EXT)
    .map((ext) => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");

  // Unquoted paths copied from Finder / Terminal often contain literal spaces
  // (for example "Screen Shot 2026-...png") and are not shell-escaped. Instead
  // of taking the first slash before .png (which turns "/skill:foo ... /tmp/a.png"
  // into one bogus candidate), scan every path-looking prefix before the image
  // extension and accept the first prefix that resolves to a real image file.
  const imageExtRe = new RegExp(
    String.raw`\.(?:${extAlternation})(?=$|[\s"'\`<>),.;:!?}\]])`,
    "gi",
  );
  const pathPrefixRe = /@?(?:file:\/\/|~[\\/]|\.\.?[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/g;
  while ((match = imageExtRe.exec(text))) {
    const end = match.index + match[0].length;
    const lineStart = Math.max(text.lastIndexOf("\n", match.index) + 1, text.lastIndexOf("\r", match.index) + 1);
    const linePrefix = text.slice(lineStart, end);
    const starts: number[] = [];
    pathPrefixRe.lastIndex = 0;
    let prefix: RegExpExecArray | null;
    while ((prefix = pathPrefixRe.exec(linePrefix))) {
      starts.push(lineStart + prefix.index);
    }
    const suffix = text.slice(end).match(/^[?#][^\s"'`<>),;\]}]*/)?.[0] ?? "";
    const rawEnd = end + suffix.length;
    for (const start of starts) {
      if (add(text.slice(start, end), text.slice(start, rawEnd), start)) break;
    }
  }

  // Unquoted absolute paths / file URLs. POSIX shell-escaped spaces are
  // kept as part of the candidate via the \\\s alternative. This also catches
  // extensionless temp files when they are whitespace-delimited.
  const unquotedRe = /@?(?:file:\/\/[^\s"'`<>]+|~\/(?:\\\s|[^\s"'`<>])+|\.\.?[\\/](?:\\\s|[^\s"'`<>])+|\/(?:\\\s|[^\s"'`<>])+|[A-Za-z]:[\\/][^\s"'`<>]+|\\\\[^\s"'`<>]+)/g;
  while ((match = unquotedRe.exec(text))) {
    add(match[0], match[0], match.index);
  }

  return matches.slice(0, MAX_PROMPT_IMAGE_PATHS);
}

function extractPromptImagePaths(prompt: string): string[] {
  return extractPromptImagePathMatches(prompt).map((match) => match.path);
}

function normalizeMarkdownLocalImageReferencesForDisplay(prompt: string): string {
  let display = String(prompt || "");
  const matches = extractPromptImagePathMatches(display, { dedupe: false })
    .filter((match) => match.index >= 0)
    .sort((a, b) => b.index - a.index);

  for (const match of matches) {
    const before = display.slice(0, match.index);
    // Handles both images and links: ![alt](/tmp/a.png), [label](/tmp/a.png),
    // and angle-wrapped targets like ![alt](</tmp/Screen Shot.png>).
    const opener = before.match(/!?\[([^\]\r\n]*)\]\(\s*<?$/);
    if (!opener || opener.index == null) continue;

    const afterStart = match.index + match.raw.length;
    const closer = display.slice(afterStart).match(/^\s*>?(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\)\r\n]*\)))?\s*\)/);
    if (!closer) continue;

    const label = decodeHtmlEntities(String(opener[1] || "").trim());
    display = display.slice(0, opener.index) + (label ? ` ${label} ` : " ") + display.slice(afterStart + closer[0].length);
  }

  return display;
}

function htmlAttrValue(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s>]+))`, "i"));
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function htmlSrcsetLocalImagePaths(srcset: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of String(srcset || "").split(",")) {
    // Strip a simple srcset density/width descriptor ("1x", "2x", "640w")
    // before resolving. URLs with spaces should be quoted/escaped in real HTML;
    // this keeps the common clipboard cases lightweight.
    const candidate = item.trim().replace(/\s+\d+(?:\.\d+)?[wx]\s*$/i, "").trim();
    const path = candidate ? normalizePromptImagePath(candidate) : null;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function htmlSrcsetHasLocalImage(srcset: string): boolean {
  return htmlSrcsetLocalImagePaths(srcset).length > 0;
}

function htmlLocalImagePathsFromTag(tag: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string | null | undefined) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  const src = htmlAttrValue(tag, "src")?.trim();
  add(src ? normalizePromptImagePath(src) : null);
  const srcset = htmlAttrValue(tag, "srcset")?.trim();
  for (const path of srcset ? htmlSrcsetLocalImagePaths(srcset) : []) add(path);
  return paths;
}

function normalizeHtmlLocalImageTagsForDisplay(prompt: string): string {
  return String(prompt || "").replace(/<img\b[^>]*>(?:\s*<\/img>)?/gi, (raw) => {
    if (htmlLocalImagePathsFromTag(raw).length === 0) return raw;
    const alt = htmlAttrValue(raw, "alt")?.trim() ?? "";
    return alt ? ` ${alt} ` : " ";
  });
}

function normalizeHtmlLocalImageSourceTagsForDisplay(prompt: string): string {
  return String(prompt || "").replace(/<source\b[^>]*>(?:\s*<\/source>)?/gi, (raw) =>
    htmlLocalImagePathsFromTag(raw).length > 0 ? " " : raw
  );
}

function normalizeHtmlPictureWrappersForDisplay(prompt: string): string {
  return String(prompt || "").replace(/<\/?picture\b[^>]*>/gi, " ");
}

function normalizeHtmlLocalImageAnchorsForDisplay(prompt: string): string {
  return String(prompt || "").replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (raw) => {
    const href = htmlAttrValue(raw, "href");
    if (!href || !normalizePromptImagePath(href.trim())) return raw;
    const text = decodeHtmlEntities(raw
      .replace(/^<a\b[^>]*>/i, "")
      .replace(/<\/a>$/i, "")
      .replace(/<[^>]+>/g, " ")
      .trim());
    return text ? ` ${text} ` : " ";
  });
}

type HtmlImageCandidateGroup = { index: number; end: number; paths: string[]; kept: boolean };

function extractHtmlImageCandidateGroups(prompt: string): HtmlImageCandidateGroup[] {
  const groups: HtmlImageCandidateGroup[] = [];
  const text = String(prompt || "");
  const collectTagPaths = (html: string): string[] => {
    const paths: string[] = [];
    const seen = new Set<string>();
    const tagRe = /<(?:img|source)\b[^>]*>/gi;
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(html))) {
      for (const path of htmlLocalImagePathsFromTag(tag[0])) {
        if (seen.has(path)) continue;
        seen.add(path);
        paths.push(path);
      }
    }
    return paths;
  };

  const pictureRe = /<picture\b[^>]*>[\s\S]*?<\/picture>/gi;
  let picture: RegExpExecArray | null;
  while ((picture = pictureRe.exec(text))) {
    const paths = collectTagPaths(picture[0]);
    if (paths.length > 1) groups.push({ index: picture.index, end: picture.index + picture[0].length, paths, kept: false });
  }

  const tagRe = /<(?:img|source)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text))) {
    const paths = htmlLocalImagePathsFromTag(match[0]);
    if (paths.length > 1) groups.push({ index: match.index, end: match.index + match[0].length, paths, kept: false });
  }
  return groups;
}

function normalizePromptForDisplay(prompt: string): string {
  let display = String(prompt || "");

  // Markdown image/link syntax is another common way local screenshots show up
  // in pasted prompts. The thumbnail carries the actual image, so keep only the
  // useful alt/link text in the hover preview and drop punctuation/path. This is
  // path-match based instead of target-regex based so filenames containing ')'
  // still clean up correctly.
  display = normalizeMarkdownLocalImageReferencesForDisplay(display);

  // Rich clipboard / issue text may include local <img src="..." alt="...">
  // tags. Treat them like Markdown images: render the thumbnail, keep only the
  // alt label in the hover prompt, and remove broken tag markup. Local image
  // anchors get the same treatment, preserving only the human-readable link text.
  display = normalizeHtmlLocalImageTagsForDisplay(display);
  display = normalizeHtmlLocalImageSourceTagsForDisplay(display);
  display = normalizeHtmlPictureWrappersForDisplay(display);
  display = normalizeHtmlLocalImageAnchorsForDisplay(display);

  // pi's CLI file-argument flow represents attached images as both an
  // ImageContent payload and a lightweight <file name="/path/image.png"> tag
  // in the prompt text. Once we render a thumbnail, that XML-ish marker is UI
  // noise; remove the whole image tag instead of leaving <file name= ></file>.
  const rawFileTags = [...new Set(extractPromptImageFileTagMatches(display).map((match) => match.raw).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const raw of rawFileTags) {
    display = display.split(raw).join(" ");
  }

  const rawPaths = [...new Set(extractPromptImagePathMatches(display, { dedupe: false }).map((match) => match.raw).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const raw of rawPaths) {
    display = display.split(raw).join(" ");
  }
  // If the user wrote a path in common wrappers — e.g. (/tmp/a.png) or
  // <file:///tmp/a.png> — removing the path alone leaves visual litter like
  // "( )". Drop empty balanced wrappers after path/tag elision.
  display = display.replace(/\(\s*\)|\[\s*\]|\{\s*\}|<\s*>/g, " ");
  return normalizePrompt(display.replace(/\s+([,.;:!?])/g, "$1"));
}

function promptImageHashFromObject(img: any): string | null {
  if (!img || img.type !== "image") return null;

  const directData = typeof img.data === "string" ? img.data : undefined;
  const directMime =
    typeof img.mimeType === "string" && img.mimeType.toLowerCase().startsWith("image/") ? img.mimeType :
    directData ? promptImageMimeFromDataUrl(directData) :
    undefined;
  if (directData && directMime) {
    return promptImageHashFromBase64(directData);
  }

  const source = img.source;
  const sourceData = typeof source?.data === "string" ? source.data : undefined;
  const sourceMime =
    typeof source?.mediaType === "string" && source.mediaType.toLowerCase().startsWith("image/") ? source.mediaType :
    typeof source?.media_type === "string" && source.media_type.toLowerCase().startsWith("image/") ? source.media_type :
    sourceData ? promptImageMimeFromDataUrl(sourceData) :
    undefined;
  if (source?.type === "base64" && sourceData && sourceMime) {
    return promptImageHashFromBase64(sourceData);
  }

  return null;
}

function normalizePromptImageObject(img: any): IslandPromptImage | null {
  if (!img || img.type !== "image") return null;

  const directData = typeof img.data === "string" ? img.data : undefined;
  const directMime =
    typeof img.mimeType === "string" && img.mimeType.toLowerCase().startsWith("image/") ? img.mimeType :
    directData ? promptImageMimeFromDataUrl(directData) :
    undefined;
  if (directData && directMime) {
    return makePromptImageFromBase64(directData, directMime);
  }

  const source = img.source;
  const sourceData = typeof source?.data === "string" ? source.data : undefined;
  const sourceMime =
    typeof source?.mediaType === "string" && source.mediaType.toLowerCase().startsWith("image/") ? source.mediaType :
    typeof source?.media_type === "string" && source.media_type.toLowerCase().startsWith("image/") ? source.media_type :
    sourceData ? promptImageMimeFromDataUrl(sourceData) :
    undefined;
  if (source?.type === "base64" && sourceData && sourceMime) {
    return makePromptImageFromBase64(sourceData, sourceMime);
  }

  return null;
}

function normalizePromptImages(images: any, prompt = ""): { images: IslandPromptImage[]; count: number } {
  const normalized: IslandPromptImage[] = [];
  const directImageHashes = new Map<string, number>();
  let count = 0;

  const addImage = (img: IslandPromptImage) => {
    count++;
    if (normalized.length < MAX_PROMPT_IMAGES) normalized.push(img);
  };
  const addDirectImageHash = (hash: string | null) => {
    if (!hash) return;
    directImageHashes.set(hash, (directImageHashes.get(hash) ?? 0) + 1);
  };

  if (Array.isArray(images)) {
    for (const img of images) {
      const hash = promptImageHashFromObject(img);
      if (hash && directImageHashes.has(hash)) continue;
      const image = normalizePromptImageObject(img);
      if (image) {
        addImage(image);
        addDirectImageHash(hash);
      }
    }
  }

  const htmlImageGroups = extractHtmlImageCandidateGroups(prompt);
  const hasDirectImageMatchForFile = (imagePath: string): boolean => {
    if (directImageHashes.size === 0) return false;
    const hash = promptImageHashFromFile(imagePath);
    return !!hash && (directImageHashes.get(hash) ?? 0) > 0;
  };
  const hasDirectImageMatchForFiles = (imagePaths: string[]): boolean => {
    for (const imagePath of imagePaths) {
      if (hasDirectImageMatchForFile(imagePath)) return true;
    }
    return false;
  };

  for (const match of extractPromptImagePathMatches(prompt)) {
    const imagePath = match.path;
    const htmlGroup = htmlImageGroups.find((group) =>
      match.index >= group.index && match.index < group.end && group.paths.includes(imagePath)
    );
    if (htmlGroup) {
      if (htmlGroup.kept) continue;
      htmlGroup.kept = true;
      if (hasDirectImageMatchForFiles(htmlGroup.paths)) continue;
    } else if (hasDirectImageMatchForFile(imagePath)) {
      continue;
    }

    const mimeType = promptImageMimeForFile(imagePath);
    if (!mimeType) continue;
    try {
      const image = makePromptImageFromFile(imagePath, mimeType);
      if (!image) continue;
      count++;
      if (normalized.length < MAX_PROMPT_IMAGES) normalized.push(image);
    } catch { /* Ignore paths that disappeared or are unreadable. */ }
  }

  return { images: normalized, count };
}

// Project names come from `basename(process.cwd())` — usually short
// (`pi-island`, `my-app`) but occasionally pathological. Clamp at the
// source so the socket never ships 200-char strings; CSS adds a second
// ellipsis safety net in case this ever regresses.
function truncateProject(s: string, max = 20): string {
  const clean = String(s || "");
  if (!clean) return "";
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

// ── extension entry ────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin" && process.platform !== "win32") return;

  // ── Client state ─────────────────────────────────────────────────────────
  let sock: Socket | null = null;
  let connecting = false;
  const pref = readPreference();
  let shownForSession    = pref.enabled;
  let currentScale:     Scale      = pref.scale;
  let currentScreen:    ScreenPref = pref.screen;
  let currentNotchMode: NotchMode  = pref.notchMode;
  let currentPromptHover = pref.promptHover;
  let hideTimer: NodeJS.Timeout | null = null;

  const project = truncateProject(basename(process.cwd()));
  let lastCtx: any = null;
  let activeToolCount = 0;
  let inAgent = false;
  let currentPrompt = "";
  let currentPromptImages: IslandPromptImage[] = [];
  let currentPromptImageCount = 0;
  let startedAt: number | null = null;
  let frozenElapsed: number | null = null;

  function persistPref() {
    writePreference({
      enabled:     shownForSession,
      scale:       currentScale,
      screen:      currentScreen,
      notchMode:   currentNotchMode,
      promptHover: currentPromptHover,
      lastVersion: EXTENSION_VERSION,
    });
  }

  // ── Socket connection ────────────────────────────────────────────────────
  function connectToCompanion(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = connect(SOCK);
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (ok) { sock = s; sock.on("close", () => { sock = null; }); sock.on("error", () => {}); }
        resolve(ok);
      };
      s.once("connect", () => done(true));
      s.once("error",   () => done(false));
    });
  }

  // Auto-heal: ask the companion "what version are you?" and if it
  // disagrees with us (or doesn't answer — pre-0.2.1 companions have no
  // `hello` handler) treat it as stale and force a respawn. This is what
  // lets a user `npm update` and see ghost rows disappear without ever
  // running `/island reload` or `pkill` manually.
  //
  // Returns true if the current companion is compatible (same version);
  // false if the caller should forceRespawn() and reconnect.
  function versionHandshake(): Promise<boolean> {
    const s = sock;
    if (!s || s.destroyed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let buf = "";
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        s.off("data", onData);
        resolve(ok);
      };
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            if (msg && msg.type === "hello-ack") {
              finish(typeof msg.version === "string" && msg.version === EXTENSION_VERSION);
              return;
            }
          } catch { /* not our line, ignore */ }
          nl = buf.indexOf("\n");
        }
      };
      s.on("data", onData);
      try {
        s.write(JSON.stringify({
          id: SESSION_ID,
          type: "hello",
          version: EXTENSION_VERSION,
        }) + "\n");
      } catch {
        finish(false);
        return;
      }
      // Generous timeout — pre-0.2.1 companions never reply, and we want
      // to respawn them. A legit companion responds in <10ms on localhost.
      setTimeout(() => finish(false), 1000);
    });
  }

  // Force the companion to exit regardless of protocol support. Polite
  // first (respawn message for v0.2.1+ companions), then a hard pkill
  // so pre-0.2.1 companions — which don't understand `respawn` — die
  // too. Also cleans up the socket file in case the old process crashed
  // without removing it. Safe to call even when no companion is running.
  async function forceRespawn(): Promise<void> {
    if (sock && !sock.destroyed) {
      // Clean up any ghost row the old companion may have created from our
      // `hello` message (pre-0.2.1 treated unknown types as upserts).
      try { writeMessage({ id: SESSION_ID, type: "remove" }); } catch {}
      try { writeMessage({ id: SESSION_ID, type: "respawn" }); } catch {}
      try { sock.end(); } catch {}
      sock = null;
    }
    try {
      if (process.platform === "win32") {
        execSync('taskkill /F /FI "COMMANDLINE eq *pi-island*companion.mjs*"', {
          timeout: 1000,
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        execSync("pkill -f pi-island/pi-extension/companion.mjs", {
          timeout: 1000,
          stdio: "ignore",
          windowsHide: true,
        });
      }
    } catch { /* no matching process */ }
    // Unix sockets leave a file on disk; named pipes (Windows) auto-clean.
    if (process.platform !== "win32") {
      try { if (existsSync(SOCK)) unlinkSync(SOCK); } catch {}
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Tell the companion the client's current visual scale. Pushed on every
  // fresh connect so a freshly-spawned companion (medium by default) picks
  // up the user's pref without waiting for an explicit size change.
  function syncScale() {
    writeMessage({ id: SESSION_ID, type: "scale", scale: currentScale });
  }

  // Prompt reveal is live and global to the shared capsule. The prompt is
  // hidden from the compact row by default; this controls whether hovering
  // the row expands a small prompt preview beneath it.
  function syncPromptHover() {
    writeMessage({ id: SESSION_ID, type: "prompt-hover", enabled: currentPromptHover });
  }

  async function ensureConnection(): Promise<boolean> {
    if (sock && !sock.destroyed) return true;
    if (connecting) return false;
    connecting = true;
    try {
      // Try connecting to an existing companion first.
      if (existsSync(SOCK) && await connectToCompanion()) {
        // Auto-heal: verify the running companion matches our version.
        // If it doesn't (or doesn't respond to hello — pre-0.2.1), kill
        // it and spawn a fresh one. This is the "user ran npm update but
        // ghost rows stick around" fix.
        if (await versionHandshake()) {
          syncScale();
          syncPromptHover();
          return true;
        }
        await forceRespawn();
        // Fall through to the spawn path below.
      }

      // Otherwise spawn the companion and poll until the socket is up.
      if (!existsSync(COMPANION)) return false;
      const child = spawn(process.execPath, [COMPANION], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await connectToCompanion()) {
          // We spawned this companion ourselves, so versions match by
          // construction — but still do the handshake as a sanity check
          // (catches the "wrong binary on PATH" failure mode).
          if (await versionHandshake()) {
            syncScale();
            syncPromptHover();
            return true;
          }
          // If even a freshly-spawned companion disagrees, give up
          // rather than looping. Something is badly wrong.
          return false;
        }
      }
      return false;
    } finally {
      connecting = false;
    }
  }

  function writeMessage(msg: any) {
    if (!sock || sock.destroyed) return;
    try { sock.write(JSON.stringify(msg) + "\n"); } catch { /* pipe might be closed */ }
  }

  async function sendUpdate(status: string, detail = "", opts: { resetTimer?: boolean } = {}) {
    if (!shownForSession) return;
    let refreshedConnection = false;
    if (!sock || sock.destroyed) {
      if (!(await ensureConnection())) return;
      refreshedConnection = true;
    }
    const resetForTurn = opts.resetTimer || startedAt == null;
    if (resetForTurn) {
      startedAt = Date.now();
      frozenElapsed = null;
    }
    let ctxPct: number | null = null;
    try {
      const usage = lastCtx?.getContextUsage?.();
      if (usage && usage.percent != null) ctxPct = Math.round(usage.percent);
    } catch {}
    const msg: any = {
      id: SESSION_ID,
      type: "update",
      project,
      status,
      detail,
      startedAt,
      frozenElapsed,
      ctxPct,
    };
    // Images can be large, so send the prompt payload only at turn start
    // (or after reconnect). The WebView merges later partial updates.
    if (resetForTurn || refreshedConnection) {
      msg.prompt = currentPrompt;
      msg.promptImages = currentPromptImages;
      msg.promptImageCount = currentPromptImageCount;
    }
    writeMessage(msg);
  }

  async function sendRemove() {
    if (!sock) return;
    writeMessage({ id: SESSION_ID, type: "remove" });
  }

  // Ask the companion to cleanly exit so the client's next event respawns
  // it with fresh pref values. Used for settings that need a new NSWindow
  // (screen position, notch mode) — NSWindow geometry is fixed after spawn.
  async function respawnCompanion() {
    if (sock && !sock.destroyed) {
      writeMessage({ id: SESSION_ID, type: "respawn" });
      try { sock.end(); } catch {}
      sock = null;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (shownForSession) await ensureConnection();
  }

  // User-facing reset — nukes the companion (and with it any ghost rows)
  // and lets the next event spawn a clean one. Exposed via `/island reload`.
  // Uses forceRespawn() because the caller likely reached for this exactly
  // when polite `respawn` isn't enough (stale state, pre-0.2.1 companion).
  async function reloadCompanion(ctx: any) {
    await forceRespawn();
    if (shownForSession) await ensureConnection();
    ctx.ui.notify("Island reloaded — state reset", "info");
  }

  // One-time welcome notice after `npm update`. Fires on the first
  // session of a newly-installed version and updates `lastVersion` in
  // the pref file so it doesn't nag on subsequent sessions.
  function maybeShowUpgradeNotice(ctx: any) {
    if (pref.lastVersion === EXTENSION_VERSION) return;
    // First session ever (no lastVersion) — don't nag new users.
    const isFirstEver = !pref.lastVersion;
    persistPref();  // writes lastVersion = EXTENSION_VERSION
    if (isFirstEver) return;
    try {
      ctx.ui.notify(
        `pi-island updated to ${EXTENSION_VERSION}. Try /island for settings.`,
        "info",
      );
    } catch { /* best-effort — don't crash a session over a toast */ }
  }

  // ── Setting actions (shared between /island subcommands and the menu) ────
  async function doEnable(ctx: any) {
    shownForSession = true;
    persistPref();
    await ensureConnection();
    ctx.ui.notify("Island enabled", "info");
  }

  async function doDisable(ctx: any) {
    shownForSession = false;
    persistPref();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    await sendRemove();
    ctx.ui.notify("Island disabled", "info");
  }

  async function doSetScale(next: Scale, ctx: any) {
    currentScale = next;
    persistPref();
    // Scale is live — no companion respawn needed. CSS var flips instantly.
    if (sock && !sock.destroyed) {
      syncScale();
    } else if (shownForSession) {
      if (await ensureConnection()) syncScale();
    }
    ctx.ui.notify(`Island size → ${next}`, "info");
  }

  async function doSetScreen(next: ScreenPref, ctx: any) {
    currentScreen = next;
    persistPref();
    await respawnCompanion();
    ctx.ui.notify(`Island screen → ${next}`, "info");
  }

  async function doSetNotchMode(next: NotchMode, ctx: any) {
    currentNotchMode = next;
    persistPref();
    await respawnCompanion();
    ctx.ui.notify(`Island notch wrap → ${next}`, "info");
  }

  async function doSetPromptHover(next: boolean, ctx: any) {
    currentPromptHover = next;
    persistPref();
    // Live CSS toggle — no companion/native host respawn needed.
    if (sock && !sock.destroyed) {
      syncPromptHover();
    } else if (shownForSession) {
      if (await ensureConnection()) syncPromptHover();
    }
    ctx.ui.notify(`Island prompt hover → ${next ? "enabled" : "disabled"}`, "info");
  }

  // ── Settings menu — same UX as pi's /settings ────────────────────────────
  // Uses pi-tui's SettingsList component via ctx.ui.custom(). Each row
  // shows a label + current value; Enter/Space cycles through `values`.
  // The action callbacks are the same helpers the /island subcommands use,
  // so menu and CLI stay perfectly in sync.
  //
  // IMPORTANT pattern notes (learned the hard way):
  //   - Do NOT pass { overlay: true }. It puts us in a narrow floating box
  //     that bleeds terminal scrollback through the transparent areas
  //     (rendering garbage). Full-width in-flow render — same layout as
  //     pi's own /settings — needs no options at all.
  //   - The factory MUST return an object with explicit render/invalidate/
  //     handleInput — NOT the Container directly. Container doesn't route
  //     keystrokes to its active focusable child, so the list would never
  //     see Enter/Space/arrows and the terminal looks frozen.
  //   - handleInput must call tui.requestRender() after each keystroke or
  //     the cycled value doesn't repaint until the next unrelated event.
  async function openSettingsMenu(ctx: any) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Settings menu needs an interactive UI. Try /island size|screen|notch|prompt <value>",
        "info",
      );
      return;
    }

    const screenCount = await getScreenCount();
    const screenValues: string[] = ["primary", "active"];
    for (let i = 2; i <= screenCount; i++) screenValues.push(String(i));

    await ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: (r?: void) => void) => {
      const items: SettingItem[] = [
          {
            id: "visibility",
            label: "Visibility",
            description: "Show or hide the Dynamic Island capsule at the top of the screen",
            currentValue: shownForSession ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "size",
            label: "Size",
            description: "Font size / row height preset (live — no restart needed)",
            currentValue: currentScale,
            values: [...SCALES],
          },
          {
            id: "screen",
            label: "Screen",
            description: "Display to host the capsule (primary = menu-bar screen; active = follow mouse; 2/3/… = monitor index)",
            currentValue: currentScreen,
            values: screenValues,
          },
          {
            id: "notch",
            label: "Notch wrap",
            description: "Wrap the MacBook notch (auto = detect; normal = force off; notch = force on)",
            currentValue: currentNotchMode,
            values: [...NOTCH_MODES],
          },
          {
            id: "promptHover",
            label: "Prompt hover",
            description: "Reveal the hidden user prompt when hovering a row",
            currentValue: currentPromptHover ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
        ];

      const container = new Container();
      const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
      container.addChild(border());

      const list = new SettingsList(
        items,
        10,
        getSettingsListTheme(),
        (id: string, newValue: string) => {
          // Fire-and-forget — SettingsList doesn't await us. Any failure
          // just leaves the displayed value updated but the real setting
          // unchanged. In practice all our do*() helpers are robust.
          (async () => {
            if (id === "visibility") {
              if (newValue === "enabled") await doEnable(ctx);
              else await doDisable(ctx);
            } else if (id === "size" && isScale(newValue)) {
              await doSetScale(newValue, ctx);
            } else if (id === "screen" && isScreen(newValue)) {
              await doSetScreen(newValue, ctx);
            } else if (id === "notch" && isNotchMode(newValue)) {
              await doSetNotchMode(newValue, ctx);
            } else if (id === "promptHover") {
              await doSetPromptHover(newValue === "enabled", ctx);
            }
          })();
          list.updateValue(id, newValue);
        },
        () => done(undefined),
        { enableSearch: false },
      );
      container.addChild(list);
      container.addChild(border());

      // Explicit Component-shaped return so keystrokes actually reach the
      // SettingsList (Container alone swallows them). See header comment.
      return {
        render(width: number) { return container.render(width); },
        invalidate()            { container.invalidate(); },
        handleInput(data: string) {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  // ── Event handlers ───────────────────────────────────────────────────────
  pi.on("session_start", async (_evt, ctx) => {
    lastCtx = ctx;
    // Don't auto-show on session start — the island appears on the first
    // agent_start event (when there's actually something to show).
    maybeShowUpgradeNotice(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (hideTimer) clearTimeout(hideTimer);
    await sendRemove();
    try { sock?.end(); } catch {}
    sock = null;
  });

  pi.on("before_agent_start", async (evt: any, ctx) => {
    lastCtx = ctx;
    const rawPrompt = String(evt?.prompt ?? "");
    currentPrompt = normalizePromptForDisplay(rawPrompt);
    const promptImages = normalizePromptImages(evt?.images, rawPrompt);
    currentPromptImages = promptImages.images;
    currentPromptImageCount = promptImages.count;
  });

  pi.on("agent_start", async (_evt, ctx) => {
    lastCtx = ctx;
    inAgent = true;
    activeToolCount = 0;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    await sendUpdate("thinking", "", { resetTimer: true });
  });

  pi.on("message_update", async (_evt, ctx) => {
    lastCtx = ctx;
    if (activeToolCount === 0 && inAgent) {
      await sendUpdate("thinking", "");
    }
  });

  pi.on("tool_execution_start", async (evt, ctx) => {
    lastCtx = ctx;
    activeToolCount++;
    const upd = toolToIsland(evt.toolName, (evt as any).args);
    await sendUpdate(upd.status, upd.detail ?? "");
  });

  pi.on("tool_execution_end", async (evt, ctx) => {
    lastCtx = ctx;
    activeToolCount = Math.max(0, activeToolCount - 1);
    if ((evt as any).isError) {
      await sendUpdate("error", (evt as any).toolName);
      setTimeout(async () => {
        if (inAgent && activeToolCount === 0) await sendUpdate("thinking", "");
      }, 1500);
      return;
    }
    if (activeToolCount === 0 && inAgent) {
      await sendUpdate("thinking", "");
    }
  });

  pi.on("agent_end", async (_evt, ctx) => {
    lastCtx = ctx;
    inAgent = false;
    if (startedAt != null) frozenElapsed = Date.now() - startedAt;
    await sendUpdate("done", "");
    // Done rows are no longer hoverable; show the centered completion
    // confirmation briefly, then retract before the stopped loader can linger.
    if (hideTimer) clearTimeout(hideTimer);
    const hideDelay = currentPromptImageCount > 0 ? DONE_HIDE_WITH_IMAGES_MS : DONE_HIDE_MS;
    hideTimer = setTimeout(async () => { await sendRemove(); }, hideDelay);
  });

  // ── /island command ──────────────────────────────────────────────────────
  //
  //   /island                   → open settings menu (canonical)
  //   /island on | enable       → show + persist
  //   /island off | disable     → hide + persist
  //   /island toggle            → flip current visibility
  //   /island size <preset>     → set scale (small | medium | large)
  //   /island screen <value>    → set screen (primary | active | 2 | 3 ...)
  //   /island notch <mode>      → set notch wrap (auto | normal | notch)
  //   /island prompt <on|off>   → reveal prompt on row hover
  //
  // Subcommands let power users / scripts skip the menu. With no args the
  // menu is the friendlier path — same UX as pi's own /settings.
  pi.registerCommand("island", {
    description: "Open pi-island settings (or /island size|screen|notch|prompt <value>)",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        await openSettingsMenu(ctx);
        return;
      }
      const sub = parts[0]?.toLowerCase();

      if (sub === "on" || sub === "enable") { await doEnable(ctx);  return; }
      if (sub === "off" || sub === "disable") { await doDisable(ctx); return; }
      if (sub === "toggle") {
        if (shownForSession) await doDisable(ctx); else await doEnable(ctx);
        return;
      }
      if (sub === "reload" || sub === "reset") {
        await reloadCompanion(ctx);
        return;
      }

      if (sub === "size") {
        const next = parts[1]?.toLowerCase();
        if (!next) {
          ctx.ui.notify(`Size: ${currentScale} — try /island size <${SCALES.join("|")}>`, "info");
          return;
        }
        if (!isScale(next)) {
          ctx.ui.notify(`Unknown size "${next}". Use one of: ${SCALES.join(", ")}`, "error");
          return;
        }
        await doSetScale(next, ctx);
        return;
      }

      if (sub === "screen") {
        const next = parts[1]?.toLowerCase();
        if (!next) {
          ctx.ui.notify(
            `Screen: ${currentScreen} — try /island screen <primary|active|2|3|...>`,
            "info",
          );
          return;
        }
        if (!isScreen(next)) {
          ctx.ui.notify(
            `Unknown screen "${next}". Use: primary, active, or a monitor index (1..N)`,
            "error",
          );
          return;
        }
        await doSetScreen(next, ctx);
        return;
      }

      if (sub === "notch") {
        const next = parts[1]?.toLowerCase();
        if (!next) {
          ctx.ui.notify(
            `Notch wrap: ${currentNotchMode} — try /island notch <${NOTCH_MODES.join("|")}>`,
            "info",
          );
          return;
        }
        if (!isNotchMode(next)) {
          ctx.ui.notify(
            `Unknown notch mode "${next}". Use one of: ${NOTCH_MODES.join(", ")}`,
            "error",
          );
          return;
        }
        await doSetNotchMode(next, ctx);
        return;
      }

      if (sub === "prompt" || sub === "prompt-hover" || sub === "prompthover") {
        const next = parts[1]?.toLowerCase();
        if (!next) {
          ctx.ui.notify(
            `Prompt hover: ${currentPromptHover ? "enabled" : "disabled"} — try /island prompt <on|off|toggle>`,
            "info",
          );
          return;
        }
        if (next === "toggle") {
          await doSetPromptHover(!currentPromptHover, ctx);
          return;
        }
        const enabled = parseToggle(next);
        if (enabled == null) {
          ctx.ui.notify(
            `Unknown prompt hover value "${next}". Use: on, off, enabled, disabled, or toggle`,
            "error",
          );
          return;
        }
        await doSetPromptHover(enabled, ctx);
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand "${sub}". Try: /island (menu)  or  /island size|screen|notch|prompt|reload <value>`,
        "error",
      );
    },
  });
}
