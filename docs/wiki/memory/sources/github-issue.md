# GitHub Issue Source

`github_issue` is an indexed, searchable, readable, incremental, external source. Default sensitivity is `internal`.

The source indexes GitHub issues and pull requests through the Issues API. Issues and PRs share the same source type; document frontmatter distinguishes `kind: issue` from `kind: pull_request`.

## Source IDs

Source IDs use `owner/repo#number`:

```text
ficus-app/ficus#248
```

GitHub URLs are resolved from issue and pull-request links:

```text
https://github.com/ficus-app/ficus/issues/248
https://github.com/ficus-app/ficus/pull/248
```

## Frontmatter

Each issue or PR is one `memory_documents` row with frontmatter like:

```yaml
kind: pull_request
sourceLinks:
  - https://github.com/ficus-app/ficus/pull/248
repo: ficus-app/ficus
number: 248
state: closed
labels:
  - memory
author: octocat
```

## Chunk metadata

The document body contains the issue/PR body plus comments. Chunks include parent metadata, and body/comment chunks include event metadata parsed from comment markers:

```json
{
  "sourceType": "github_issue",
  "parent": { "repo": "ficus-app/ficus", "number": 248 },
  "event": { "actor": "octocat", "ts": "2026-05-18T12:34:56Z" }
}
```

## Policy and grants

`github_issue` supports the base ingestion policy plus repository and label filters under `scope`:

```json
{
  "enabled": true,
  "policy": {
    "timeWindowDays": 30,
    "scope": {
      "repos": ["ficus-app/ficus"],
      "labels": ["memory"]
    }
  }
}
```

`repos` is required for discovery and on-demand indexing; indexing fails closed when the source ID repo is not configured. When `labels` is set, an issue/PR must have at least one configured label. `timeWindowDays` bounds `list()` discovery using GitHub's `since` parameter.

Grant filters support `repos` and compile to indexed search filters against `frontmatter.repo`; malformed filters fail closed.

## Author-filtered projection

When the source squad's GitHub author filter is ON, indexing projects each thread
through `projectGitHubThreadForMemory` (`services/integrations/github/managed-content.ts`).
Comments that are held or denied, or whose author is not trusted, become fixed
placeholders. Approved revisions are indexed with their exact reviewed text. The
projection records `frontmatter.githubProjection` provenance. Search, outline and
backlinks hide GitHub documents that lack this provenance whenever the source or
calling squad has the filter ON. Approvals count only in the source squad.

## Limitations

- Requires GitHub API credentials available to the shared GitHub client.
- Uses GitHub issue comments; it does not ingest CI logs, commits, review threads, or Actions output.
- PRs are represented through the Issues API shape plus `kind: pull_request`.
- User identity remains the GitHub login.
- With the author filter ON, issue and PR titles and bodies are admitted on the
  author's trust: the REST API does not report who edited them.

Source class: [`GitHubIssueSource`](../../../../apps/core/src/services/memory/sources/GitHubIssueSource.ts).

Refreshed periodically by the external-source reindex runner (default 30 min) and via `POST /api/memory/:squadId/reindex` with the matching `source` value. See [Reindexing](../reindex.md).
