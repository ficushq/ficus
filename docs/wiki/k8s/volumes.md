# K8s Volumes & Storage

## Overview

All persistent data lives on a **single shared EFS volume** (`ficus-core-data`) per client. Both core pods (API + worker) and sandbox pods mount this volume, using `subPath` to isolate squad-specific data.

No dynamic PVC provisioning — the volume is created once by Pulumi.

## EFS Access Point

Each client gets one EFS access point at path `/core-data-{clientName}`:

- **UID/GID**: 0 (root) — both core and sysbox sandbox pods run as root
- **Permissions**: 700
- **Provisioned by**: Pulumi (`ops/src/tau/client.ts`)

Two static PVs reference the same access point (with unique `volumeHandle` suffixes) to allow PVCs in both namespaces:

| PV                           | Namespace                | PVC Name          |
| ---------------------------- | ------------------------ | ----------------- |
| `tau-{name}-core-data-pv`    | `ficus-core-{name}`      | `ficus-core-data` |
| `tau-{name}-sandbox-data-pv` | `ficus-sandboxes-{name}` | `ficus-core-data` |

## Directory Layout

Everything lives under `HOME_DIR` (`/data` on K8s, `~/.ficus` locally):

```
/data/
├── sessions/{agentId}/      # Agent session files (core only)
├── ssh/{squadId}/           # SSH keys per squad (core writes, sandbox reads)
├── memory/{squadId}/        # Memory files per squad (core writes, sandbox reads)
├── images/                  # Generated images (core only)
└── workspaces/squads/{squadId}/  # Workspace files (sandbox reads/writes)
```

## Core Pods (API + Worker)

Mount the full volume at `/data`:

```yaml
volumeMounts:
  - name: core-data
    mountPath: /data
volumes:
  - name: core-data
    persistentVolumeClaim:
      claimName: ficus-core-data
```

`HOME_DIR=/data` is set via the `ficus-core-config` ConfigMap.

## Sandbox Pods

Mount squad-specific subdirectories via `subPath`:

```yaml
volumeMounts:
  - name: core-data
    mountPath: /workspace
    subPath: workspaces/squads/{squadId}
  - name: core-data
    mountPath: /memory
    subPath: memory/{squadId}
    readOnly: true
  - name: core-data
    mountPath: /var/lib/ficus/ssh-source
    subPath: ssh/{squadId}
volumes:
  - name: core-data
    persistentVolumeClaim:
      claimName: ficus-core-data # PVC in ficus-sandboxes-{name} namespace
```

- **Workspace**: read-write, contains code, devbox.json, .tau/ directory
- **Memory**: read-only, agent memory files (map.md, context.md)
- **SSH source**: shared mount of the host SSH key dir; the entrypoint mirrors it into a container-private `/root/.ssh` with strict perms (see `packages/sandbox-server/sandbox/entrypoint.sh`)

## Key Decisions

- **Single shared volume** instead of per-squad PVCs — simpler, fewer K8s resources, matches the local Docker setup where everything is under `~/.tau`
- **EFS (not EBS)** — supports ReadWriteMany so multiple pods can mount simultaneously
- **Static provisioning** — Pulumi creates the access point and PVs once, no dynamic provisioner needed
- **subPath isolation** — each sandbox pod only sees its own squad's data, not the whole volume
- **No nix persistence** — nix packages are baked into the sandbox Docker image (~2.5GB). EFS is too slow for nix's small-file I/O patterns

## Related Files

- `ops/src/tau/client.ts` — Pulumi: access point, PVs, PVCs
- `ops/src/tau/efs.ts` — Pulumi: EFS filesystem, security group, CSI driver
- `apps/core/src/services/sandbox/k8s/pod-manager.ts` — sandbox pod spec with volume mounts
- `apps/core/src/lib/utils/home.ts` — `HOME_DIR` resolution
- `ops/src/tau/k8s/core-deployment.yaml` — core pod volume mounts
