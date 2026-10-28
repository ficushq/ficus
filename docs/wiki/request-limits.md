# Request limits and file transfers

Core bounds ordinary request bodies before their handlers parse them. Limits count **UTF-8 wire bytes**, not JavaScript characters or decoded image sizes. MiB and KiB below are binary units.

## Body budgets

| Requests | Maximum body |
| --- | --- |
| Ordinary API mutations, including newly added routers | 1 MiB |
| Chat, inbox sends, agent messages, assistant controls, workstreams, workflows, squad/configuration and artifact controls | 4 MiB |
| Assistant entry batches (at most 50 entries) | 48 MiB |
| Provider webhooks and memory synchronization webhooks | 26 MiB |
| AMTP inbox envelopes | 4 MiB |
| Signed AMTP agent cards | 16 KiB |
| Image/screenshot JSON and squad avatar uploads | 16 MiB |
| Decision evaluate/try | 12 MiB |
| Legacy JSON file/text transport: memory write/patch/append/workspace-files, artifact file edits, squad environment content, skill content/support files | 128 MiB |

Existing smaller route budgets remain: push server connection 2 KiB; public URL and farm preferences 4 KiB; farm 16 KiB; product feedback 64 KiB; farm chat and theme preferences retain their domain constants. Internal event POSTs have a 4 MiB budget **after** internal-token authentication.

The exact method/path policy and precedence live in [`request-body-limits.ts`](../../apps/core/src/middleware/request-body-limits.ts). An upload-looking name or a multipart Content-Type does not grant an exemption.

### Files have separate transport policies

- **Workspace uploads:** no generic body-byte ceiling. Core stages multipart file streams in private temporary files, resolves late `path_<field>` fields, then streams complete files to verified atomic publication locally or through sandbox `/upload`. Temporary files are removed on success, failure and cancellation. Disk use grows with the uploaded files; available disk space, authorization, path policy and existing operational timeouts still apply. There is no new upload quota or unlimited-duration promise: the sandbox upload client retains its five-minute timeout.
- **Workspace downloads:** no new response-byte ceiling. Regular files, Range responses and directory tar.gz streams remain streaming, including `ficus squad download`. Transfer bytes are not truncated to an API budget. No separate task-workspace HTTP upload/download routes exist in the current router inventory.
- **Inbox, agent/chat and workflow attachments:** retain the configured per-file quota (default 10 MiB) with 64 KiB multipart framing headroom. Inbox and transcription reject excessive transport bytes before multipart parsing. Agent-private uploads retain 25 MiB plus framing; transcription retains 10 MiB audio plus framing.
- **Local-app proxy:** opaque requests and responses remain streaming and are not parsed or limited by this API policy. Application authorization and proxy lifetime rules still apply.
- Existing decoded-image size/count rules and attachment storage quotas remain independent of transport budgets. File/text contents in legacy JSON transports keep their previous 128 MiB transport ceiling.

### Workspace multipart envelope budgets

Workspace **file-content bytes remain unlimited**, but the multipart envelope has explicit resource budgets:

- Up to **1,000 files** and **1,000 corresponding `path_<file-field>` entries** per request, plus **256 other field entries**. Duplicate field entries count toward these budgets; the first value still wins. A path-looking field without a corresponding file counts as other metadata, so it cannot bypass that budget. These counts imply at most 2,256 parts. Larger file sets must use separate uploads, never silent omission.
- **4 MiB aggregate metadata:** decoded UTF-8 non-file field data, UTF-8 field names/filenames, raw part headers and framing (including boundary parameters, preamble and epilogue). Names and filenames are counted separately from their raw header representation. This is not a file-content-byte quota. UTF-8/BOM handling matches the native multipart reader.
- At most **4,096 header lines per part**. Long headers and more than 2,000 header pairs within these explicit budgets are accepted; there is no hidden 80 KiB header cutoff.

