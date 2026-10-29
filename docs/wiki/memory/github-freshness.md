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
captures. Differing valid provider clocks determine order; equal or missing
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
not-yet-due requests do not consume the 25 retry slots. Confirmed provider denial
(including deletion) and repo/label scope exclusion remove the obsolete local
document instead of retrying forever. Transient provider failures preserve it.
A missing numeric repository identity is a fetch failure, never an empty rewrite;
repository identity is fetched once per repo and squad per indexing pass.

Recovery respects source enablement and scope, retains failures for later ticks,
and clears pending state only after successful current, admissible indexing,
requiring the source squad's admissibility and the requesting shared-memory
caller's **freshness only**. The caller's trust/approval gate remains enforced on
its reads, but cannot pin another squad's recovery. Pending state survives
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
not fetch providers. Revision reads batch all (squad, repo, object) identities;
trust reads batch per squad; marking pending documents is one bounded update.
Search limits and backlink results are capped at 100. Mixed query generations
are rejected before merging/deduplicating search hits and before returning outline
results. Unrelated memory source semantics are unchanged.

## Known limitation

Comment deletion events are not currently captured as revisions. A deleted
comment can remain locally retrievable until an ordinary successful reindex
observes its absence. The local-currentness guarantee does not detect unseen
remote edits or deletions, and reads never fetch GitHub to discover them.

Policy approval does not constitute code review or merge approval.
