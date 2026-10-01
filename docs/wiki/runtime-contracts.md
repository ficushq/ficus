# Runtime contracts

Maintained developer reference, reconciled with source on 2026-09-08. This page preserves constraints from the VM, browser and maintenance implementation records. It describes checked code paths and design requirements; it does not certify a deployed fleet or repeat historical test results as fresh acceptance evidence.

Detailed operating guidance lives in [VM runtime](machines/runtime.md), [machine upgrades](machines/upgrading.md), [remote hosts](remote-hosts.md) and control-plane operations. Unresolved acceptance and hardening work is indexed in runtime follow-ups.

## VM ownership and lifecycle

A machine is managed sandbox substrate. A box is a dedicated Unix user and sandbox server on that machine, accessed through SSH forwards. A remote host is an existing system a squad can SSH into; registering it does not authorize machine bootstrap or box installation. Preserve this distinction in APIs and UI.

- **Resolve placement once.** Environment construction, reverse callbacks and box ensure must use the same selected machine. A live existing box stays on its recorded machine when its pin is null; an unpin is not an implicit migration.
- **An explicit pin change must account for the old box.** When the old machine is reachable, remove its forward, preserve role-appropriate private state and tear down the old box before rebinding. A teardown failure must not silently orphan the old Unix user and unit. Dead-machine recovery is a separate branch with different available evidence.
- **A client belongs to an endpoint and authentication identity.** Replace stale clients when addressing or credentials change. Reuse a healthy unchanged client: closing it aborts in-flight requests, including Bash streams. Routine Core shutdown releases that process's clients and forwards, rather than deleting persistent boxes.
- **Private storage must remain private.** Separate Unix users and protected homes are part of the VM isolation boundary. A shared rootful Docker daemon would make each Docker member root-equivalent over other boxes; squad/system-manager boxes use per-user rootless Docker instead. Shared-host kernel isolation is still weaker than a separate VM per tenant.
- **Resource and process ownership are explicit.** Current provisioning installs per-box memory, CPU and task limits. Agent boxes use root-owned system units and their own slices; rootless-Docker boxes use user units and user slices. Socket activation can leave the socket healthy while the idle server is stopped. Completion-critical work stays in a tracked foreground Bash invocation; detached children have no survival guarantee across idle exit, park, restart, migration or removal.

Source: [VM manager](../../apps/core/src/services/sandbox/vm/manager.ts), [box manager](../../apps/core/src/services/machines/box-manager.ts), [box provisioning](../../scripts/machine/box-provision.sh). The original rationale is retained in the VM design and machine UI implementation record.

## Lifecycle events must have producers

Every new `EventMap` lifecycle key needs a real `eventEmitter.emit` producer, emitted after the authoritative database write. Declaring a key and adding a WebSocket bridge alone does not make the UI update. Preserve the exhaustive bridge mapping and permission-scoped subscription behavior. Machine health should emit on actual status transitions, and box events must identify the owning machine.

Current producers are in [machine routes](../../apps/core/src/routes/machines.ts), [machine health](../../apps/core/src/services/machines/machine-health.ts) and [box manager](../../apps/core/src/services/machines/box-manager.ts); routing is in the [WebSocket bridge](../../apps/core/src/services/ws/bridge.ts).

## Browser boundary and shared capacity

For VM boxes, the shared machine browser service owns Chromium and exposes authenticated HTTP verbs over a Unix socket. Box servers forward browser calls; Core's seven browser tools resolve their backend afresh on each invocation. The host runtime is a deliberate exception: it supplies an in-process browser backend with a different network boundary. Do not apply the VM isolation claims to that local host backend.

