/**
 * persistent-memory-api — request identity + tenant-scope hooks (Phase 3).
 *
 * TWO `onRequest` hooks on the SECURED plugin scope (registered in this order in
 * app.ts):
 *
 *   1. authenticate (ASYNC) — derives the server-side identity from the Bearer
 *      token (deny-by-default: any failure throws AuthError → 401) and stashes it
 *      on `request.identity`. It does NOT touch the AsyncLocalStorage store.
 *
 *   2. enterTenantScope (SYNC) — reads the now-set `request.identity` and calls
 *      `tenantStore.enterWith(ctx)` with NO preceding await, so the store
 *      propagates to the preHandler guards and the route handler (where
 *      `runInTenant()` reads it to set the per-request RLS GUCs).
 *
 * Why the work is split across two hooks (the load-bearing gotcha): entering the
 * ALS scope CANNOT live in `authenticate`, because that hook `await`s
 * deriveIdentity() first. Calling `enterWith()` in a continuation entered AFTER an
 * `await` does NOT keep the store alive for the rest of the request under
 * Fastify+Node — the remaining pipeline was already scheduled on the PRE-await
 * async context, so `getStore()` returns undefined in the handler. Confirmed live
 * (a data-plane 500: "No tenant context"). The fix: derive identity asynchronously,
 * then enter the scope in a SEPARATE, fully synchronous hook with no await before
 * the `enterWith()` call.
 *
 * Why enterWith and NOT als.run(ctx, fn): `als.run` only carries the store for code
 * lexically inside `fn`; a hook that calls als.run and returns does not keep the
 * store alive for the handler (a later async tick outside that run). `enterWith`
 * sets the store for the current async execution AND all subsequent continuations
 * on this logical request — Fastify's one-async-context-per-request model — which
 * is exactly why `enterTenantScope` must be synchronous (no await may precede it).
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import { deriveIdentity } from './token-service.ts'
import { tenantStore } from '@pm/db'
import { unauthorized } from '../authz/errors.ts'
import { localIdentity } from './local-mode.ts'

/**
 * enterTenantScope — SYNCHRONOUS onRequest hook, registered immediately AFTER
 * `authenticate`. It reads the already-derived req.identity and calls
 * tenantStore.enterWith() with NO preceding await, so the store propagates to the
 * preHandler guards and the route handler. This is the half of the fix that
 * authenticate() can no longer do (see the note in authenticate()).
 */
export function enterTenantScope(
  req: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  if (req.identity) tenantStore.enterWith(req.identity)
  done()
}

export async function authenticate(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const identity = await deriveIdentity(req.headers.authorization)
  if (!identity) {
    // NOTE: never include req.headers.authorization in the message/log.
    throw unauthorized(
      'Invalid, expired, or revoked token. Re-issue from the dashboard webapp and ' +
        'update PM_USER_TOKEN, then send Authorization: Bearer <tokenId>.<secret>.',
      'invalid_token',
    )
  }
  req.identity = identity
  // NOTE: enterWith() must NOT be called here. This is an async hook that has
  // already awaited deriveIdentity() above; calling enterWith() in a continuation
  // entered AFTER an await does NOT propagate the store to the route handler under
  // Fastify+Node (the rest of the pipeline was scheduled on the pre-await async
  // context). The ALS scope is instead entered SYNCHRONOUSLY by enterTenantScope
  // (a separate sync onRequest hook registered after this one) — see app.ts.
}

/**
 * authenticateLocal — the DEPLOYMENT_MODE=local replacement for `authenticate`
 * (Phase 13). Reads the local DB-backed identity with NO token check, SAME
 * contract (stash on req.identity; enterTenantScope enters the ALS scope after).
 * app.ts selects this hook ONLY when config.DEPLOYMENT_MODE==='local', at boot —
 * so in server mode it is never registered and token auth is unchanged.
 */
export async function authenticateLocal(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  req.identity = await localIdentity()
}
