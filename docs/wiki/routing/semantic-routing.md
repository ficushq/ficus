# Semantic routing

Semantic routing helps a squad decide where work belongs before creating or forwarding it. It is advisory: Ficus returns ranked squad suggestions with evidence, but an agent or human still chooses the action. Routing must fail loud with clarification or escalation instead of silently guessing.

## Overview

The routing API and `suggest_squad` tool evaluate a question from the caller squad's readable context and return:

- `suggestions`: ranked squads with `score`, structured `evidence`, and backwards-compatible text `reasons`
- `recommendation`: `route`, `clarify`, or `escalate`
- `confidence`: the top suggestion score, or `0` when no usable candidate exists
- `reason`: a short explanation of the recommendation

The HTTP shape is available at `GET /api/routing/:squadId/suggest-squad?question=...`. The squad manager can use this recommendation when coordinating work across squads. Channel consultants stay in the configured squad and consult its manager when a request belongs elsewhere.

## Signals

The suggester stays intentionally lightweight. It scores candidate squads from the caller's authorized read scope using three evidence kinds:

- `purpose`: overlap with the squad name/purpose/description.
- `memory`: general memory search hits from accessible sources.
- `ownership`: hits under `/memory/ownership/*.md`, including explicit `squadIds` frontmatter matches.

Each suggestion contains `evidence: RoutingEvidence[]`:

```ts
{
  kind: 'purpose' | 'memory' | 'ownership'
  score: number
  description: string
  source?: {
    sourceSquadId: string
    sourceType: string
    path?: string | null
    title?: string | null
    snippet?: string
  }
}
```

`reasons` is retained as `evidence.map((item) => item.description)` for older callers. Source-backed evidence can cite memory files, Slack threads, GitHub issues, Linear issues, and other indexed source types returned by memory search.

## Ownership docs

Ownership documents are plain Markdown memory files under `/memory/ownership/*.md`. They are the canonical place to describe which squad owns a domain, repository, channel, product area, or support surface.

Use the convention documented in [ownership docs](../memory/conventions/ownership-docs.md): include `kind: ownership`, a `title`, and at least one of `domain` or `squadIds`. When `squadIds` is present, every listed squad ID is treated as an explicit owner if that squad is within the caller's readable candidate set. This boost lets a company/core squad maintain ownership docs that route to another squad without relying only on prose overlap.

Ownership claims should cite `sourceLinks` when possible and use durable IDs rather than display names.

## Work-stream source links

Work streams reserve `metadata.sources` for `WorkStreamSourceLink[]`. Source links explain why the work exists and where agents should look for context.

Supported `kind` values are:

- `memory_document`
- `agent_thread`
- `slack_thread`
- `github_issue`
- `linear_issue`
- `channel_message`
- `url`

Common fields are `sourceSquadId`, `sourceId`, `path`, `title`, `url`, `snippet`, and `addedAt`. Creation validates kind-specific requirements: memory documents need `sourceSquadId` and `path`; Slack/GitHub/Linear links need `url` or `sourceId`; URL links need `url`. If `addedAt` is omitted, work-stream creation fills it.

The CLI exposes source-link flags for explicit creation from context:

```bash
ficus workstream create "Investigate refund failures" \
  --squad <squad-id> \
  --from-memory <source-squad-id>:/memory/ownership/billing.md \
  --from-slack <slack-permalink> \
  --from-url https://example.com/context \
  --source-link '{"kind":"github_issue","url":"https://github.com/acme/app/issues/42"}'
```

Work creators should attach Slack permalinks, cited memory documents, external URLs, or structured `--source-link` JSON when creating work. This makes routed work auditable without adding a new table.

## Channel conversations

External conversations use ordinary consultants. Ingress selects the squad from
channel overrides or the connection default, before any model runs. Channel
consultants own work requested through the channel so they can relay lifecycle
updates, and coordinate cross-squad requests through their squad manager. The
suggester is advisory; it never grants access or overrides channel authorization.

## Limitations

- Routing is advisory. It does not auto-create or auto-transfer work.
- The ranking model is heuristic keyword and memory evidence scoring, not a dedicated ML router.
- Suggestions only consider squads and sources visible through the caller's memory scope.
- Cross-squad work creation is not a separate primitive; use the existing forwarding/handoff path when another squad must act.
- Ownership docs are ordinary memory files, so their accuracy depends on review and update habits.
- Source links live in work-stream metadata, not in a dedicated audit product.