- The service authenticates the box user against a token digest and scopes every page lookup to that user's `BrowserContext`. Requests carry a `runId` inside the authenticated context, not an arbitrary context identifier. Boxes receive no CDP handle with which to enumerate other contexts.
- Downloads are disabled when contexts are created. Contexts and pages are ephemeral: the service reaps idle pages after ten minutes and contexts after fifteen. A browser restart loses sessions; callers must open their pages again.
- The default VM/container host filter rejects loopback, link-local, metadata and `.internal` destinations, with normalization for encoded IP forms. HTTP(S) scheme/host checks cover initial navigation and intercepted context requests, including redirects and subresources. This is a hostname filter, not a DNS-resolution or network isolation guarantee; ordinary RFC1918 addresses are deliberately allowed.
- A box shares **three page slots** across its parent agent and subagents. A new run normally evicts that box's least-recently-used realized page; it can receive 429 when all slots are still opening. Net-new pages also face a machine-wide ceiling derived from `MemoryHigh / 256 MB` (at least one). Pending creations count toward capacity. This is a shared machine budget, not a per-agent entitlement.
- Keep Chromium's sandbox enabled as a deployment requirement. Bootstrap contains a sandbox verification gate and a browser-unavailable path. This source review did not run real Chromium or establish that every installed version satisfies that gate; see the acceptance work below.

Source: [Core browser tools](../../apps/core/src/tools/browser.ts), [browser service](../../scripts/machine/browser/ficus-browser.js), [service unit](../../scripts/machine/browser/ficus-browser.service), [bootstrap](../../scripts/machine/bootstrap.sh). Historical scope and adjudications: browser design, Phase 2 rulings, Phase 3 implementation. Earlier proposed cleanup hooks and acceptance checklists are not proof of current runtime behavior.

## Instance maintenance

Maintenance has independent holders: an administrator's manual hold and a platform lease. Effective pause is their logical OR. Releasing or expiring the platform lease cannot clear the admin hold; releasing the admin hold cannot clear the platform lease. Lease identity and owner token determine who may renew or release it.

Expiry is evaluated when state is read, using database time for authoritative locked reads. A timer is not required to make an expired lease inactive. Core's cached check also considers expiry. This keeps a crashed maintenance caller from leaving the instance paused indefinitely.

Execution pickup has a cheap cached check and an authoritative maintenance read inside the transaction that claims the execution. The lock order places maintenance before machine boxes. API and worker are separate processes: the change signal is a fast notification, while durable state and boot/periodic reconciliation provide the backstop. Do not replace the locked gate with a notification or a process-local flag.

The worker parks queued work as `waiting-maintenance` and interrupts active sessions, waiting for settlement and rechecking the generation before parking or acknowledging quiescence. A terminal `stop` is not equivalent to pause. Unknown or unsettled effects must not be acknowledged as safely quiesced. Release resumes eligible parked work through the maintained store/admission paths, rather than assuming every interrupted tool can be replayed without consequences.

Platform callers renew their lease, verify returned ownership and expiry, and fail when ownership is lost or too near expiry for safe work. Mutating maintenance operations must honor that ownership check; acquiring a lease once does not grant indefinite authority.

Source: [maintenance store](../../apps/core/src/services/maintenance/store.ts), [pickup](../../apps/core/src/services/execution/pickup.ts), [worker controller](../../apps/core/src/services/maintenance/worker-controller.ts), platform lease helper. The original pause handoff predates the current database singleton and admission machinery; its suggested settings-table implementation is historical.

## Updating the control plane

Build and preflight the candidate before draining or restarting the service that supplies the operator's UI. A failed build/preflight must leave the active release untouched. Freeze the target SHA, persist attempt state, and run update reconciliation through the independent update runner so a service restart does not erase the operation.

The current reconciler stages, preflights, drains running jobs, activates and verifies the successor; activation/verification failures enter rollback. Preflight executes the built verifier, checks server/web output presence, migrations, release SHA and health/web responses. Successor verification checks consecutive live health responses, the running systemd process's release directory and that release's SHA. Protocol compatibility and pinned-updater freshness are additional gates.

**Version identity must correspond to the running release.** Checking a mutable source checkout's HEAD alone cannot establish which JavaScript bundle is serving traffic. The current version module caches a Git identity from the process's release directory; it does not independently hash the loaded bundle. The managed release pipeline supplies the build/preflight and process-directory checks that make that identity meaningful. Manual or legacy deployment paths need their own evidence and must not equate a successful fetch with a successful upgrade.

Source: reconciler, preflight, artifact verifier, update runner, version identity, updater protocol. Preserved rationale: control-plane update handoff.
