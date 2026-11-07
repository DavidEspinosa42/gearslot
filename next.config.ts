import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  typedRoutes: true,
  poweredByHeader: false,
  reactStrictMode: true,
  // Keep AGENTS.md hand-written; do not let `next dev` append generated rules to it.
  agentRules: false,
  devIndicators: false,
};

export default nextConfig;
