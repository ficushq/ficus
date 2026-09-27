# Local K8s Development with k3d

How the local development environment works, how it differs from a real cluster, and how to debug it. This is the `k8s` sandbox runtime run locally; see [sandbox-runtimes.md](../sandbox-runtimes.md) if you have not chosen a runtime yet.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ macOS Host                                                      │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ tau-api   │  │tau-worker│  │   Postgres   │  │  Vite dev  │  │
│  │ (bun)    │  │ (bun)    │  │ (docker-     │  │  server    │  │
│  │ :62832   │  │ :62833   │  │  compose)    │  │  :5173     │  │
│  └────┬─────┘  └────┬─────┘  └──────────────┘  └────────────┘  │
│       │              │                                          │
│       └──────┬───────┘                                          │
│              │                                                  │
│    kubectl port-forward                                         │
│    localhost:<random> → pod:50051                                │
│              │                                                  │
│  ┌───────────┼──────────────────────────────────────────────┐   │
│  │ k3d (k3s-in-Docker)                           OrbStack  │   │
│  │           │                                              │   │
│  │  ┌────────┼─────────────────────────────────┐            │   │
│  │  │ tau-sandboxes-dev namespace               │            │   │
│  │  │        │                                  │            │   │
│  │  │  ┌─────▼───────┐    ┌─────────────┐      │            │   │
│  │  │  │ squad-abc   │    │ squad-xyz   │      │            │   │
│  │  │  │ (pod)       │    │ (pod)       │      │            │   │
│  │  │  │             │    │             │      │            │   │
│  │  │  │ sandbox     │    │ sandbox     │      │            │   │
│  │  │  │ HTTP :50051 │    │ HTTP :50051 │      │            │   │
│  │  │  │             │    │             │      │            │   │
│  │  │  │ dockerd     │    │ dockerd     │      │            │   │
│  │  │  │ (DinD)      │    │ (DinD)      │      │            │   │
│  │  │  └──────┬──────┘    └──────┬──────┘      │            │   │
│  │  │         │                  │              │            │   │
│  │  │         └────────┬─────────┘              │            │   │
│  │  │                  │                        │            │   │
│  │  │     host.k3d.internal → macOS host        │            │   │
│  │  │     (via --host-alias at cluster create)  │            │   │
│  │  └──────────────────────────────────────────-┘            │   │
│  │                                                           │   │
│  │  hostPath volume: ~/.tau → /tau-data                      │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ~/.tau/                                                        │
│    workspaces/squads/{id}/   ← mounted as /workspace in pods    │
│    memory/{id}/              ← mounted as /memory               │
│    ssh/{id}/                 ← mounted as /var/lib/tau/ssh-source │
│    nix/{id}/                 ← mounted as /nix-cache            │
└─────────────────────────────────────────────────────────────────┘
```

## How It Differs from a Real Cluster

k3d is the `k8s` runtime run locally, so this table compares it to the same
runtime on a real cluster. It is **not** a comparison with "production" in
general: today's production shape is a single-VM core with the `vm` runtime,
and Kubernetes is the escalation tier (see [hosting.md](../hosting.md)).

If you only want agents working locally and do not care about cluster-shaped
behavior, the cheaper option is the `host` runtime — no cluster, no images, no
port-forwards ([host-runtime.md](../host-runtime.md)); or `docker-socket` for
containers without a cluster. [sandbox-runtimes.md](../sandbox-runtimes.md)
compares all five.

| Aspect                 | Local Dev (k3d)                             | Cluster (`k8s` runtime)                 |
| ---------------------- | ------------------------------------------- | --------------------------------------- |
| **API/Worker**         | Run on host via bun/PM2                     | K8s pods in `tau-core` namespace        |
| **Database**           | docker-compose on host                      | Managed RDS/Aurora                      |
| **Pod → API routing**  | `host.k3d.internal` (via `--host-alias`)    | In-cluster DNS (`tau-api.tau-core.svc`) |
| **API → Pod routing**  | `kubectl port-forward` (auto-managed)       | Headless service DNS                    |
| **Storage**            | hostPath (`~/.tau/`)                        | EFS with access points                  |
| **DinD isolation**     | Privileged mode                             | Sysbox runtime class                    |
| **Docker storage**     | `emptyDir` volume at `/var/lib/docker`      | Sysbox manages storage                  |
| **TLS**                | Disabled (`NODE_TLS_REJECT_UNAUTHORIZED=0`) | Proper CA chain                         |
| **Sandbox image arch** | Native (arm64 on Apple Silicon)             | amd64                                   |
| **Kubeconfig**         | Token-based context (`k3d-tau-dev-token`)   | In-cluster service account              |

## Key Design Decisions

### Port-Forward Bridge

On a real cluster, Core talks to sandbox pods via headless service DNS (`<pod>.tau-sandboxes.<ns>.svc.cluster.local`). This doesn't work from the host because the host isn't inside the cluster network.

Instead, the `K8sPodManager` automatically manages `kubectl port-forward` processes when `FICUS_K8S_LOCAL=true`. Each sandbox gets a random free port on localhost, and the manager tracks the mapping in memory.

**On API restart**, the port-forward processes die (they're child processes). The `getSandboxStatus()` path re-establishes them when it calls `ensurePortForward()`. The `getPodEndpoint()` method checks both the `pods` map and the `portForwards` map directly, so it works even when the pods map is empty after a restart.

### host.k3d.internal Routing

Sandbox pods need to reach the host API (for the Ficus CLI). The k3d cluster is created with `--host-alias` to map `host.k3d.internal` to the correct host IP:

- **OrbStack**: Uses OrbStack's magic IP (e.g. `0.250.250.254`), resolved by running `getent hosts host.docker.internal` inside a container at setup time.
- **Docker Desktop**: Uses the `host-gateway` IP, resolved similarly.

The `k3d-dev.sh setup` script detects which Docker provider (OrbStack or Docker Desktop) is running and picks the right IP. This is unrelated to `FICUS_SANDBOX_RUNTIME`, which is never detected — see [sandbox-runtimes.md](../sandbox-runtimes.md).

**Why not `host.docker.internal` directly?** It works on OrbStack but isn't guaranteed on all setups. Using `host.k3d.internal` via `--host-alias` gives us explicit control over the mapping.

### API Bind Address

When `FICUS_K8S_LOCAL=true`, the API binds to `0.0.0.0` instead of `localhost`. This is required because connections from k3d pods arrive on the host's external interface, not loopback. See `apps/core/src/index.ts`.

### Privileged Mode for DinD

A real cluster uses the [sysbox](https://github.com/nestybox/sysbox) runtime class for secure, unprivileged Docker-in-Docker. Sysbox isn't available in k3d.

For local dev, pods run with `securityContext: { privileged: true }` when `IS_LOCAL_DEV && !runtimeClass`. This allows the inner `dockerd` to start and function normally. The `emptyDir` volume at `/var/lib/docker` prevents nested overlayfs failures (overlayfs-on-overlayfs is not supported).

### Cached devbox shellenv

Running `devbox shellenv` on every bash command corrupts the container filesystem in privileged k3d pods — specifically, `/usr/bin` disappears after the first or second invocation. The exact mechanism involves Nix store operations interacting badly with overlayfs in privileged containers.

**Solution**: The sandbox server captures `devbox shellenv --init-hook` output once when `/devbox-ready` is signaled, caches it in memory, and inlines the cached exports into each bash command's preamble. See `packages/k8s-sandbox/src/services/devbox-env.ts`.

This doesn't occur on a sysbox-backed cluster, which provides proper filesystem isolation.

### Token-Based Kubeconfig

Bun's HTTP/2 client doesn't pass client certificates correctly through the `@kubernetes/client-node` HTTPS agent. Since k3d's default kubeconfig uses client-cert auth, API calls fail silently.

The setup script creates a service account (`tau-dev`) with a long-lived token and configures a dedicated kubectl context (`k3d-tau-dev-token`). The `loadKubeConfig()` function in `kubeconfig.ts` explicitly sets this context when `FICUS_K8S_LOCAL=true`, so it works regardless of which kubectl context is active on the host.

### Native Architecture

On Apple Silicon, the sandbox image is built for `linux/arm64` (native). OrbStack's Rosetta translation works for the k3d node itself but does **not** propagate into nested containers (pods inside k3d). Building amd64 images causes segfaults and missing binary errors inside pods.

Cluster images are built for `linux/amd64` in CI.

## Setup

```bash
bun run k3d:setup
```

This runs `scripts/k3d-dev.sh setup` which:

1. Installs k3d via Homebrew if missing
2. Detects Docker runtime (OrbStack vs Docker Desktop) for host IP
3. Creates a k3d cluster with `~/.tau/` as a hostPath volume and `host.k3d.internal` host-alias
4. Creates namespace, headless service, PV/PVC
5. Creates a service account with token auth and configures kubectl context
6. Builds the sandbox image for native arch and imports it into k3d

Configure `.env`:

```bash
FICUS_SANDBOX_RUNTIME=k8s
FICUS_K8S_LOCAL=true
FICUS_K8S_NAMESPACE=tau-sandboxes-dev
FICUS_K8S_RUNTIME_CLASS=
```

## Day-to-Day Commands

| Command                | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `bun run k3d:start`    | Resume a stopped cluster                              |
| `bun run k3d:stop`     | Pause the cluster (preserves state, saves resources)  |
| `bun run k3d:status`   | Show cluster health, pods, PVC                        |
| `bun run k3d:pods`     | List sandbox pods                                     |
| `bun run k3d:logs`     | Tail sandbox pod logs                                 |
| `bun run k3d:shell`    | Shell into a sandbox pod                              |
| `bun run k3d:kill`     | Kill sandbox pods (recreated on next use)             |
| `bun run k3d:import`   | Rebuild sandbox image and import into k3d             |
| `bun run k3d:teardown` | Delete cluster entirely (data in `~/.tau/` preserved) |

## Rebuilding the Sandbox Image

CLI-only changes do not require `k3d:import`: build the CLI with `bun run build:cli`, then recreate sandbox pods if they need the refreshed `/usr/local/bin/ficus` mount.

After changing code in `packages/k8s-sandbox/`:

```bash
# Build and import in one step
bun run k3d:import

