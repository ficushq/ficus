# Stored images and files in work streams

Images and files that Ficus already stores — chat images, chat files, flow handoff
files and inbox attachments — do not need to be copied into a workspace for an
agent to use them. A work stream can share a stored chat image or chat file **by
ID**, and every agent can **view** stored images with the `read_attachment` tool.
Downloading stays available for the cases where a local tool really needs the bytes.

## Where images and files live

| Kind                                    | Stored as                                                                                           | How an agent sees it                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Chat image                              | An `images` row; bytes under the Core home                                                          | Delivered with its message; later with `read_attachment` (`conversation-image`) |
| Chat file                               | An `agent_file_attachments` row; also copied into the receiving agent's private `chat-attachments/` | `read` on its private path, or `read_attachment` once shared with a stream      |
| Handoff file (`advance --attach PATH`)  | A snapshot per flow attempt                                                                         | `read_attachment` (`workflow-attachment`)                                       |
| Inbox attachment                        | An inbox attachment row                                                                             | `read_attachment` (`inbox-attachment`)                                          |
| Stored-asset reference                  | A share of a chat image or chat file, by ID                                                         | `read_attachment` (`workstream-asset`)                                          |
| Legacy work-stream file (`--file PATH`) | A workspace path in `files`                                                                         | `read`                                                                          |

Delivered chat images carry a short, model-only note naming their IDs, so an agent
can view them again after compaction or attach them to a work stream without
inspecting message metadata. The stored message is unchanged.

## Sharing a stored image or file with a work stream

```bash
# As a stream input (everyone who can read the stream can see it):
ficus workstream attachment add STREAM_ID --image IMAGE_ID
ficus workstream attachment add STREAM_ID --agent-file FILE_ATTACHMENT_ID

# At creation, before the first worker is assigned (repeatable):
ficus workstream create 'Fix the sign-in button' --squad SQUAD_ID --image IMAGE_ID

# As part of an attempt's result, alongside or instead of uploaded files:
ficus workstream advance STREAM_ID --stdin --attach-image IMAGE_ID <<'FICUS_COMMAND'
{ ... }
FICUS_COMMAND

ficus workstream attachment list STREAM_ID
ficus workstream attachment get STREAM_ID ATTACHMENT_ID --out SHARED_TASK_PATH
ficus workstream attachment remove STREAM_ID ATTACHMENT_ID
```

`attachment add` takes exactly one of `--image` or `--agent-file`; the two ID
namespaces are never mixed. Repeating the same source returns the existing share.
A share has its own ID: list, read and remove use the share ID, not the source ID.
`attachment get` also downloads a handoff file of the same stream by its ID.

A stream holds at most 10 stored inputs. An attempt's stored references and
uploaded handoff files share that attempt's limit of 10. Stored references to
attempt results follow the same rules as uploads: only the agent working the
attempt can add or remove them, only while it is open; closed attempts keep what
was reviewed. A done or canceled stream's shares are part of its record: adding
and removing them are both refused.

API: `GET|POST /api/workstreams/:id/asset-attachments`,
`GET|DELETE /api/workstreams/:id/asset-attachments/:attachmentId`,
`POST /api/workflows/runs/:streamId/attempts/:attemptId/asset-attachments` with
`{ "source": { "kind": "image", "imageId": "…" } }` or
`{ "source": { "kind": "agent-file", "attachmentId": "…" } }`. Stream creation
accepts the same sources as `assetReferences`. Stream detail returns
`assetAttachments` (inputs); flow detail returns `assetAttachments` keyed by attempt.

## Viewing without a download: `read_attachment`

A model only sees an image when it arrives as an image block; shell output is text.
`read_attachment` is therefore a tool, available to every agent beside `read`:

```json
{ "source": { "kind": "workstream-asset", "workStreamId": "…", "attachmentId": "…" } }
{ "source": { "kind": "workflow-attachment", "workStreamId": "…", "attachmentId": "…" } }
{ "source": { "kind": "inbox-attachment", "attachmentId": "…" } }
{ "source": { "kind": "conversation-image", "imageId": "…" } }
```

