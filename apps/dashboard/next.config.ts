import type { NextConfig } from "next"

/**
 * The dashboard is a pure HTTP client of `mik serve`: it never opens the SQLite
 * file itself. Everything that reaches the server goes through `MIK_SERVER_URL`
 * (see `lib/config.ts`), server side only.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Server components stream; the SSE proxy must never be statically rendered.
  poweredByHeader: false,
}

export default nextConfig
