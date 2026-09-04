/**
 * @pm/shared/queue — BullMQ connection options.
 *
 * We pass a connection-OPTIONS object to BullMQ (not a pre-built ioredis client):
 * BullMQ nests its OWN ioredis copy, so handing it a Redis instance built from
 * the root ioredis trips a dual-package type clash. Letting BullMQ construct the
 * client from options sidesteps that AND lets us set the two mandatory worker
 * flags:
 *   • maxRetriesPerRequest:null — MANDATORY for BullMQ workers (blocking
 *     BRPOPLPUSH; ioredis would otherwise abort the blocking command).
 *   • enableReadyCheck:false — avoids a boot race when redis lags the consumer.
 * The redis service is configured maxmemory-policy noeviction in compose — BullMQ
 * REQUIRES it or jobs get evicted under memory pressure (do not regress it).
 *
 * For the worker heartbeat (a Redis key refreshed each tick, probed by the
 * compose healthcheck) the worker builds its OWN ioredis client directly — that
 * use has no BullMQ type coupling.
 */
import { type ConnectionOptions } from 'bullmq'

/** Build BullMQ connection options from a redis:// URL + the mandatory flags. */
export function makeIngestConnection(
  redisUrl: string | undefined = process.env.REDIS_URL,
): ConnectionOptions {
  if (!redisUrl) throw new Error('REDIS_URL must be set for the BullMQ connection.')
  const u = new URL(redisUrl)
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }
}

export type { ConnectionOptions }
