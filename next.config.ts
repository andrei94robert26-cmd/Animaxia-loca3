import type { NextConfig } from "next";

const BACKEND_PORT = process.env.ANIMAXIA_BACKEND_PORT || "4000";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  /**
   * Local-standalone mode: proxy /api/* to the Animaxia Express backend.
   * In the sandbox the Caddy gateway intercepts /api?XTransformPort=… first,
   * so these rewrites are a no-op there — they only matter when the frontend
   * is run on its own (e.g. from the platform ZIP: `bun run dev` on :3000
   * with the backend on :4000). ANIMAXIA_BACKEND_PORT overrides the target.
   */
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://localhost:${BACKEND_PORT}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