# Then kill existing pods so they pick up the new image
bun run k3d:kill
```

The pod will be recreated automatically on next use (via the reconciliation loop or agent activity).

## Troubleshooting

### Pod Can't Reach Host API

**Symptoms:** Ficus CLI inside sandbox fails with "Unable to connect".

```bash
# Verify from inside the pod
kubectl -n tau-sandboxes-dev exec <pod> -- curl -v http://host.k3d.internal:62832/api/health
```

**Checks:**

1. **API bound to 0.0.0.0?** — `lsof -iTCP:62832 -sTCP:LISTEN -P` should show `*:62832`, not `localhost:62832`. Ensure `FICUS_K8S_LOCAL=true` is set.
2. **host.k3d.internal resolves?** — If DNS fails, the CoreDNS `NodeHosts` configmap may be missing the entry. Teardown and re-setup the cluster (`bun run k3d:teardown && bun run k3d:setup`).
3. **Correct IP?** — On OrbStack, `host.k3d.internal` should resolve to OrbStack's magic IP (e.g. `0.250.250.254`), not `127.0.0.1` or the Docker bridge gateway.

### Port-Forward Fails After API Restart

**Symptoms:** "No active port-forward for pod" warnings, sandbox health checks fail.

Port-forward processes are children of the API process — they die on restart. The status check path re-establishes them automatically, but it may take one polling cycle (~5s). If it persists:

```bash
# Check for orphaned port-forwards
ps aux | grep "kubectl port-forward" | grep -v grep

