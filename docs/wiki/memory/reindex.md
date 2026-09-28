# Memory Reindexing

`POST /api/memory/:squadId/reindex` refreshes indexed memory sources for a squad.

| source           | manual route | scheduled?                                                     | agent_thread search |
| ---------------- | ------------ | -------------------------------------------------------------- | ------------------- |
| `memory_file`    | ✅           | on-write (`ReindexScheduler`)                                  | n/a                 |
| `workspace_file` | ✅           | sandbox watch + ad-hoc                                         | n/a                 |
| `slack_thread`   | ✅           | every 30 min (`ExternalSourceReindexRunner`)                   | n/a                 |
| `slack_canvas`   | ✅           | every 30 min (`ExternalSourceReindexRunner`)                   | n/a                 |
| `github_issue`   | ✅           | every 30 min (`ExternalSourceReindexRunner`) + GitHub webhooks | n/a                 |
| `agent_thread`   | ❌ 400       | execution events only                                          | **disabled**        |
| `linear_issue`   | n/a (live)   | n/a (live)                                                     | n/a                 |

`source=all` refreshes `memory_file`, `workspace_file`, `slack_thread`, `slack_canvas`, and `github_issue`. It deliberately excludes `agent_thread`.

External indexed sources are skipped when their `SquadSourceConfig.enabled` value is `false`. GitHub issue/PR documents are also refreshed from GitHub webhook events that carry an affected issue or pull request number, for squads whose `github_issue` source policy includes the repository. Agent threads are indexed automatically from execution lifecycle events, are not user-reindexable, and are stripped from search while `AGENT_THREAD_SEARCH_ENABLED` is `false` in `@ficus/shared`.
