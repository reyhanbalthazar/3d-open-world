import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

// LAN addresses of this machine, so other laptops opening http://<ip>:3000 can load dev assets.
const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((info) => info && info.family === "IPv4" && !info.internal)
  .map((info) => info!.address);

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: lanAddresses,
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