# Kill the pod to force a clean re-creation
bun run k3d:kill
```

### /usr/bin Disappears in Pod

**Symptoms:** Commands fail with `ENOENT: posix_spawn '/usr/bin/bash'` after working once.

This is the devbox shellenv corruption issue. It should not happen with the cached shellenv approach. If it does:

1. Check that `/devbox-ready` was received — look for `Cached devbox shellenv (XXXXX bytes)` in pod logs.
2. Verify `bash.ts` is using `getDevboxShellEnv()` instead of running `devbox shellenv` directly.
3. Rebuild the sandbox image: `bun run k3d:import && bun run k3d:kill`.

### Docker-in-Docker Fails

**Symptoms:** `dockerd` errors about overlay mounts, "invalid argument".

```bash
# Check pod has the emptyDir volume
kubectl -n tau-sandboxes-dev get pod <pod> -o jsonpath='{.spec.volumes}' | python3 -m json.tool | grep docker-storage
```

The pod must have an `emptyDir` volume mounted at `/var/lib/docker`. Without it, the inner dockerd tries overlayfs-on-overlayfs which fails. If missing, restart the API (the volume is added in `pod-manager.ts`) and kill the pod.

### 401 Unauthorized from K8s API

**Symptoms:** API logs show `HTTP-Code: 401 Message: Unauthorized`.

The API uses token-based auth via the `k3d-tau-dev-token` kubectl context. If the token expired or the context was deleted:

```bash
# Recreate the token
kubectl -n tau-sandboxes-dev create token tau-dev --duration=87600h

# Update kubeconfig
kubectl config set-credentials tau-dev-token --token="<new-token>"
```

Or teardown and re-setup: `bun run k3d:teardown && bun run k3d:setup`.

The API explicitly sets the `k3d-tau-dev-token` context in `kubeconfig.ts` when `FICUS_K8S_LOCAL=true`, so switching kubectl contexts on the host does not affect the API.

### Image Not Updating After Rebuild

k3d caches images. If `bun run k3d:import` doesn't seem to pick up changes:

```bash
# Force no-cache rebuild
docker build --no-cache -t tau-sandbox:latest -f packages/k8s-sandbox/Dockerfile .
bun run k3d:import
bun run k3d:kill
```

The pod spec uses `imagePullPolicy: Never` (since the image is imported directly, not pulled from a registry).

### Cluster Won't Start

```bash
# Check Docker is running
docker info

# Check k3d cluster state
k3d cluster list

# If corrupted, teardown and recreate
bun run k3d:teardown
bun run k3d:setup
```

Data in `~/.tau/` is preserved across teardowns — only the cluster state is lost.

## Related Docs

- [Architecture](architecture.md) — K8s sandbox architecture
- [Sandbox](sandbox.md) — Sandbox HTTP API reference
- [Troubleshooting](troubleshooting.md) — Cluster troubleshooting
- [Volumes](volumes.md) — Storage architecture (EFS on a real cluster)
