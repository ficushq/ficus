# Kubernetes Deployment Guide

Step-by-step guide for deploying Ficus on Kubernetes with K8s-based sandboxes.

This is one of several ways to run Ficus — see [hosting.md](../hosting.md) for the
full map (where the core runs × which sandbox runtime it uses),
[scripts/setup/README.md](../../../scripts/setup/README.md) for the automated
single-host/cloud-VM path, [docs/wiki/setup.md](../setup.md#local-setup) for a laptop
install, and [sandbox-runtimes.md](../sandbox-runtimes.md) to pick a runtime.
On Kubernetes, agent sandboxes are isolated pods: set `FICUS_SANDBOX_RUNTIME=k8s`
and deploy the manifests in `k8s/`. Design details are in
[architecture.md](architecture.md).

## 1. Prerequisites

- **Kubernetes cluster** (EKS, GKE, AKS, or self-managed) — 1.25+
- **kubectl** configured with cluster access
- **Docker registry** access (ECR, GCR, Docker Hub, etc.)
- **Storage classes**: RWX (e.g., EFS) for shared volumes, RWO (e.g., EBS gp3) for block storage
- **Sysbox** installed on worker nodes (for secure Docker-in-Docker)
- **PostgreSQL** database (in-cluster or managed like RDS)

### Sysbox Installation

```bash
# On each worker node (Ubuntu/Debian)
wget https://downloads.nestybox.com/sysbox/releases/v0.6.4/sysbox-ce_0.6.4-0.linux_amd64.deb
sudo apt install ./sysbox-ce_0.6.4-0.linux_amd64.deb
sudo systemctl status sysbox
```

See [Sysbox K8s docs](https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-k8s.md) for details.

## 2. Build and Push Images

```bash
# Build images
bun run sandbox:build:k8s    # sandbox for sandbox pods
bun run core:build            # Core (API + worker + web)

# Tag and push
export REGISTRY=your-registry.example.com
docker tag tau-sandbox:latest $REGISTRY/tau-sandbox:latest
docker tag tau-core:latest $REGISTRY/tau-core:latest
docker push $REGISTRY/tau-sandbox:latest
docker push $REGISTRY/tau-core:latest
```

## 3. Configure Storage Classes

Ficus requires RWX (ReadWriteMany) and RWO (ReadWriteOnce) storage classes.

### AWS Example

```yaml
# storage-class-efs.yaml (RWX)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs-encrypted
provisioner: efs.csi.aws.com
parameters:
  provisioningMode: efs-ap
  fileSystemId: fs-xxxxxxxx # Your EFS filesystem ID
  directoryPerms: '700'
  encrypted: 'true'
---
# storage-class-gp3.yaml (RWO)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-encrypted
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: 'true'
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

> **Other clouds:** GKE uses Filestore for RWX (`filestore.csi.storage.gke.io`). AKS uses Azure Files (`file.csi.azure.com`). See [Appendix B](#appendix-b-storage-class-reference) for examples.

## 4. Apply K8s Manifests

```bash
# Create tau-core namespace
kubectl create namespace tau-core --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace tau-core app=tau component=core --overwrite

# Apply sandbox infrastructure
kubectl apply -f k8s/namespace.yaml      # tau-sandboxes namespace
kubectl apply -f k8s/runtime-class.yaml  # Sysbox RuntimeClass
kubectl apply -f k8s/rbac.yaml           # RBAC for sandbox management
kubectl apply -f k8s/headless-service.yaml  # DNS for sandbox pods
kubectl apply -f k8s/network-policy.yaml # Network isolation

# Verify
kubectl get namespace tau-sandboxes && kubectl get runtimeclass sysbox-runc
```

What each manifest is for:

| Manifest                    | Purpose                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `k8s/namespace.yaml`        | `tau-sandboxes` namespace for sandbox pods                    |
| `k8s/core-namespace.yaml`   | `tau-core` namespace for the API/worker/web deployments       |
| `k8s/core-deployment.yaml`  | Core API, worker, and web Deployments in `tau-core` namespace |
| `k8s/rbac.yaml`             | Service account + role for managing sandbox pods/PVCs         |
| `k8s/core-logs-rbac.yaml`   | Extra role letting Core read pod logs for the system-log UI   |
| `k8s/headless-service.yaml` | DNS for individual sandbox pods                               |
| `k8s/network-policy.yaml`   | Restrict sandbox pod network access                           |
| `k8s/runtime-class.yaml`    | Sysbox RuntimeClass for secure Docker-in-Docker               |

## 5. Create Secrets and ConfigMaps

### Core Configuration

> **Note:** `k8s/core-deployment.yaml` includes a ConfigMap and Secret with placeholder values. You can either edit that file directly, or create them separately with `kubectl` (shown below). If using `kubectl`, delete the ConfigMap/Secret sections from the manifest first.

```bash
kubectl -n tau-core create configmap tau-core-config \
  --from-literal=FICUS_SANDBOX_RUNTIME="k8s" \
  --from-literal=PORT="3000" \
  --from-literal=WORKER_PORT="3002" \
  --from-literal=MAX_CONCURRENT_AGENTS="10"

kubectl -n tau-core create secret generic tau-core-secrets \
  --from-literal=DATABASE_URL="postgresql://user:pass@host:5432/tau" \
  --from-literal=FICUS_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```

> **Note:** With `FICUS_ENCRYPTION_KEY` set, configure agent model accounts in **Settings → AI Providers** and external services in **Settings → Integrations**. Credentials are encrypted in the database. Bootstrap authentication stays in deployment configuration; GitHub repository access uses connected integration accounts.

### Sandbox Credentials

```bash
kubectl -n tau-sandboxes create secret generic tau-git-credentials \
  --from-literal=GITHUB_TOKEN="ghp_..."

kubectl -n tau-sandboxes create configmap tau-git-config \
  --from-literal=user-name="Ficus Bot" \
  --from-literal=user-email="tau@example.com"
```

## 6. Deploy Core

Core runs as three separate Deployments from the same Docker image:

| Deployment   | Purpose                                      | Scale                                       |
| ------------ | -------------------------------------------- | ------------------------------------------- |
| `tau-api`    | HTTP API server (port 3000)                  | 1 replica (stateful — manages sandbox pods) |
| `tau-worker` | Agent execution, scheduling, background jobs | Scale based on agent load                   |
| `tau-web`    | Vite frontend (port 5173)                    | 1 replica                                   |

`FICUS_SERVE_WEB` is intended for single-VM and self-hosted single-origin deployments. Kubernetes installs keep the split topology: `tau-api` serves API/WebSocket traffic, `tau-web` serves the frontend, and production static hosting/CDN choices remain separate.

The manifest at `k8s/core-deployment.yaml` includes all three Deployments, their Services, and the shared ConfigMap/Secret. Edit it to set your image registry and credentials:

```bash
# Update image references in k8s/core-deployment.yaml
sed -i "s|tau-core:latest|$REGISTRY/tau-core:latest|g" k8s/core-deployment.yaml

# Update secrets (DATABASE_URL, FICUS_PASSWORD, etc.)
# Edit k8s/core-deployment.yaml or use kubectl create secret (step 5)

kubectl apply -f k8s/core-deployment.yaml

# Verify all three deployments are running
kubectl -n tau-core get pods
kubectl -n tau-core logs deployment/tau-api --tail=20
kubectl -n tau-core logs deployment/tau-worker --tail=20
```

**Scaling workers:** Each worker handles `MAX_CONCURRENT_AGENTS` concurrent agent runs (default: 10). Scale horizontally:

```bash
kubectl -n tau-core scale deployment tau-worker --replicas=3  # 30 concurrent agents
```

## 7. Verify

Test that Core can create sandbox pods:

```bash
# Terminal 1: Watch sandbox pods
kubectl -n tau-sandboxes get pods -w

# Terminal 2: Port-forward and test
kubectl -n tau-core port-forward svc/tau-api 3000:3000 &
ficus agent create test-agent --model gpt-4o --system "You are a test agent"
ficus run test-agent "echo hello"
```

You should see a sandbox pod spin up in `tau-sandboxes`.

## 8. Monitoring & Troubleshooting

See [Monitoring](monitoring.md) for detailed metrics, alerts, and health check schemas.

See [Troubleshooting](troubleshooting.md) for common issues and debugging commands.

### Quick Checks

```bash
kubectl -n tau-core logs deployment/tau-api -f         # API logs
kubectl -n tau-core logs deployment/tau-worker -f      # Worker logs
kubectl -n tau-sandboxes get pods                       # Sandbox pod status
kubectl -n tau-sandboxes logs -l app=tau-sandbox       # Sandbox logs
```

### Common Issues

| Issue                      | Check                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Sandbox pods stuck Pending | `kubectl describe pod` — check storage class, node resources                                   |
| HTTP connection refused    | Verify network policy, check `kubectl get endpoints tau-sandboxes`                             |
| RuntimeClass not found     | Sysbox not installed: `kubectl get runtimeclass sysbox-runc`                                   |
| Permission denied          | `kubectl auth can-i create pods -n tau-sandboxes --as=system:serviceaccount:tau-core:tau-core` |

---

## Appendix A: Environment Variable Reference

### Core (tau-api / tau-worker)

| Variable                     | Default                               | Description                                                                                                                                     |
| ---------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `FICUS_SANDBOX_RUNTIME`      | (required, no default)                | One of `docker-sysbox`, `docker-socket`, `k8s`, `vm`, `host` — use `k8s` for this deployment. See [sandbox-runtimes.md](../sandbox-runtimes.md) |
| `FICUS_K8S_NAMESPACE`        | `tau-sandboxes`                       | K8s namespace for sandbox pods                                                                                                                  |
| `FICUS_SANDBOX_IMAGE`        | `tau-sandbox:latest`                  | Docker image for sandbox pods                                                                                                                   |
| `FICUS_K8S_RUNTIME_CLASS`    | `sysbox-runc`                         | K8s RuntimeClass for sandbox pods. Set to `""` to disable                                                                                       |
| `FICUS_ENCRYPTION_KEY`       | (required)                            | 64-char hex key for encrypting secrets in DB                                                                                                    |
| `DATABASE_URL`               | (required)                            | PostgreSQL connection string                                                                                                                    |
| `PORT`                       | `3000`                                | API server port                                                                                                                                 |
| `WORKER_PORT`                | `3002`                                | Worker RPC port                                                                                                                                 |
| `WORKER_URL`                 | `http://tau-worker:3002`              | Worker URL (set on API deployment)                                                                                                              |
| `FICUS_WORKER_EVENT_PORT`    | `3003`                                | Port for the worker's api↔worker event listener (see the note below)                                                                            |
| `FICUS_INTERNAL_EVENT_TOKEN` | (derived from `FICUS_ENCRYPTION_KEY`) | Shared secret authenticating api↔worker events; must resolve identically in both                                                                |
| `MAX_CONCURRENT_AGENTS`      | `10`                                  | Max concurrent agent runs per worker                                                                                                            |
| `HOME_DIR`                   | `/data` (K8s), `~/.tau` (local)       | Root directory for all persistent data                                                                                                          |

> **Cross-process events.** The seven channels documented in
> [`event-emitter.md`](../event-emitter.md#local-events-channels) travel over an
> authenticated HTTP transport that defaults to loopback. Two containers in ONE pod share a
> network namespace, so the defaults work unchanged — this is the simplest
> option, and they already share `/data`.
>
> To run them as SEPARATE pods, point each side at the other's Service:
> set `FICUS_WORKER_EVENT_BIND=0.0.0.0` and
> `FICUS_API_EVENT_URL=http://tau-api:3000/internal/events` on the worker, and
> `FICUS_WORKER_EVENT_URL=http://tau-worker:3003/internal/events` on the api.
> Keep port 3003 on an internal Service only — never an Ingress or NodePort.
> Both pods must resolve the same token: either set `FICUS_INTERNAL_EVENT_TOKEN`
> identically, or rely on them already sharing `FICUS_ENCRYPTION_KEY`, from which
> the same token is derived. Delivery remains best-effort and has no handler
> acknowledgement, but failures are visible in API
> `resources.local_event_forward` and worker `localEventForward` diagnostics; a
> 401 usually indicates a token mismatch. See
> `apps/core/src/lib/infra/local-events.ts`.

### Sandbox Pods (sandbox)

| Variable           | Default       | Description                 |
| ------------------ | ------------- | --------------------------- |
| `EXECUTOR_PORT`    | `50051`       | HTTP server port            |
| `EXECUTOR_VERSION` | `0.2.0`       | Reported in `/healthz`      |
| `WORKSPACE_PATH`   | `/workspace`  | Agent working directory     |
| `FICUS_SANDBOX_ID` | (set by Core) | Sandbox identifier          |
| `FICUS_SQUAD_ID`   | (set by Core) | Squad identifier            |
| `FICUS_API_URL`    | (set by Core) | Core API URL for Ficus CLI  |
| `GITHUB_TOKEN`     | (optional)    | Git credential helper token |
| `GIT_USER_NAME`    | (optional)    | Git commit author name      |
| `GIT_USER_EMAIL`   | (optional)    | Git commit author email     |

See [Sandbox](sandbox.md) for full API documentation.

## Appendix B: Storage Class Reference

### GKE Filestore (RWX)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: filestore-standard
provisioner: filestore.csi.storage.gke.io
parameters:
  tier: standard
  network: default
```

### Azure Files (RWX)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azurefile-premium
provisioner: file.csi.azure.com
parameters:
  skuName: Premium_LRS
mountOptions:
  - dir_mode=0700
  - file_mode=0700
```

### AWS EFS (Full Example)

Requires the [EFS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/efs-csi.html):

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs-encrypted
provisioner: efs.csi.aws.com
parameters:
  provisioningMode: efs-ap
  fileSystemId: fs-xxxxxxxx
  directoryPerms: '700'
  encrypted: 'true'
  basePath: '/tau-sandboxes'
mountOptions:
  - tls
```

### AWS EBS gp3 (Full Example)

Requires the [EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html):

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-encrypted
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: '3000'
  throughput: '125'
  encrypted: 'true'
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

### Sandbox provisioning circuit breaker

Cold sandbox creation is coordinated through PostgreSQL across API and worker processes. Existing fully ready sandboxes remain usable while the circuit is open. Circuit state and cooldown survive process restarts, preventing a restart stampede. Provisioning endpoints return HTTP 503 with `Retry-After` and stable error codes while scheduling is unavailable or capacity is exhausted.

| Variable                                | Default | Description                                                                                 |
| --------------------------------------- | ------: | ------------------------------------------------------------------------------------------- |
| `FICUS_K8S_PROVISION_MAX_CONCURRENT`    |     `4` | Maximum cluster-wide cold or destructive provisioning operations; excess work is not queued |
| `FICUS_K8S_PROVISION_MAX_WAITERS`       |    `32` | Maximum callers per process sharing one sandbox operation                                   |
| `FICUS_K8S_PROVISION_FAILURE_THRESHOLD` |     `3` | Qualifying failures required to open the circuit                                            |
| `FICUS_K8S_PROVISION_FAILURE_WINDOW_MS` | `60000` | Rolling qualifying-failure window                                                           |
| `FICUS_K8S_PROVISION_COOLDOWN_MS`       | `30000` | Open duration before one cross-process recovery probe                                       |
