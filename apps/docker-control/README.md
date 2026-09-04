# persistent-memory-docker-control

A tiny, security-gated sidecar that backs the dashboard **Services** page. It is the
**only** process in the stack that touches the Docker socket — so the large
`persistent-memory-api` surface never gets host-root-equivalent access.

## Why it exists

The Services page needs to list the stack's containers and per-client MCP
containers, tail logs, and start / stop / restart real stack services. The naive
way is to mount `/var/run/docker.sock` into the
API — but the socket is **host-root-equivalent**, and the API is a big,
network-exposed, auth-handling surface. Instead we isolate the socket in this
minimal process and put a **security gate** in front of it.

## The security model (two halves)

1. **Verb boundary + project/container-kind filter** (`src/docker.ts`): the only
   operations that exist in code are `list / logs / start / stop / restart /
   terminate`.
   List/logs are filtered to `com.docker.compose.project=persistent-memory` so the
   dashboard can show stack services and Docker-run MCP clients for this project.
   Start/stop/restart additionally require runtime Compose labels
   `com.docker.compose.config-hash` and `com.docker.compose.oneoff=False`, so
   per-client stdio MCP containers cannot be controlled as stack services.
   `terminate` is the one MCP lifecycle escape hatch: it requires an exact
   project-labeled MCP container id/name and stops only that stdio session.
   There is no code path that can create a container, `exec`, mount the host, or
   act on unrelated containers.
2. **Shared-secret gate + network isolation** (`src/server.ts`,
   `deploy/compose/docker-compose.yml`): every request needs `Authorization: Bearer
   $DOCKER_CONTROL_TOKEN` (constant-time compare, **fails closed** when the token
   is empty), and the service publishes **no host port** — it is reachable only on
   the internal compose network.

RBAC stays in the API (read = any authenticated user, mutate = superuser). The
browser never talks to this service directly; it goes `dashboard → API → docker-control`.

## HTTP surface (internal only)

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/health` | none | `{ ok: true }` (compose healthcheck) |
| `GET` | `/services` | Bearer | `{ services: ServiceInfo[] }` (this project only) |
| `GET` | `/services/:service/logs?tail=N` | Bearer | `{ service, logs }` (tail clamped 1..2000) |
| `POST` | `/services/:service/{start\|stop\|restart}` | Bearer | `{ ok: true }` |
| `POST` | `/services/:container/terminate` | Bearer | `{ ok: true }` for an exact MCP stdio container id/name |

Anything else → `400` (bad action) / `404` / `405`, never reaching the socket.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `DOCKER_CONTROL_TOKEN` | (empty ⇒ fails closed) | the shared secret the API must present |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | the mounted socket path |
| `DOCKER_COMPOSE_PROJECT` | `persistent-memory` | the label this service is scoped to |
| `PORT` | `9090` | internal listen port (no host mapping) |
| `DOCKER_GID` | `0` | supplementary group the container joins to read the socket (see below) |

## Container hardening

In addition to the token gate + verb boundary, the container itself is locked down
in `deploy/compose/docker-compose.yml`:

- **`no-new-privileges:true`** — no setuid escalation.
- **`cap_drop: [ALL]`** — it only opens a unix socket + listens on a high port, so
  it needs zero Linux capabilities.
- **`read_only: true` + `tmpfs: [/tmp]`** — the runtime rootfs is read-only; the
  TypeScript build happens in the separate Docker build stage. Verified: `/app`
  writes are blocked while the emitted JavaScript process still starts and serves.
- **`user: "node"` (uid 1000), not root** — least privilege for the one container
  holding the socket.

### The `DOCKER_GID` knob (non-root + socket access)

A non-root user can only read the socket if it's in the socket's group. **On Docker
Desktop** the in-container socket is `root:root` mode `660`, so supplementary
**group 0** grants access — hence `group_add: ["${DOCKER_GID:-0}"]` with the default
`0` works out of the box on Docker Desktop.

**On native Linux** the socket is usually `root:docker` (a non-zero gid), so group 0
does *not* match. Set `DOCKER_GID` to the host's docker-group gid before bringing the
stack up:

```bash
echo "DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)" >> .env.persistent-memory
```

If the gid doesn't match, the sidecar simply can't read the socket and the Services
page degrades to `503 docker_unavailable` — **fail-closed, never a crash**.

## Run / test

```bash
npm run build     # tsc -p tsconfig.build.json
npm start         # node dist/index.js
npm test          # vitest: the gate + router + parsers
npm run typecheck # tsc --noEmit
```

Zero runtime dependencies — `node:http` + `node:crypto` only. Shipped as a
container (`Dockerfile`); the socket is mounted **here and nowhere else**.
