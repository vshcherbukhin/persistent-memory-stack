/**
 * Deployment mode for the dashboard (Phase 13, #Part5).
 *
 * `local` = the single-user, NO-AUTH stack: the dashboard skips login and treats
 * the visitor as the sole super-user (the api injects the same identity server-side).
 * `server` (default) = full token auth.
 *
 * Read from DEPLOYMENT_MODE. CRITICAL for Next.js: middleware runs in the Edge
 * runtime where `process.env` is INLINED AT BUILD TIME — so the dashboard image must be
 * BUILT with DEPLOYMENT_MODE set (a docker build ARG → ENV before `next build`; the
 * onboard full-local flow does this). It is therefore a build/deploy-time pin, never
 * runtime-flippable — switching modes requires a rebuild, which is correct (mode is a
 * deploy decision). Server-side reads (session.ts) see the same value at runtime.
 */
export const isLocalMode: boolean = process.env.DEPLOYMENT_MODE === 'local'
