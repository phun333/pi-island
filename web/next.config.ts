import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The web app lives inside a monorepo-like layout (repo root holds the
  // npm package, /web holds the site). Tell Next/Turbopack the correct root.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