Raster images (PNG, JPEG, GIF, WebP) are classified from their bytes, resized like
`read` images and returned as image blocks. Short text files return bounded text;
anything else returns a description and the command that saves it. A model without
image input is told so and given the download command. The tool writes nothing,
changes no image status, and keeps no cache. `conversation-image` returns only sent
images (status `used`), as sharing does: never an unsent upload or a failed send.
An inbox attachment's filename and text come from its sender, so the filename is
escaped and the result is labelled as the sender's untrusted data (noting a remote
AMTP sender), as inbox delivery marks untrusted context. Assignments list the stream's stored
inputs and the incoming attempts' stored references and handoff files with ready
`read_attachment` arguments; an agent working the stream also gets a notice when an
input is added while it runs (not while the stream is paused or waiting).

## Authorization

Each source keeps its own rule; the tool and the reference API add no access:

- **Sharing** needs both sides. The caller must legitimately hold the source: an
  agent, an image or file from its own conversation (its sandbox and parent chain);
  a person, one they may read, where a private (user-owned) conversation is readable
  only by its owner, even against other administrators. The caller must also be
  allowed to edit the target stream. A source from a squad conversation stays in
  that squad; a private conversation's asset can be shared only by its owner.
  Staged (unsent), failed and avatar images are not shareable. An image counts as
  sent (`used`) once the agent's session has received its message, so an agent can
  share or re-read an image during the turn that delivered it.
- **Reading** a share needs `workstreams:read` on the stream and an active share of
  exactly that stream. Handoff files follow the same stream rule; inbox attachments
  follow the inbox recipient rule; conversation images follow the chat image scope.
- Missing, foreign, malformed and guessed IDs all get the same answer.
- Image signing for browsers uses the same owner-aware rule
  (`services/images/access.ts`): private conversations are owner-only, and an
  upload is readable only by its uploader until a message carrying it is sent, even
  when it is already bound to a squad conversation. From then on (while the message
  is still queued for the agent, too) the conversation's readers see it, as they see
  the message. Only the uploader can send such an upload; the one exception is a copy
  the Assistant forwarded, which its delivery sends to the agent it was copied for.

Attaching is an intentional share with the stream's readers. Removing an input, or
losing permission, stops new reads at once — the bytes endpoint is `no-store` and
clients fetch it afresh — but cannot recall copies already downloaded or already in
a model's context.

## Retention and cleanup

A share never copies bytes. A `retained_assets` row records the source's existing
blob (with its size and digest) and keeps it alive after the source row is deleted:
deleting a chat image or a chat leaves bytes in place while a share needs them.
When the last share goes (removal, stream deletion, squad deletion), the record is
released; if the source row is gone too, that exact blob is unlinked. A failed unlink
is retried by the agent-lifecycle convergence sweep, which also releases records
whose shares disappeared without a release. Each failure backs that record off
(15 minutes, doubling, at most a day), so failing records never hold up the ones
behind them. After 10 failures the sweep stops retrying it: the record keeps
`cleanup_failed_at`, `cleanup_attempts` and the last `cleanup_error`, its bytes
stay in place, and Core logs an error. Done or canceled streams, dormant or
deleted agents and worktree cleanup do not expire shares. Worktree cleanup only ever
considers registered worktree and repository paths, never Core-held bytes.

Retained chat-file bytes count toward `INBOX_MAX_TOTAL_STORAGE_BYTES` once (only
after their chat row is gone, when they stop counting as chat files). Settings →
Storage lists retained files and images separately. Images keep their existing
classification and do not count toward the attachment quota.

## Clients

Web and Farm reviews show each attempt's stored references as document tabs beside
its handoff files, and the work-stream detail lists stored inputs. They are labelled
by origin, never given a path, and fetched afresh on each view. Older clients ignore
the new fields; legacy `files` and handoff snapshots are unchanged. The native mobile
app needs its own update to show stored references.

## When a file is still the right tool

Download only when a local tool needs the bytes (image editing, OCR, a test
fixture). Put scratch copies in a task directory outside the deliverable
repository unless the image belongs in the deliverable:

```bash
mkdir -p SHARED_TASK_DIR
ficus image get IMAGE_ID --out SHARED_TASK_DIR/screenshot.png
```

Do not combine `--json` with `ficus image get --out`; JSON mode prints metadata
instead of saving the file. `ficus workstream update --file PATH` replaces the
stream's whole `files` list of workspace paths, and `advance --attach PATH` uploads a
snapshot for review; neither accepts an image ID.
