// Unix socket path shared by the companion process and all pi extension
// clients. One socket per user; lives under ~/.pi/ which is already
// user-scoped so there's no permission conflict.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const dir = join(homedir(), ".pi");
try { mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }

export const SOCK = join(dir, "pi-island.sock");
