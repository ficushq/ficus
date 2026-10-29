# Managed GitHub memory freshness

Policy approved on 2026-10-29. This page describes the managed GitHub memory contract.

Managed GitHub memory must never return locally known obsolete prose just because
its author remains trusted or an older matching revision was approved. Freshness
is independent of the GitHub author filter: OFF bypasses trust, not freshness.

## Snapshot provenance

Projection schema 2 binds every included parent/comment to its numeric repository
and native object IDs, exact body hash (and parent title hash), provider update
clock, and author/editor provenance. Captured items additionally bind the exact
revision ID, content hash and sequence. This applies to trusted automatic items
as well as approved items.

Uncaptured, untouched API text from a currently trusted author remains usable
with complete snapshot hashes/clock and the observed local object sequence
watermark. This snapshot proof is not approval. Edited text still requires
captured, admissible provenance. Old matching text is not evidence of currentness.
Missing identities or ambiguous ordering fail closed.

Index projection and every managed read compare provenance against current local
captures. A captured native comment deletion is terminal for its identity. For
non-deletion revisions, differing valid provider clocks determine order; equal or missing
clocks use capture sequence, as in event delivery. A newer held or denied capture
can invalidate older admitted prose. Shared reads also check the caller's known
versions; source-squad approval never grants permission to another squad.

If any included item is stale or unprovable, withhold the whole cached document,
including titles, snippets, headings and backlinks. Schema 1, absent and malformed
provenance fail closed in both filter modes. Other memory source types are
unchanged. Reads stay bounded and provider-free. This guarantee covers locally
known changes, not GitHub edits that have not yet been fetched or captured.

## Automatic recovery and visible status

Approval includes two binding requirements:

1. A read detecting stale or legacy provenance must enqueue bounded, deduplicated
   document reindex work through the existing reindex path. Legacy content must
   not remain hidden until an unrelated edit happens.
2. Managed memory status in both API and CLI must report hidden-pending counts
   and distinguish stale from legacy provenance.

The existing external-source reindex service runs periodically and discovers
items through each adapter's list method. It has no document-addressed enqueue
operation, and discovery limits/time windows can omit an existing document. This
limitation was reported before implementation.

Recovery uses durable pending-reindex state on the affected
document, consumed by the **existing** external-source runner/service through the
adapter's normal single-document index path before ordinary discovery. A read
marks at most 25 newly pending documents; each source pass retries at most 25.
Repeated reads deduplicate by document generation. The existing runner's default
interval is 30 minutes; no provider work runs on the read path. Repeated failed or
still-unprovable recaptures back off exponentially from 30 minutes to 24 hours;
not-yet-due requests do not consume the 25 retry slots. This backoff applies only
to the recovery drain: ordinary webhook and discovery indexing run immediately
and clear recovery state once admissible content is indexed. Only confirmed
HTTP 404/410 or explicit repository exclusion in a present, valid source config
permits local deletion. Permission errors (including non-rate-limit 403), missing
configuration, unavailable identity, refused redirects and label mismatch retain
the document for retry.
A missing numeric repository identity is a fetch failure, never an empty rewrite;
repository identity is fetched once per repo and squad per indexing pass.

Recovery respects source enablement and scope, retains failures for later ticks,
and clears pending state only after successful current, admissible indexing,
requiring the source squad's admissibility and the requesting shared-memory
caller's **freshness only**. The caller's trust/approval gate remains enforced on
its reads, but cannot pin another squad's recovery. Caller-only filter/decision
denials do not enqueue a source reindex that cannot repair them; freshness
invalidations and source-squad gate changes do enqueue recovery. Pending state survives
process restarts. Clearing compares the validated document generation and marker
so old work cannot clear a newer request. GitHub document/chunk replacement is
transactional: failed indexing keeps the prior snapshot and recovery request. No new background job type, bulk migration or live
reindex operation is authorized.

`GET /api/memory/:squadId/sync/status` and `ficus memory sync status --squad <id>`
include the following source-squad status (also preserved in CLI JSON output):

```json
{
  "managedGitHub": {
    "hiddenPendingReindex": 3,
    "reasons": { "stale": 1, "legacy": 2, "filter_changed": 0, "decision_changed": 0 }
  }
}
```

These are durable requests discovered by reads, not a bulk scan of unread legacy
documents. A pending marker hides the document from the requesting reader until
recovery completes, not from an independently admissible source-squad reader.
Counts describe source-owned documents hidden in at least that requesting context;
they do not imply that every squad has lost access to each document. Disabled
sources and failed fetches retain their pending counts; status exposes no prose. Normal reindex can restore current admissible
items while continuing to withhold untrusted or unverifiable content.

## Verification contract

Focused tests cover trusted and approved snapshots becoming stale without
reindex; older/equal/missing clocks; changed parent and comment text; legacy and
malformed provenance; filter OFF and ON transitions; shared-squad isolation;
repository identity; bounded lookup failure; and captures between fetch and
index. Keyword/vector retrieval, indexed-document reads, outline and backlinks share
the freshness gate. Returned snapshots cannot borrow a concurrently reindexed
document's proof.

