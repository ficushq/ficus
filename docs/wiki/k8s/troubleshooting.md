# K8s Troubleshooting

Common issues and debugging techniques for Ficus's K8s sandbox system in **production**. For local k3d development issues, see [local-dev-k3d.md](local-dev-k3d.md#troubleshooting).

## Quick Diagnostics

```bash
# Check core pods
kubectl -n tau-core get pods
kubectl -n tau-core logs deployment/tau-api --tail=50
kubectl -n tau-core logs deployment/tau-worker --tail=50

# Check sandbox pods
kubectl -n tau-sandboxes get pods
kubectl -n tau-sandboxes describe pod <pod-name>
kubectl -n tau-sandboxes logs <pod-name> --tail=50

# Check infrastructure
kubectl get runtimeclass sysbox-runc
kubectl -n tau-sandboxes get networkpolicy
kubectl -n tau-sandboxes get endpoints tau-sandboxes
kubectl -n tau-sandboxes get pvc
```

## Pod Issues

### Pod Stuck in Pending

**Symptoms:** Sandbox pod stays in `Pending` state, agent execution times out.

```bash
kubectl -n tau-sandboxes describe pod <pod-name>
```

| Cause                  | Events Message                                    | Fix                                                                 |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| No nodes with sysbox   | `RuntimeClass "sysbox-runc" not found`            | Install sysbox on worker nodes, or set `FICUS_K8S_RUNTIME_CLASS=""` |
| Insufficient resources | `Insufficient cpu` / `Insufficient memory`        | Scale nodes or reduce pod resource requests                         |
| PVC not bound          | `persistentvolumeclaim "tau-core-data" not found` | Create the PVC (see [volumes.md](volumes.md))                       |
| Node selector mismatch | `0/N nodes are available`                         | Check node labels match any node selectors                          |

### Pod in CrashLoopBackOff

**Symptoms:** Pod starts, crashes, restarts repeatedly.

```bash
kubectl -n tau-sandboxes logs <pod-name> --previous
```

| Cause                  | Log Message                       | Fix                                                                    |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| Missing nix profile    | `nix.sh: No such file`            | Rebuild sandbox image                                                  |
| Workspace mount failed | Permission denied on `/workspace` | Check EFS access point permissions (should be UID 0, mode 700)         |
| Port conflict          | `EADDRINUSE: 50051`               | This shouldn't happen in K8s — check for duplicate pods with same name |

### Pod Running but Not Ready

**Symptoms:** Pod phase is `Running` but readiness probe fails.

```bash
# Check probe status
kubectl -n tau-sandboxes describe pod <pod-name> | grep -A5 "Conditions"

# Check sandbox health directly
kubectl -n tau-sandboxes exec <pod-name> -- curl -s http://localhost:50051/healthz
```

The startup probe allows 5 minutes for first boot. If it fails:

- **devbox install hanging** — network issue downloading nix packages. Check egress network policy and DNS resolution.
- **dockerd failing to start** — sysbox may not be properly configured. Check `kubectl -n tau-sandboxes logs <pod-name>` for `dockerd` errors.

### Pod Disappears / Gets Terminated

Pods are terminated in these cases:

1. **Idle timeout** — pods idle for >15min (default) are terminated by the idle checker. This is expected behavior.
2. **Node eviction** — K8s evicts pods under resource pressure. The reconciliation loop recreates them within ~60s.
3. **Manual deletion** — someone ran `kubectl delete pod`. Reconciliation recreates it.
4. **Failed state** — pods in `Failed`/`Succeeded` state are detected and recreated on the next `ensureSandbox()` call.

Check Core logs for idle termination:

```bash
kubectl -n tau-core logs deployment/tau-worker --tail=100 | grep "idle\|terminat"
```

## Connectivity Issues

### Core Cannot Reach Sandbox Pod

**Symptoms:** `Failed to connect to sandbox`, `ECONNREFUSED`, `ETIMEDOUT`

```bash
# Verify DNS resolution
kubectl -n tau-core exec deployment/tau-api -- nslookup tau-sandbox-<id>.tau-sandboxes.tau-sandboxes.svc.cluster.local

# Verify headless service has endpoints
kubectl -n tau-sandboxes get endpoints tau-sandboxes

# Verify network policy allows traffic
kubectl -n tau-sandboxes get networkpolicy -o yaml
```

**Common causes:**

- **Headless service not created** — `kubectl apply -f k8s/headless-service.yaml`
- **Pod hostname/subdomain not set** — check pod spec has `hostname: <podName>` and `subdomain: tau-sandboxes`
- **Network policy blocking** — Core namespace must have labels `app: tau, component: core`
- **DNS propagation delay** — new pods take a few seconds to appear in DNS. Core retries automatically.

### Sandbox Cannot Reach Core API

**Symptoms:** Ficus CLI commands inside sandbox fail with connection errors.

```bash
# From inside the sandbox pod
kubectl -n tau-sandboxes exec <pod-name> -- curl -s http://tau-api.tau-core.svc.cluster.local:3000/health
```

Check that the network policy egress rule allows traffic to the Core namespace on port 3000.

## Devbox Issues

### devbox install Hangs

**Symptoms:** Pod is running, health check returns `devboxReady: false` for a long time.

```bash
# Check background install progress
kubectl -n tau-sandboxes logs <pod-name> | grep "background\|devbox"
```

**Causes:**

- **Cache miss** — if `devbox.json` in workspace differs from what's baked into the image, nix downloads new packages. This can take minutes on slow networks.
- **DNS failure** — nix needs to resolve `cache.nixos.org`. Check egress network policy allows DNS (port 53).
- **EFS latency** — nix's small-file I/O is slow on EFS. Packages should be baked into the image at build time.

