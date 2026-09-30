# K8s Sandbox Architecture

System-level overview of how Ficus runs agent sandboxes on Kubernetes.

## Runtime Selection

Ficus supports five sandbox runtimes, selected via the required `FICUS_SANDBOX_RUNTIME` variable — see [Choosing a sandbox runtime](../sandbox-runtimes.md) for how to pick one. This document covers `k8s`:

| Runtime         | Use Case                              | Sandbox Mechanism             | Tool Execution                |
| --------------- | ------------------------------------- | ----------------------------- | ----------------------------- |
| `host`          | Personal machine, trusted single user | None — the core's own machine | Direct process spawn          |
| `docker-socket` | Dev on any Docker host, incl. macOS   | Docker containers (dockerode) | `docker exec` via spawn hooks |
| `docker-sysbox` | Linux dev/server with sysbox          | Docker containers (dockerode) | `docker exec` via spawn hooks |
| `vm`            | The hosted product; many agents       | Boxes (unix users) on VMs     | HTTP API over an SSH tunnel   |
| `k8s`           | Hard isolation, resource guarantees   | K8s pods in `tau-sandboxes`   | HTTP API to sandbox service   |

All of them implement the `ISandboxManager` interface (see `apps/core/src/services/sandbox/types.ts`). The factory in `factory.ts` returns the appropriate implementation based on the env var, and refuses to start when it is unset or unrecognized.

## System Overview

```
┌──────────────────────────────────────────────────────────────┐
│ K8s Cluster                                                  │
│                                                              │
│  ┌────────────────────────────────────────────┐              │
│  │ tau-core namespace                         │              │
│  │                                            │              │
│  │  ┌──────────┐        ┌──────────┐          │              │
│  │  │ tau-api  │        │tau-worker│          │              │
│  │  │ (1 rep)  │        │ (N reps) │          │              │
│  │  └────┬─────┘        └────┬─────┘          │              │
│  │       │                   │                │              │
│  │       └─────────┬─────────┘                │              │
│  │                 │                          │              │
│  │          K8sSandboxManager                 │              │
│  │          K8sPodManager                     │              │
│  └─────────────────┼─────────────────────────-┘              │
│                    │                                         │
│                    │ HTTP (port 50051)                        │
│                    │ DNS: <pod>.tau-sandboxes.<ns>.svc        │
│                    ▼                                         │
│  ┌────────────────────────────────────────────┐              │
│  │ tau-sandboxes namespace                    │              │
│  │                                            │              │
│  │  ┌─────────────┐    ┌─────────────┐        │              │
│  │  │ squad-abc   │    │ squad-xyz   │        │              │
│  │  │ (pod)       │    │ (pod)       │        │              │
│  │  │             │    │             │        │              │
│  │  │ tool-       │    │ tool-       │        │              │
│  │  │ executor    │    │ executor    │        │              │
│  │  │ (HTTP API)  │    │ (HTTP API)  │        │              │
│  │  └─────────────┘    └─────────────┘        │              │
│  └────────────────────────────────────────────┘              │
│                                                              │
│  Shared EFS Volume (tau-core-data):                          │
│    /data/workspaces/squads/{squadId}/                        │
│    /data/ssh/{squadId}/                                      │
│    /data/memory/{squadId}/                                   │
└──────────────────────────────────────────────────────────────┘
```

## Key Components

### K8sSandboxManager (`apps/core/src/services/sandbox/k8s/manager.ts`)

Top-level orchestrator. Implements `ISandboxManager`.

- **`ensureSandbox(id, opts)`** — Creates pod (via PodManager), connects HTTP client, waits for devbox readiness. Deduplicates concurrent calls for the same sandbox.
- **`exec(id, args)`** — Streams bash command via SSE, collects output, throws on non-zero exit.
- **`spawnShell(id, cols, rows)`** — Opens WebSocket shell, wraps in `HttpPtyWrapper` for IPty compatibility.
- **`reconcileSquadPods()`** — Every 60s, queries active squads from DB and ensures each has a running pod. Automatically recreates pods that were killed or evicted.
- **Health checks** — Before reusing a cached sandbox, verifies the pod is still reachable. Stale connections are cleaned up and recreated.

### K8sPodManager (`apps/core/src/services/sandbox/k8s/pod-manager.ts`)

Manages K8s pod CRUD via `@kubernetes/client-node`.

