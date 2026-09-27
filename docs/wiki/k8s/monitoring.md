# K8s Monitoring

What to monitor for Ficus's K8s sandbox system, health check schemas, and recommended alerts.

## Health Endpoints

### Core API

```
GET /health
```

Standard health check for the Core API server. Used by the K8s readiness/liveness probes on the `tau-api` deployment.

### Sandbox (Sandbox Pods)

```
GET /healthz
```

```json
{
  "healthy": true,
  "devboxReady": true,
  "version": "0.2.0",
  "uptimeSeconds": 3600
}
```

| Field           | Meaning                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `healthy: true` | Server is running and accepting requests                                                                                                                            |
| `devboxReady`   | `false` during startup while `devbox install` runs in background. `true` once complete. Agents should wait for this before running commands that need devbox tools. |
| `version`       | Tool executor version (from `EXECUTOR_VERSION` env var)                                                                                                             |
| `uptimeSeconds` | Time since server started (not since pod started — entrypoint runs first)                                                                                           |

**Probe configuration on sandbox pods:**

| Probe     | Path       | Interval | Timeout | Failure Threshold | Notes                                         |
| --------- | ---------- | -------- | ------- | ----------------- | --------------------------------------------- |
| Startup   | `/healthz` | 5s       | 3s      | 60 (= 5min)       | Allows slow first boot                        |
| Readiness | `/healthz` | 5s       | 3s      | 3                 | Starts after startup probe passes             |
| Liveness  | `/healthz` | 10s      | 5s      | 3                 | Restarts pod if executor becomes unresponsive |

## Key Metrics to Track

### Pod Lifecycle

| Metric                     | How to Observe                                           | Why It Matters                             |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------ | ----------------- |
| Sandbox pods running       | `kubectl -n tau-sandboxes get pods                       | wc -l`                                     | Capacity planning |
| Pods in Pending state      | `kubectl get pods --field-selector=status.phase=Pending` | Scheduling issues, resource pressure       |
| Pod startup time           | Time from pod creation to `Ready` condition              | Detects image pull slowness, devbox issues |
| Devbox ready time          | Time from `Ready` to `devboxReady: true`                 | Detects nix cache misses, EFS slowness     |
| Idle terminations          | Core logs: `"idle.*terminat"`                            | Understand usage patterns                  |
| Reconciliation recreations | Core logs: `"reconcil.*creat"`                           | Pods being killed unexpectedly             |
| Pod restarts               | `kubectl get pods -o wide` (RESTARTS column)             | Crash loops, OOM kills                     |

### Resource Usage

```bash
# Pod-level CPU and memory
kubectl -n tau-sandboxes top pods

# Node-level pressure (if pods are pending)
kubectl top nodes
kubectl describe nodes | grep -A5 "Allocated resources"
```

| Resource | Default Request | Default Limit | Watch For            |
| -------- | --------------- | ------------- | -------------------- |
| CPU      | 100m            | 2 cores       | Sustained >80% limit |
| Memory   | 128Mi           | 2Gi           | OOMKilled events     |

### Storage (EFS)

| Metric            | Why It Matters                                         |
| ----------------- | ------------------------------------------------------ |
| EFS burst credits | EFS throughput drops dramatically when credits exhaust |
| EFS IOPS          | High metadata ops (git, find) can saturate EFS         |
| PVC usage         | Volume full → agent operations fail silently           |

EFS metrics are available in CloudWatch (AWS):

- `BurstCreditBalance`
- `TotalIOBytes`
- `PercentIOLimit`

### Connectivity

| What to Check                  | Command                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| DNS resolution works           | `kubectl exec -n tau-core ... -- nslookup <pod>.tau-sandboxes...` |
| HTTP client connectivity       | Core logs: `"Failed to connect"`, `"ECONNREFUSED"`                |
| Headless service has endpoints | `kubectl -n tau-sandboxes get endpoints tau-sandboxes`            |

## Recommended Alerts

### Critical

| Alert                     | Condition                              | Action                               |
| ------------------------- | -------------------------------------- | ------------------------------------ |
| Core API down             | `/health` unreachable for >2min        | Check `tau-api` pod, DB connectivity |
| Core Worker down          | `tau-worker` pod not ready for >2min   | Check pod logs, resource limits      |
| Sandbox pod stuck Pending | Pod in Pending >5min                   | Check node resources, sysbox, PVC    |
| PVC not bound             | `tau-core-data` PVC in non-Bound state | Check EFS CSI driver, access point   |

### Warning

| Alert                   | Condition                            | Action                                              |
| ----------------------- | ------------------------------------ | --------------------------------------------------- |
| High pod startup time   | Pod creation to Ready >3min          | Check image pull time, registry proximity           |
| Sandbox OOMKilled       | Pod terminated with OOMKilled reason | Increase memory limit or investigate agent workload |
| Reconciliation failures | `"Failed to reconcile"` in Core logs | Check RBAC, K8s API access                          |
| EFS burst credits low   | `BurstCreditBalance < 1TB`           | Consider provisioned throughput                     |
| High sandbox pod count  | >50 pods in tau-sandboxes            | Review idle timeouts, scale nodes                   |

### Informational

| Alert               | Condition                      | Notes                                                       |
| ------------------- | ------------------------------ | ----------------------------------------------------------- |
| Devbox install slow | `devboxReady` takes >2min      | Cache miss — workspace devbox.json differs from baked image |
| Idle pod terminated | `"idle.*terminat"` in logs     | Expected behavior, informational only                       |
| Auth secret synced  | `"sync.*auth.*secret"` in logs | Password rotation happening                                 |

## Log Aggregation

Core and sandbox pods write structured logs to stdout. Collect with your preferred stack:

```bash
# Quick: stream all sandbox logs
kubectl -n tau-sandboxes logs -l app=tau-sandbox -f --max-log-requests=20

# Quick: stream all core logs
kubectl -n tau-core logs -l app=tau-core -f --max-log-requests=10
```

**Key log prefixes to monitor:**

| Logger            | Source      | Key Messages                                     |
| ----------------- | ----------- | ------------------------------------------------ |
| `k8s-sandbox`     | Core worker | Sandbox lifecycle (create, stop, remove, errors) |
| `k8s-pod-manager` | Core worker | Pod CRUD, readiness, idle checks, auth sync      |
| `[sandbox]`       | Sandbox pod | Server start, dockerd status, devbox ready       |
| `[entrypoint]`    | Sandbox pod | SSH setup, git config, devbox install            |
| `[background]`    | Sandbox pod | devbox install progress, setup script            |

## Related Docs

- [Architecture](architecture.md) — System overview, reconciliation loop
- [Sandbox](sandbox.md) — Health endpoint details
- [Troubleshooting](troubleshooting.md) — Debugging specific issues
