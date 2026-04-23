// Platform abstraction helpers for pi-island.
// Centralizes all OS-specific logic so companion.mjs and index.ts
// stay clean. Each function returns the same shape regardless of
// platform — callers never branch on process.platform directly.

import { execSync } from "node:child_process";

// ── Supported platforms ────────────────────────────────────────────────────
export const SUPPORTED_PLATFORMS = new Set(["darwin", "win32"]);

export function isSupported() {
  return SUPPORTED_PLATFORMS.has(process.platform);
}

// ── Screen geometry ────────────────────────────────────────────────────────
// Returns { x, y, w, h, notch } for the target screen.
// x/y are the screen's origin in GLOBAL coordinates (OS-native system).
// notch is the safe-area-insets top (macOS only, 0 on Windows).

function getScreenGeometry_darwin(screenPref) {
  try {
    // Build the JXA screen selector (same logic extracted from companion.mjs)
    let selector;
    if (screenPref === "active") {
      selector =
        "const mouse = $.NSEvent.mouseLocation;" +
        "const all = $.NSScreen.screens.js;" +
        "for (const scr of all) {" +
        "  const f = scr.frame;" +
        "  if (mouse.x >= f.origin.x && mouse.x < f.origin.x + f.size.width &&" +
        "      mouse.y >= f.origin.y && mouse.y < f.origin.y + f.size.height) {" +
        "    s = scr; break;" +
        "  }" +
        "}" +
        "if (!s) s = $.NSScreen.mainScreen;";
    } else {
      const idx = parseInt(screenPref, 10);
      if (Number.isFinite(idx) && idx >= 1) {
        selector =
          "const all = $.NSScreen.screens.js;" +
          `s = all[${idx - 1}] || all[0];`;
      } else {
        selector = "s = $.NSScreen.screens.js[0];";
      }
    }

    const script =
      "ObjC.import('AppKit');" +
      "let s = null;" +
      selector +
      "if (!s || !s.frame) s = $.NSScreen.screens.js[0];" +
      "const f = s.frame;" +
      "const sa = (s.safeAreaInsets && s.safeAreaInsets.top) || 0;" +
      "JSON.stringify({x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height, notch: sa})";
    const out = execSync(`osascript -l JavaScript -e ${JSON.stringify(script)}`, {
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    const j = JSON.parse(out);
    if (Number.isFinite(j.w) && Number.isFinite(j.h)) {
      return {
        x:     Math.round(j.x || 0),
        y:     Math.round(j.y || 0),
        w:     Math.round(j.w),
        h:     Math.round(j.h),
        notch: Math.round(j.notch || 0),
      };
    }
  } catch { /* fall through */ }
  return { x: 0, y: 0, w: 1440, h: 900, notch: 0 };
}

function getScreenGeometry_win32(screenPref) {
  try {
    // PowerShell probe using System.Windows.Forms.Screen.
    // Returns primary screen by default; "active" returns the screen
    // under the mouse cursor; numeric index picks by position.
    let psFilter;
    if (screenPref === "active") {
      // Get cursor position, find which screen contains it
      psFilter =
        "$pos = [System.Windows.Forms.Cursor]::Position; " +
        "$scr = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.Contains($pos) } | Select-Object -First 1; " +
        "if (-not $scr) { $scr = [System.Windows.Forms.Screen]::PrimaryScreen }";
    } else {
      const idx = parseInt(screenPref, 10);
      if (Number.isFinite(idx) && idx >= 1) {
        psFilter =
          "$all = [System.Windows.Forms.Screen]::AllScreens; " +
          `$scr = if ($all.Length -ge ${idx}) { $all[${idx - 1}] } else { $all[0] }`;
      } else {
        // "primary" or unknown
        psFilter = "$scr = [System.Windows.Forms.Screen]::PrimaryScreen";
      }
    }

    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      psFilter + "; " +
      "$b = $scr.Bounds; " +
      "$wa = $scr.WorkingArea; " +
      "ConvertTo-Json @{ x=$b.X; y=$b.Y; w=$b.Width; h=$b.Height; taskbarH=$b.Height-$wa.Height }";

    const out = execSync(
      `powershell -NoProfile -NoLogo -Command "${script.replace(/"/g, '\\"')}"`,
      { encoding: "utf8", timeout: 2000 },
    ).trim();
    const j = JSON.parse(out);
    if (Number.isFinite(j.w) && Number.isFinite(j.h)) {
      return {
        x:     Math.round(j.x || 0),
        y:     Math.round(j.y || 0),
        w:     Math.round(j.w),
        h:     Math.round(j.h),
        notch: 0,  // Windows has no notch
      };
    }
  } catch { /* fall through */ }
  return { x: 0, y: 0, w: 1920, h: 1080, notch: 0 };
}

export function getScreenGeometry(screenPref) {
  if (process.platform === "darwin") return getScreenGeometry_darwin(screenPref);
  if (process.platform === "win32")  return getScreenGeometry_win32(screenPref);
  return { x: 0, y: 0, w: 1920, h: 1080, notch: 0 };
}

// ── Window position ────────────────────────────────────────────────────────
// Computes the (x, y) origin for the host window given screen geometry.
//
// macOS (Cocoa): origin = bottom-left, y increases upward.
//   Window top edge = screenY + screenH - winH
//
// Windows (Win32): origin = top-left, y increases downward.
//   Window top edge = screenY (which is 0 for primary, or negative for
//   screens above the primary).

export function computeWindowPosition(screenGeo, winW, winH) {
  const x = Math.round(screenGeo.x + (screenGeo.w - winW) / 2);

  if (process.platform === "win32") {
    return { x, y: screenGeo.y };
  }
  // macOS: Cocoa bottom-left origin
  return { x, y: Math.round(screenGeo.y + screenGeo.h - winH) };
}

// ── Screen count ───────────────────────────────────────────────────────────
// Used by the settings menu to build the Screen dropdown.

export function getScreenCount() {
  try {
    if (process.platform === "darwin") {
      const out = execSync(
        `osascript -l JavaScript -e "ObjC.import('AppKit'); $.NSScreen.screens.js.length"`,
        { encoding: "utf8", timeout: 1500 },
      ).trim();
      const n = parseInt(out, 10);
      if (Number.isFinite(n) && n >= 1) return Math.min(n, 9);
    }
    if (process.platform === "win32") {
      const out = execSync(
        `powershell -NoProfile -NoLogo -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Length"`,
        { encoding: "utf8", timeout: 2000 },
      ).trim();
      const n = parseInt(out, 10);
      if (Number.isFinite(n) && n >= 1) return Math.min(n, 9);
    }
  } catch { /* fall through */ }
  return 1;
}

// ── Notch mode resolution ──────────────────────────────────────────────────
// Given user pref and detected notch height, resolve to "normal" or "notch".
// Windows always returns "normal" (no notch hardware exists).

export function resolveNotchMode(notchPref, notchH) {
  if (process.platform === "win32") return "normal";
  if (notchPref === "normal") return "normal";
  if (notchPref === "notch")  return "notch";
  // "auto" — detect from hardware
  return notchH > 0 ? "notch" : "normal";
}