- **Pod creation** — Builds pod spec with volumes, probes, env vars, runtime class. Handles existing pods in terminal states (Failed/Succeeded) by deleting and recreating.
- **Readiness** — Polls pod status until the `Ready` condition is true (up to 5 minutes for first boot with nix packages).
- **Idle timeout** — Checks every 60s for pods idle beyond their timeout (default 15min). Configurable per squad via `SquadSandboxConfig.idleTimeout`. Pods with `alwaysOn: true` are never terminated.
- **Auth secret sync** — Pushes `FICUS_PASSWORD` from the Core SecretStore into a K8s Secret (`tau-sandbox-auth`), which pods mount at `/etc/tau`. K8s auto-propagates updates to running pods (~1min delay).

### SandboxClient (`apps/core/src/services/sandbox/client/http-client.ts`)

HTTP client for communicating with sandbox pods.

- One client instance per active sandbox, cached in the SandboxManager.
- See [Sandbox](sandbox.md) for the full API reference.

### HttpPtyWrapper (`apps/core/src/services/sandbox/k8s/pty-wrapper.ts`)

Adapts the WebSocket shell stream to the `IPty` interface used by the terminal UI.

- `onData(listener)` → fires on `ShellOutput.data`
- `onExit(listener)` → fires on `ShellOutput.exitCode`
- `write(data)` → sends `{ data: base64 }`
- `resize(cols, rows)` → sends `{ resize: { cols, rows } }`
- `kill()` → sends `{ kill: true }`, closes WebSocket

## Pod Lifecycle

```
ensureSandbox() called
       │
       ▼
 Pod exists in K8s?
    │         │
   yes        no
    │         │
    ▼         ▼
 Terminal?   syncAuthSecret()
 (Failed/    createPodSpec()
 Succeeded)  createNamespacedPod()
    │              │
   yes → delete    │
    │              │
    └──────────────┘
           │
           ▼
   Wait for Ready condition
   (poll every 1s, timeout 5min)
           │
           ▼
   Create HTTP client
   waitForReady() (10s timeout)
           │
           ▼
   Wait for devbox ready
   (poll /healthz every 3s, timeout 5min)
           │
           ▼
   Sandbox ready ✓
           │
           ▼
   ┌───────────────────┐
   │  Active use        │ ← touchPod() on every exec/shell
   └───────┬───────────┘
           │
           ▼
   Idle check (every 60s)
   lastActivity > idleTimeout?
    │           │
   yes          no → continue
    │
    ▼
   terminatePod()
   deleteNamespacedPod()
```

## Pod DNS

Sandbox pods are addressable via a headless service (`k8s/headless-service.yaml`):

```
<podName>.tau-sandboxes.<namespace>.svc.cluster.local:50051
```

This requires the pod spec to set `hostname: <podName>` and `subdomain: tau-sandboxes`, which the PodManager does automatically.

## Volume Architecture

All persistent data lives on a single shared EFS volume (`tau-core-data`). Sandbox pods mount squad-specific subdirectories via `subPath`:

| Mount Path                | SubPath                          | Access     | Purpose                                                                |
| ------------------------- | -------------------------------- | ---------- | ---------------------------------------------------------------------- |
| `/workspace`              | `workspaces/squads/{squadId}`    | read-write | Code, devbox.json, .tau/                                               |
| `/memory`                 | `memory/{squadId}`               | read-only  | Agent memory files                                                     |
| `/var/lib/tau/ssh-source` | `ssh/{squadId}`                  | read-write | SSH key source; entrypoint mirrors into container-private `/root/.ssh` |
| `/etc/tau`                | (K8s Secret: `tau-sandbox-auth`) | read-only  | Auth password for Ficus CLI                                            |

See [volumes.md](volumes.md) for the full storage architecture.

## Reconciliation

The SandboxManager runs a reconciliation loop every 60 seconds:

1. Query all active squads from the database
2. For each squad, call `ensureSquadSandbox()` which calls `ensureSandbox()`
3. If the pod was killed, evicted, or crashed — it gets recreated automatically
4. If the pod is healthy — the existing connection is reused (just a health check)

This provides self-healing behavior: manually deleting a sandbox pod or a node failure will result in automatic pod recreation within ~60 seconds.

## Related Docs

- [Deployment Guide](deployment.md) — Step-by-step K8s setup
- [Sandbox](sandbox.md) — API reference for the sandbox HTTP service
- [Volumes](volumes.md) — Storage architecture details
- [Security](security.md) — Network policies, RBAC, secrets
- [Troubleshooting](troubleshooting.md) — Common issues and debugging