### devbox Packages Not Available

**Symptoms:** Agent runs a command and gets `command not found` for tools that should be in devbox.

The bash endpoint activates devbox via a preamble script. Check:

1. `devbox.json` exists in `/workspace`
2. `devbox install` completed (health check `devboxReady: true`)
3. The command isn't being run with `activateDevbox: false`

## Volume Issues

### Permission Denied on Workspace

```bash
kubectl -n tau-sandboxes exec <pod-name> -- ls -la /workspace
kubectl -n tau-sandboxes exec <pod-name> -- id
```

With sysbox, the container runs as root in a user namespace. If the EFS access point was created with a different UID, files may not be accessible. The access point should use UID/GID 0 with permissions 700.

### SSH Key Permission or Connectivity Errors

The entrypoint mirrors `/var/lib/tau/ssh-source` (the host-shared key dir) into a container-private `/root/.ssh` every 5s and applies strict perms there. Sandbox images also route standard GitHub SSH remotes (`git@github.com:org/repo.git`) through GitHub's SSH-over-HTTPS endpoint on TCP/443. If git still fails:

```bash
kubectl -n tau-sandboxes exec <pod-name> -- ls -la /var/lib/tau/ssh-source  # source from host API
kubectl -n tau-sandboxes exec <pod-name> -- ls -la /root/.ssh              # container copy
kubectl -n tau-sandboxes exec <pod-name> -- ssh -G git@github.com | grep -E '^(hostname|port|user) '
kubectl -n tau-sandboxes exec <pod-name> -- ssh -o ConnectTimeout=10 -T git@github.com
kubectl -n tau-sandboxes exec <pod-name> -- ssh -o ConnectTimeout=10 -p 443 -T git@ssh.github.com
```

If a key the API added on the host is missing from `/root/.ssh`, check the entrypoint's sync log and that `rsync` (or the `cp`-fallback path) ran. `/root/.ssh` is a private container directory, not a mount, so chown/chmod always succeed there.

Expected GitHub auth failures use exit code 1 with a message from GitHub. Timeouts usually indicate the cluster NetworkPolicy, CNI, firewall, NAT gateway, or cloud security group is still blocking egress on TCP/443.

## Auth Issues

### Ficus CLI Auth Failure Inside Sandbox

```bash
# Check the mounted secret
kubectl -n tau-sandboxes exec <pod-name> -- cat /etc/tau/password

# Check the K8s secret exists
kubectl -n tau-sandboxes get secret tau-sandbox-auth -o jsonpath='{.data.password}' | base64 -d
```

If the secret is empty or missing:

1. Set `FICUS_PASSWORD` in the Settings UI
2. The Core will sync it on next pod creation, or trigger sync manually by restarting the worker

### GitHub Token Not Working

`GITHUB_TOKEN` is set as a pod env var at creation time. If the token is rotated in Settings, existing pods still have the old token.

**Fix:** Terminate the sandbox pod (it will be recreated with the new token):

```bash
kubectl -n tau-sandboxes delete pod tau-sandbox-<squad-id>
```

## Resource Issues

### Pod OOMKilled

```bash
kubectl -n tau-sandboxes describe pod <pod-name> | grep OOM
```

Default memory limit is 2Gi. Large builds, multiple docker containers, or memory-hungry tools can exceed this. Solutions:

- Increase pod memory limit in `pod-manager.ts` (requires Core rebuild)
- Ensure agents don't run unbounded parallel processes

### Slow File Operations

EFS (NFS) has higher latency than local disk, especially for metadata-heavy operations (`find`, `ls -R`, `git status` on large repos).

**Mitigations:**

- Nix packages are baked into the Docker image, not stored on EFS
- `.gitignore` should exclude `node_modules` and build artifacts from git operations
- Consider EFS provisioned throughput for large deployments

## Useful Commands

```bash
# Watch all sandbox pods
kubectl -n tau-sandboxes get pods -w

# Stream all sandbox logs
kubectl -n tau-sandboxes logs -l app=tau-sandbox -f --max-log-requests=20

# Check sandbox pod resource usage
kubectl -n tau-sandboxes top pods

# Force-delete a stuck pod
kubectl -n tau-sandboxes delete pod <pod-name> --force --grace-period=0

# Check RBAC permissions
kubectl auth can-i create pods -n tau-sandboxes --as=system:serviceaccount:tau-core:tau-core

# Exec into a sandbox for debugging
kubectl -n tau-sandboxes exec -it <pod-name> -- bash
```

## Related Docs

- [Architecture](architecture.md) — System overview and pod lifecycle
- [Sandbox](sandbox.md) — Health check details, API reference
- [Security](security.md) — Network policies, RBAC explanation
- [Volumes](volumes.md) — Storage architecture

## Provisioning circuit is open

Sandbox start/restart may return HTTP 503 with a stable `SANDBOX_PROVISION_*` code and a `Retry-After` header when the Kubernetes control plane or scheduler is unhealthy. Check pod scheduling events, API-server reachability, authorization, node/image/storage capacity, and the provisioning diagnostics in the K8s sandbox status response. Do not restart Ficus merely to reset the circuit: state is persisted in PostgreSQL and restart intentionally preserves the cooldown. Fully ready existing sandboxes continue to operate; after the cooldown, one request becomes the recovery probe.

Agent turns refused for recoverable capacity, storage substrate, coordination, or control-plane conditions show `waiting-sandbox` and retry automatically on the same execution. Retries use bounded exponential backoff, at most eight wake attempts, and a 15-minute deadline. Diagnostics report waiting/leased/exhausted counts, oldest wait age, and process outcomes. Authorization, invalid image/specification, application startup, and other permanent failures remain terminal and require operator correction.