All parts must be parsed successfully before any file is published. Malformed or incomplete framing, count overflow and invalid headers return **400**; aggregate metadata-byte overflow returns **413** with `REQUEST_BODY_TOO_LARGE` and `maxBytes: 4194304`. Rejection cancels the input and removes every temporary stage rather than publishing or reporting success for a subset. Staging is sequential with at most one open staging-file descriptor. Only bounded part headers/non-file values use native multipart decoding; file contents stream directly to disk.

Bun's listener limit applies even to streamed request bodies. Core and the sandbox therefore explicitly use `maxRequestBodySize: Infinity`, **together with** bounded ordinary readers and exact transfer exceptions. The sandbox retains a 100 MiB ceiling for JSON and confined upload requests. Do not deploy the listener setting without these readers, or revert the readers while leaving the listener uncapped. Workspace upload/download requests disable only their listener's shorter per-request idle timer; cancellation, client budgets and sandbox idle-lifecycle accounting remain in effect.

## Collection budgets

Request arrays are bounded before element validation; request maps are preflighted before key/value validation can accumulate errors.

- References, permissions, scopes, image/attachment references: 100.
- Bulk IDs, file-index manifests and data rows: 1,000.
- General metadata/configuration maps: 256 keys. Caller-supplied nested metadata is checked too, before downstream configuration/delivery parsers; accumulated server-owned delivery/CI history is not capped on reads.
- Workflow participants: 64; outcomes retain the stricter existing 16 maximum. Decision questions and choice options: 64. Trigger/equality maps retain 16; synthetic event fields retain 32; theme override maps retain 64.
- AMTP envelope attachments: 100. Signed card JSON is preflighted iteratively at depth 32, 10,000 nodes, 1,000 array items and 256 object keys before upstream recursive validation. Original signed wire bytes are preserved.

Other explicit, stricter product bounds remain unchanged. Oversized control/configuration documents may need to be reduced before submitting or editing them; files are never silently truncated to satisfy a collection maximum.

### Indexing compatibility boundary

The workspace watcher can combine multiple patterns into one `reconcile: true` snapshot. A snapshot exceeding 1,000 files/skipped entries is now explicitly rejected as oversized metadata. This does **not** cap the bytes transferred by workspace upload/download. Do not truncate the snapshot or split it into independently reconciled requests: that could delete indexed paths omitted from each partial batch. Large snapshot support requires a separate complete-snapshot batching protocol.

## Errors

Ordinary byte overflow returns HTTP **413** with JSON such as:

```json
{"error":"Request body too large","code":"REQUEST_BODY_TOO_LARGE","maxBytes":1048576}
```

This applies to fixed-length and chunked requests and counts actual bytes even if an advertised length is smaller. Rejected bodies are cancelled; handlers do not perform their normal side effects. Malformed JSON under budget keeps HTTP **400** with `{"error":"Invalid JSON body"}`.

Collection overflow returns HTTP **400** using the route's validation contract, normally a `too_big` issue with its path and maximum. Existing protocol-specific AMTP and role-validation responses remain. Attachment quota errors retain their established 413 bodies.

## Sandbox bundle compatibility and rollout

Refresh sandbox server bundles before relying on large workspace uploads. A current bundle streams `/upload` through incremental writes and hashes; it does not materialize the whole file during staging or verification. Atomic publication retains path confinement, modes, conflict checks, inode/readback verification and classified failures. A failed candidate never becomes a partial destination; failures after rename explicitly avoid claiming rollback or success.

A pre-`/upload` bundle's 404 can fall back to JSON `/write` **only** when the exact base64 envelope (including path metadata) fits the old 100 MiB sandbox limit. Larger transfers, or a 413 from an older capped bundle, return a per-file sandbox-upgrade error rather than overflowing JSON, retrying a consumed stream or reporting a truncated success. Download compatibility continues to use the existing explicit outdated-bundle behavior.

No database migration or client protocol change is required. Roll back the listener setting and its route readers together. These bounds reduce byte/validation amplification; they are not a substitute for authorization, rate/concurrency control or disk capacity management.
