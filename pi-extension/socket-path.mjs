// IPC path shared by the companion process and all pi extension clients.
//
// macOS / Linux: Unix domain socket at ~/.pi/pi-island.sock
// Windows:       Named pipe at \\.\pipe\pi-island
//
// Node.js net module handles both transparently — callers just use SOCK
// with net.connect() / net.createServer() and never branch on platform.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

if (process.platform !== "win32") {
  // Unix sockets live on the filesystem — ensure the directory exists.
  // Named pipes on Windows are kernel objects; no directory needed.
  const dir = join(homedir(), ".pi");
  try { mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
}

// Node.js on Windows needs forward-slash named pipe paths (//./pipe/name).
// The backslash form (\\.\pipe\name) causes EACCES in some environments.
export const SOCK = process.platform === "win32"
  ? "//./pipe/pi-island"
  : join(homedir(), ".pi", "pi-island.sock");
