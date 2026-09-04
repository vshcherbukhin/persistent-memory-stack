import type { NextConfig } from 'next'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * persistent-memory-dashboard — Next.js config.
 *
 * output: 'standalone' is REQUIRED for the Docker runner stage (the Dockerfile
 * copies .next/standalone + .next/static + public and runs `node server.js`).
 *
 * The dashboard app is self-contained (no @pm/* deps, build context = ./apps/dashboard).
 * Next 15.5 warns when it sees both the repo and dashboard lockfiles, so pin the
 * tracing root to this app directory explicitly.
 */
const dashboardRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: dashboardRoot,
  reactStrictMode: true,
  // The control-plane data is never cached/prerendered (authed, dynamic). We do
  // not declare any static output here; pages opt into dynamic via cookies().
}

export default nextConfig
