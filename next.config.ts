import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Don't advertise the framework (03 §11).
  poweredByHeader: false,
  // User files must never pass through the web server (TD-07, DEC-009), and
  // sharp builds are disabled in pnpm-workspace.yaml. Images are served as-is.
  images: { unoptimized: true },
};

export default nextConfig;
