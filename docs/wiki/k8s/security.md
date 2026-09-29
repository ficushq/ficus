# K8s Security

Security design for Ficus's Kubernetes sandbox system.

## Network Isolation

Network policies (`k8s/network-policy.yaml`) restrict sandbox pod traffic:

### Ingress

Sandbox pods **only accept connections from Core** (the `tau-core` namespace):

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            app: tau
            component: core
    ports:
      - port: 50051 # sandbox HTTP API
```

No other pods, namespaces, or external traffic can reach sandbox pods directly.

### Egress

Sandbox pods can reach:

| Destination              | Why                                                    |
| ------------------------ | ------------------------------------------------------ |
| **DNS** (port 53)        | Required for package installation, git operations      |
| **Internet** (all ports) | SSH/HTTPS git remotes, package installs, web API calls |
| **Core API** (port 3000) | Ficus CLI inside the sandbox talks back to Core        |

**Why allow internet egress?** Agent sandboxes need to install packages, clone repos, and run code that may call external APIs on arbitrary ports. Egress excludes private and special-use IPv4 ranges (including cloud metadata/link-local ranges) but otherwise allows all ports to the internet. Kubernetes NetworkPolicy does not portably support FQDN matching, so this cannot be restricted to `github.com`/`ssh.github.com` without CNI-specific policy extensions.

**GitHub SSH fallback:** Sandbox images configure `github.com` SSH remotes to use GitHub's `ssh.github.com:443` endpoint. This keeps standard remotes such as `git@github.com:org/repo.git` working in environments where outbound TCP/22 is blocked.

**Future consideration:** Per-squad egress policies could restrict specific sandboxes from internet access if needed for compliance.

## RBAC

The Core service account (`tau-core`) has a Role scoped to the `tau-sandboxes` namespace (`k8s/rbac.yaml`):

```yaml
rules:
  - apiGroups: ['']
    resources: [pods, pods/log, pods/status]
    verbs: [get, list, watch, create, delete]
  - apiGroups: ['']
    resources: [persistentvolumeclaims]
    verbs: [get, list, create, delete]
  - apiGroups: ['']
    resources: [secrets]
    verbs: [get, list, create, update, delete]
```

**Scope:** Core can only manage resources in the `tau-sandboxes` namespace. It cannot access pods in other namespaces or cluster-wide resources.

**Least privilege notes:**

- `pods/log` is included for debugging but could be removed if not used
- `persistentvolumeclaims` permissions are retained for potential future use (currently using a shared PVC)
- `secrets` access is needed for `syncAuthSecret()` which pushes `FICUS_PASSWORD` to sandbox pods

## Sandbox Isolation

### Sysbox Runtime

Sandbox pods run with the `sysbox-runc` RuntimeClass, which provides:

- **User namespace isolation** — the container runs as "root" inside a user namespace, which maps to an unprivileged UID on the host
- **Docker-in-Docker** — agents can run `docker build` and `docker run` without `--privileged`
- **No host access** — sysbox prevents access to host devices, kernel modules, and other sensitive resources

The runtime class is configurable via `FICUS_K8S_RUNTIME_CLASS`. Set to empty string to disable (not recommended for production).

### Path Restrictions

The sandbox restricts file operations to a set of allowed prefixes:

```
/workspace    — agent working directory (read-write)
/memory       — agent memory files (read-only mount)
/home/tau     — ficus CLI home
/nix          — nix package store
/opt/tau      — Ficus defaults and tools
/tmp          — temporary files
```

Any file operation targeting a path outside these prefixes is rejected with an error. This prevents agents from reading `/etc/shadow`, writing to `/usr/bin`, or accessing other pods' data via the shared volume.

### Volume Isolation

Each sandbox pod mounts only its own squad's data via `subPath`:

- `/workspace` → `workspaces/squads/{squadId}` (read-write)
- `/memory` → `memory/{squadId}` (read-only)
- `/var/lib/tau/ssh-source` → `ssh/{squadId}` (read-write; entrypoint mirrors into private `/root/.ssh`)

A pod for squad A cannot access squad B's workspace, even though they share the same underlying EFS volume. The `subPath` mount makes only the squad's subdirectory visible.

## Secrets Management

### Core Secrets

Core stores sensitive credentials (API keys, tokens, passwords) encrypted in the database using `FICUS_ENCRYPTION_KEY`. These are managed via the Settings UI and never stored in K8s Secrets or ConfigMaps.

### Sandbox Auth (`FICUS_PASSWORD`)

Sandbox pods need to authenticate with the Core API (for Ficus CLI). The password flows through:

1. User sets `FICUS_PASSWORD` in Settings UI → encrypted in DB
2. `K8sPodManager.syncAuthSecret()` pushes it to K8s Secret `tau-sandbox-auth` in the sandboxes namespace
3. Secret is mounted at `/etc/tau/password` in sandbox pods
4. Ficus CLI reads the mounted file for authentication

The secret is synced before each pod creation and whenever `FICUS_PASSWORD` changes (via `SecretStore.onChange` listener). K8s automatically propagates secret updates to running pods within ~1 minute.

### Git Credentials

`GITHUB_TOKEN` is passed as a pod env var (set from the Core SecretStore at pod creation time). The entrypoint configures a git credential helper that uses this token.

**Limitation:** Env vars are immutable after pod creation. If the token is rotated in Settings, existing pods keep the old token until they're restarted.

## Pod-to-Pod Communication

Core communicates with sandbox pods over **plain HTTP** within the cluster network. There is no mTLS.

**Why no mTLS?**

- Network policies already restrict who can reach sandbox pods (Core only)
- Both namespaces are in the same VPC
- mTLS adds operational complexity (cert rotation, debugging) without meaningful security gain in this threat model

**Threat model:** We trust the cluster network. An attacker who can intercept pod-to-pod traffic within the cluster has already compromised the node, at which point mTLS wouldn't help.

## Pod Security

### Pod Spec Security Features

- `restartPolicy: Never` — failed pods don't restart (reconciliation loop recreates them intentionally)
- `hostUsers: false` — enables user namespace mapping (required for sysbox on K8s 1.30+)
- No `privileged`, no `hostNetwork`, no `hostPID`
- Resource limits prevent runaway pods (default: 2 CPU, 2Gi memory)

### Pod Affinity

Sandbox pods prefer co-location with Core pods (`podAffinity` with weight 100 on `kubernetes.io/hostname`). This reduces network latency for HTTP calls but doesn't enforce it — pods can schedule on any node.

## Related Docs

- [Architecture](architecture.md) — System overview
- [Sandbox](sandbox.md) — Path security details
- [Deployment Guide](deployment.md) — RBAC and network policy setup
