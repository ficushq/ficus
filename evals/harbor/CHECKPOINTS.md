# Private recovery checkpoints

Pass `--checkpoint-dir /absolute/private/new-directory` to `run-pilot.py` for a
Ficus trial. The directory must not already exist. Checkpoints contain private
state, including encrypted provider records and the local encryption key, and
must stay outside Git and published artifacts. The benchmark task receives only
the scoped proxy credential; the host provider key is never included.

After stopping its API and worker, the adapter freezes all task-container
processes, dumps its own disposable Postgres database, and saves a Docker image
of the container filesystem. This retains installed dependencies, Git history,
workspace changes, runtime data, and session files. Docker omits mounted paths,
so capture rejects every mount except Harbor's `/logs` and `/tests` trees. The
separate verifier and its tests are not copied into the checkpoint.

The directory is owner-only. Each file is owner-only, checksummed, and created
without overwriting an earlier capture. `checkpoint.json` is written last as the
completion marker. A failed capture is reported as `checkpoint_complete: false`;
never treat a partial directory as recoverable. Checkpoint image tags are removed
after saving. Normal trial container/database cleanup still runs.

`checkpoint.OfflineRestore` verifies all file hashes, loads the saved image, and
restores the database into newly named disposable containers. The task container
has **no network**, and the database shares its loopback namespace. Its entrypoint
is explicitly replaced with `sleep`; API and worker processes are not started.
Temporary restore containers and newly loaded checkpoint images are removed when
the context exits.

The `checkpoint_smoke:FicusCheckpointSmoke` probe seeds an actual native Ficus
workflow without starting a worker, saves it, and restores it offline. It compares
all snapshot and message fields, workspace/session fixture bytes, and decryption
of a fake provider credential. It does not contact a model provider.

This provides durable state capture and verified offline restoration, **not an
automatic inference-resume command**. A future continuation must bind a new scoped
proxy credential and current budget, preserve the original task/runtime, use
native execution recovery, and record resumed timing and cost separately. Never
start a restored worker against stale credentials or expose it to verifier
feedback. Recovery or repeated attempts must not replace interrupted first
attempts in the comparison. Checkpoint archive time is infrastructure overhead,
not agent implementation time.
