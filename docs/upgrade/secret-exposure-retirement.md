# Secret exposure retirement

Squad, global and per-agent Secret Store exposure has been removed. The upgrade drops the three exposure tables, not the encrypted operator values. Exposure settings, API routes, CLI subcommands, agent prompts and web panels no longer exist. Exposed values are **not** copied into Environment Variables, workspace files or integration connections. The only credential conversion is the separately documented [deployment-provider upgrade](deploy-provider-connections.md).

Custom secrets belong in squad **Workspace → Environment Variables**, or files chosen by a person. Environment Variables remain visible to agents and terminals; `env.user` and other custom files are preserved. Integration credentials are delivered only through per-command integration exec. Human terminals remain token-free and can use the person's own provider login. Operator `ficus secret`, `/api/secrets` and feature-owned encrypted storage remain available.

## Detection compatibility on upgrade

Integration exact matching now uses secret leaves of at least **8 characters**;
new manual/channel secrets enforce that minimum too. Shorter legacy leaves are
not exact-matched; independent credential-pattern detection remains active.
Rotation/deletion retains encrypted prior integration material for **one hour**,
including across restart, with the original expiry rather than a renewed grace.
This is detection coverage, not provider revocation or persistent sandbox delivery.

Existing `.ficus/env.user` files receive a **one-time** trusted snapshot, capped
at **256 KiB** (UTF-8 bytes). Trusted hashes/parsed output-only entries live in a
protected DB table independent of the encryption key; a separate durable bootstrap
marker prevents re-trusting disk after record deletion/corruption or restart.
Thereafter only Environment API/service saves register values. Later direct disk edits
are ignored for detection, with a once-per-squad-per-process warning and a notice
in Environment Settings; explicitly save there to register changed or unchanged
values. Oversized/unreadable legacy files are skipped with a notice, not repeatedly
snapshotted. API/service writes share the cap; Settings reads fail safely without
editable partial/empty substitutes. Reduce an oversized file outside Settings,
reload, then save; failed reads and over-cap rejected writes leave the file unchanged. Public/publishable
keys are excluded, and env entries never refuse input, including failed-query
attribution. No integration credentials are copied into this env authority. See
[full detection limits and persistence](../wiki/integration-execution.md#detection-boundaries).

## Automatic cleanup after upgrading Core

Every environment regeneration immediately stops emitting exposure exports. The worker also starts an independent cleanup sweep at startup and checks for due targets every minute, including after a Core restart. No agent activity or sandbox ensure is needed to start cleanup.

Cleanup has durable per-target acknowledgements in `sandbox_exposure_cleanup`:

- Squad targets regenerate `.ficus/.env` from custom `env.user` content and current nonsecret integration configuration, including archived squads. Legacy generated content is never promoted to `env.user`.
- Private-directory targets remove the retired `.ficus/agent-secrets.env`; shared Docker/Kubernetes mounts and host storage reflect these changes directly.
- VM targets force-push the regenerated `.ficus/.env` to each existing box, independently of ensure and previous file-sync hashes, then remove retired private files and copies in interrupted restore staging. Without a resolvable squad, a solo workspace environment is preserved; ordinary asset-manifest revocation handles known former squad copies. Private cleanup addresses only the old writer’s fixed path, not custom nested files.
- Private archive targets remove legacy plaintext files and stream-filter retired entries from Core's `private.tar.gz` archives without extracting them. Historical VM archive restore excludes retired private files and generated squad environment copies. Live VM migration instead sanitizes the quiesced source before taking its immutable snapshot: it replaces the squad generated environment and deletes the retired private file, then streams and verifies the resulting state byte-for-byte. This retains a clean environment before target startup without weakening missing-file, content or metadata verification. Custom `env.user` and unrelated archive entries survive.

The sweep is serial and processes at most 25 due targets per pass. Archive streaming is memory-bounded and has no size-dependent wall-clock cutoff; remote cleanup commands have bounded deadlines. A target is `done` only after its required file effects have acknowledged success. An unreachable VM stays `pending`; other failures are `failed` with a safe reason and exponential retries from one minute to at most one hour. Retry intervals survive Core restarts; logs are emitted only when status or reason changes. Targets whose VM box or owning machine has been deleted converge without attempting an unreachable connection. Ordinary startup and bulk integration refresh contain only known settings-directory conflicts so one affected squad cannot stop healthy squads or the cleanup worker. Cleanup, projection and migration acknowledgements use strict regeneration and never turn a skipped write into success. Other startup and I/O errors still propagate. A conflicting settings file or symlink is not overwritten or followed: repair it as an operator and let the automatic retry converge. The worker logs pending/failed targets, and agent/squad sandbox status responses include `exposureCleanup` with aggregate status and related target details. Missing acknowledgements are reported as pending, not success.

Ensure and VM attach/reconnect also invoke the same cleanup as a first-contact backstop for outstanding targets, bypassing the retry deadline when a runtime returns. A durable `done` target is not scanned or rewritten on subsequent contacts; changed squad assignment invalidates that acknowledgement. Cleanup failures do **not** gate agent or terminal execution, stop processes, or promise to erase values already inherited by an existing process. Inspect pending/failed targets rather than assuming all runtime copies were removed merely because Core upgraded. No cleanup status represents revocation of a credential at its provider.

This change ships automatic cleanup code; it does not authorize or perform a live deployment, credential inspection or manual fleet cleanup. See the [final credential model and acceptance matrix](../wiki/integration-execution.md#acceptance-matrix) for detection, agent guidance, managed seed updates and focused verification. Historical design documents describe the retired system, not current instructions.
