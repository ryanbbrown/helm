import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: resolve("../..")
  },
  transpilePackages: ["@helm/core"]
};

export default nextConfig;
