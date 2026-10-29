# VM sandbox runtime (`FICUS_SANDBOX_RUNTIME=vm`)

The VM sandbox runtime runs sandboxes as Unix-user boxes on registered machines.
The detailed runtime documentation is organized by topic below.

## Topic pages

- [VM runtime architecture](runtime-architecture.md)
- [VM runtime provisioning](runtime-provisioning.md)
- [VM runtime lifecycle](runtime-lifecycle.md)
- [VM runtime placement and migration](runtime-placement.md)
- [VM runtime services](runtime-services.md)
- [VM runtime operations](runtime-operations.md)
- [VM runtime health and recovery](runtime-recovery.md)

## Section navigation

The original section anchors remain here as links to the moved material.

## Remote hosts are not machines

See [VM runtime architecture](runtime-architecture.md#remote-hosts-are-not-machines).

## Architecture at a glance

See [VM runtime architecture](runtime-architecture.md#architecture-at-a-glance).

## Machine prerequisites

See [VM runtime provisioning](runtime-provisioning.md#machine-prerequisites).

## Prebaked box image + fast bootstrap

See [VM runtime provisioning](runtime-provisioning.md#prebaked-box-image--fast-bootstrap).

## The ensure flow

See [VM runtime provisioning](runtime-provisioning.md#the-ensure-flow).

### Provision serialization and cross-process single flight

See [VM runtime provisioning](runtime-provisioning.md#provision-serialization-and-cross-process-single-flight).

#### Restart/readiness regression evidence (2026-10-28)

See [VM runtime provisioning](runtime-provisioning.md#restartreadiness-regression-evidence-2026-10-28).

### Executor auth + loopback bind (cross-box hardening)

See [VM runtime provisioning](runtime-provisioning.md#executor-auth--loopback-bind-cross-box-hardening).

### Box ports: reservation, guard, and busy-port retry

See [VM runtime provisioning](runtime-provisioning.md#box-ports-reservation-guard-and-busy-port-retry).

## Tool paths: logical roots rebased to the box HOME

See [VM runtime architecture](runtime-architecture.md#tool-paths-logical-roots-rebased-to-the-box-home).

## Park / stop / remove semantics

See [VM runtime lifecycle](runtime-lifecycle.md#park--stop--remove-semantics).

## Lifecycle: idle reap, machine health, orphan reconcile

See [VM runtime lifecycle](runtime-lifecycle.md#lifecycle-idle-reap-machine-health-orphan-reconcile).

### Single-worker / DB-driven caveat

See [VM runtime lifecycle](runtime-lifecycle.md#single-worker--db-driven-caveat).

## Placement

See [VM runtime placement and migration](runtime-placement.md#placement).

## Pin + migrate: moving a box to a specific machine

See [VM runtime placement and migration](runtime-placement.md#pin--migrate-moving-a-box-to-a-specific-machine).

## Manual rebalance: re-packing live boxes

See [VM runtime placement and migration](runtime-placement.md#manual-rebalance-re-packing-live-boxes).

## Events: `machine.*` / `box.status` (admin-global)

See [VM runtime operations](runtime-operations.md#events-machine--boxstatus-admin-global).

## Web admin: Machines settings section

See [VM runtime operations](runtime-operations.md#web-admin-machines-settings-section).

## Callbacks: how a box reaches Core

See [VM runtime architecture](runtime-architecture.md#callbacks-how-a-box-reaches-core).

## Per-box rootless docker

See [VM runtime services](runtime-services.md#per-box-rootless-docker).

## Egress model

See [VM runtime services](runtime-services.md#egress-model).

## Browser service

See [VM runtime services](runtime-services.md#browser-service).

## Devbox comfort-set seeding

See [VM runtime provisioning](runtime-provisioning.md#devbox-comfort-set-seeding).

## Troubleshooting

See [VM runtime operations](runtime-operations.md#troubleshooting).

## Known limitations

See [VM runtime operations](runtime-operations.md#known-limitations).

## Backlog (not done in slice 6)

See [VM runtime operations](runtime-operations.md#backlog-not-done-in-slice-6).

## Instance maintenance pause

See [VM runtime lifecycle](runtime-lifecycle.md#instance-maintenance-pause).

### Native machine-host resize recovery

See [VM runtime lifecycle](runtime-lifecycle.md#native-machine-host-resize-recovery).

## Runtime degradation and Bash admission

See [VM runtime health and recovery](runtime-recovery.md#runtime-degradation-and-bash-admission).

## Host versus sandbox pressure and protected processes

See [VM runtime health and recovery](runtime-recovery.md#host-versus-sandbox-pressure-and-protected-processes).

## VM sandbox setup readiness and transport recovery

See [VM runtime health and recovery](runtime-recovery.md#vm-sandbox-setup-readiness-and-transport-recovery).

### Setup blocked by unproven invocation cleanup

See [VM runtime health and recovery](runtime-recovery.md#setup-blocked-by-unproven-invocation-cleanup).

### Reprovision every registered box during offline maintenance

See [VM runtime health and recovery](runtime-recovery.md#reprovision-every-registered-box-during-offline-maintenance).
