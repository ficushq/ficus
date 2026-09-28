# Linear Issue Source

`linear_issue` is a live, searchable, external source. Default sensitivity is `internal`.

Linear is queried at `memory_search` time through Linear's GraphQL `issueSearch`; Ficus does not persist Linear issues into `memory_documents` or `memory_chunks` in Phase 5.

## Source IDs

Live results use Linear's issue UUID as `sourceId`. The display title includes the human-readable identifier:

```text
sourceId: 00000000-0000-0000-0000-000000000000
title: ENG-123 — Fix flaky memory search
```

## Live result provenance

Each result includes a snippet from the issue description, `internal` sensitivity, and provenance:

```json
{
  "url": "https://linear.app/acme/issue/ENG-123/fix-flaky-memory-search",
  "teamKey": "ENG",
  "state": "In Progress",
  "assignee": "Ada Lovelace"
}
```

The result event timestamp is `updatedAt` from Linear:

```json
{ "ts": "2026-05-18T12:34:56Z" }
```

## Policy and grants

`linear_issue` is live-only, so there is no ingestion policy and no reindexing. Search access is controlled by normal memory grant scopes plus the source-specific grant filter:

```json
{
  "sourceTypes": ["linear_issue"],
  "sourceFilters": {
    "linear_issue": {
      "teamKeys": ["ENG", "OPS"]
    }
  }
}
```

`teamKeys` narrows the live Linear query by appending `team:ENG,OPS` to the search string. Missing `teamKeys` means unrestricted within the caller's granted Linear scope. Malformed filters fail closed during scope expansion.

## Limits and failure behavior

- Requires the calling squad’s enabled Linear integration account in the secret store, or `LINEAR_API_KEY_OVERRIDE` for local development.
- Returns at most 10 results per live search.
- `SearchService` enforces the adapter timeout (`2.5s`) and rate limit (`30/minute`).
- HTTP or GraphQL errors return no Linear rows instead of failing the whole memory search.
- User identity remains the Linear display name.

Source class: [`LinearLiveSource`](../../../../apps/core/src/services/memory/sources/LinearLiveSource.ts).

Configure credentials and account assignments through [Linear Integrations](../../linear-integrations.md). There is no global API-key fallback for live search.
