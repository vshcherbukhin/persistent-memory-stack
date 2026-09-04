/**
 * Fastify module augmentation — attach the server-derived identity to the
 * request for ergonomic, typed access in handlers and guards.
 *
 * `identity` is set by the authenticate hook on the secured plugin scope. It is
 * optional on the type because the hook only populates it after a successful
 * token verify; guards and handlers behind the hook can rely on it being
 * present (the hook throws AuthError otherwise, short-circuiting the request).
 */
import type { TenantCtx } from '@pm/db'

declare module 'fastify' {
  interface FastifyRequest {
    identity?: TenantCtx
  }
}

export {}