Recovery tests exercise deduplication, bounded read enqueue, recovery of a
document outside ordinary discovery, disabled-source and failure persistence,
current reindex completion, and API/CLI status reporting. Read-time checks do
not fetch providers. Revision reads batch (squad, repo, object) identities in
chunks of at most 500; large reads do not become stale merely because their
captures exceed a global row limit. Trust reads batch per squad; marking pending
documents is one bounded update.
Search limits and backlink results are capped at 100. Mixed query generations
are rejected before merging/deduplicating search hits and before returning outline
results. Unrelated memory source semantics are unchanged.

### Query-plan verification

`managed-content-scale.test.ts` exercises 100 documents with 101 items each in two
squads (20,200 captures) alongside 50,000 unrelated objects. A real PostgreSQL
`EXPLAIN (ANALYZE, BUFFERS)` exposed sequential object scans for the JSON-recordset
`EXISTS` predicate. The implementation now uses grouped equality/IN predicates
on the existing `(squad_id, repository_id, object_kind, native_id)` identity index.
The regression requires index-backed access and no sequential object scan, and
verifies that all 100 documents remain readable across 41 bounded queries.

On the synthetic fixture measured 2026-10-29, the full freshness read took roughly
1.4 seconds and one 500-key batch took 20.7 ms. The batch selected 500 objects by
bitmap/index access and used primary-key index probes for currentness. These are
local fixture measurements, not production latency guarantees.

## Captured comment deletions

Authenticated `issue_comment` / `deleted` webhooks cover both issue comments and
PR conversation comments. `pull_request_review_comment` / `deleted` covers inline
review comments. They bind numeric `repository.id`, `comment.id`, object kind,
and the native comment URL's repository, parent number and fragment. The assigned
connection must still have access to that numeric repository and matching name;
a repository recreated under the same name cannot inherit an old deletion.
The normalizer strips deleted body, author/login, parent title and file path.
A poll or payload/metadata claiming to be signed cannot create a tombstone.

Capture appends a content-free revision using existing storage:
`reason: comment_deleted`, `decision: historical`, `releaseState: retained`,
`envelope: null`, `providerVersion: null`. No DB migration is required. The normal
capture transaction and authority/object locks serialize invalidation with final
delivery. No rule, notification, screening or feedback-approval execution is
triggered by deletion; it is captured even for memory-only resources with no
matching output rule. Author trust and filter OFF do not disable invalidation.

GitHub supplies no deletion timestamp: `comment.updated_at` describes the last
edit, **not** deletion. The factual event's local observation time is display-only.
Deletion is terminal for `(squad, repository ID, object kind, native comment ID)`:
it outranks every content revision regardless of arrival order, provider clock,
or capture sequence. The same SQL predicate governs delivery and managed reads.
Redeliveries deduplicate to the same terminal revision. Delayed creates/edits,
including ones with a later clock, cannot resurrect that ID; a newly posted
comment has a different native ID. Accepted decision/audit records, delivered
revisions and canonical event snapshots stay unchanged; unfinished release work
may be marked obsolete by the existing invalidation path.

As soon as capture commits, all managed reads fence the old document, including
keyword/vector/hybrid results, titles, snippets, outlines, direct indexed reads
and backlinks. Source and caller currentness checks retain their squad isolation.
Reads enqueue the same bounded, deduplicated recovery and report `stale` counts.
The existing reindexer restores remaining admissible content and clears the
marker/count; even stale API pages with a later edit clock cannot re-add the
tombstoned item. No provider request occurs on a memory read.

### Event coverage and remaining limits

- The managed `github_issue` adapter indexes issue/PR parents and their
  `issue_comment` conversation comments. Inline `review_comment` objects are
  captured for feedback delivery but are not currently part of that memory
  adapter; deletion invalidates their feedback identity without poisoning a
  conversation comment with the same numeric ID.
- `pull_request_review` bodies are separate review objects. GitHub documents
  `submitted`, `edited` and `dismissed`, not a `deleted` webhook action;
  dismissal is not comment deletion. Discussion and commit comments are not
  supported by this managed adapter. Parent issue/PR deletion is not added here.
- Direct authenticated webhook dispatch and the hosted relay feed the same
  output normalizer. The relay schema accepts the native event type and payload;
  no new subscription/event type is needed. Subscription/scope and connection
  access remain prerequisites. Unavailable repository authorization defers an
  already-recorded output through existing reconciliation, never grants access.
- Polling does not synthesize deletions from missing comments. Unreceived,
  unauthenticated, malformed or out-of-scope deletions are not local knowledge;
  until a deletion is captured or a successful reindex sees absence, old text
  may remain retrievable. There is no bulk replay or live-provider read check.

Native event schemas: [issue_comment](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment),
[pull_request_review_comment](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review_comment),
and [pull_request_review](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review).
Implementation boundaries: `services/webhooks/dispatch.ts`,
`services/integrations/relay/runtime.ts`, `services/integrations/outputs/github.ts`,
`services/integrations/github/{ingress,feedback-resource,feedback-store,feedback-obsolescence}.ts`
(all under `apps/core/src`), and `packages/shared/src/integration-relay/protocol.ts`.

Focused regressions exercise native capture through managed reads, trusted and
human-approved history, OFF/shared isolation, wrong repository/kind/native ID,
deferred/repeated and delete-before-create delivery, immutable approved snapshots,
and recovery/status counts with remaining admissible content.

Policy approval does not constitute code review or merge approval.
