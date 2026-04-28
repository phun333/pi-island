import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The web app lives inside a monorepo-like layout (repo root holds the
  // npm package, /web holds the site). Set Turbopack's root to the repo
  // root so we can import the package.json one level up (used by the
  // sidebar to surface the published version).
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
