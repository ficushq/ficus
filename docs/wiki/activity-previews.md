# Inline Activity previews

Core generates compact previews from original source Markdown during Activity extraction,
not from stored truncated summaries. Global and squad pages and live upserts carry the
same required `SquadActivityItem.preview` field (also inherited by `GlobalSquadActivityItem`).

## Client contract

`packages/shared/src/squad-activity.ts` exports `ActivityPreviewSpan`:

```ts
interface ActivityPreviewSpan {
  text: string
  bold?: true
  italic?: true
  code?: true
  href?: string
}
```

`preview` is a flat array, suitable for inline web elements or nested native Text spans.
`summary` remains available as plain visible text, including an ellipsis when clipped;
it is **not** a legacy rendering fallback. Render the spans directly, without Markdown
parsing, source-message fetches, embedded HTML, images, tables or document-level UI.
Adjacent text can carry combined emphasis. Whitespace and block boundaries flatten to
spaces; image alt text remains text; raw HTML tokens are omitted. Code stays literal.

Example original source: `See [**#241**](ficus:ws:241) and [Ada](ficus:agent:deadbeef).`

```json
[
  { "text": "See " },
  { "text": "#241", "bold": true, "href": "ficus:ws:241" },
  { "text": " and " },
  { "text": "Ada", "href": "ficus:agent:deadbeef" },
  { "text": "." }
]
```

`parseEntityReference` and `EntityReference` are exported from `@ficus/shared`.
They retain the existing web grammar: explicit `ficus:ws:` numbers, UUIDs and UUID
prefixes, and `ficus:agent:` UUIDs/prefixes. Parsing does not establish access or resolve
ambiguity: clients must use the existing authorized resolvers and generic error UI.
Bare `#241` is text, never inferred as a reference. Authored link labels are retained.
HTTP(S) links (including bare URLs recognized by GFM) open with safe external behavior;
unknown/unsafe schemes render only their labels. Never infer links from code text; a code span is linked only when its authored parent was an explicit Markdown link.

The web reuses the existing authorized entity resolver. Activity supplies a narrow
agent-opening callback: resolved agents open in the feed's existing in-place agent view
(using the resolved agent's own squad, not the source row's squad). Standalone agents
use an embedded conversation modal. The callback also handles plain activation of agent
quick links in reference hover cards. Ordinary chat-reference navigation remains unchanged.
Opening and closing the Activity view keeps the mounted feed, selected filters and scroll;
it does not push a routed agent page that would reconstruct Activity on Back. Visibility alone does not preload reference data; hover/focus/touch/click indicate
intent. The source-row anchor and inline controls are siblings, not nested interactive
HTML. Source navigation supports keyboard activation and modified clicks; external
links use `noopener noreferrer`. Clicking an inline control does not activate the row.

## Bounds and truncation

- Chat keeps a 160-Unicode-code-point visible budget; other families keep 512.
- Ellipsis counts against that budget. Full destinations do not consume visible points,
  and clipped labels keep their complete destinations.
- Parsing accepts at most 65,536 UTF-16 code units. Larger inputs use complete lines
  inside that prefix, add an ellipsis, and suppress links so an incomplete destination
  cannot become a fabricated URL. A single oversized line may yield only an ellipsis.
- Token traversal stops at 64 levels or 8,192 visited tokens. If the lexer rejects
  source (including recursive Markdown below the input cap), or traversal exceeds
  either budget, discard all partial rich output and emit only bounded literal text
  from the original source with its literal structural prefix. This path never reads
  stored summaries and never produces links.
- Individual destinations are limited to 8,192 UTF-16 code units, with an aggregate
  32,768-unit destination budget per row. Excess destinations become plain labels,
  never partial links. The visible budget also bounds the number of nonempty spans.
- Unicode surrogate pairs are not split; the budget is code points, not grapheme clusters.

## Materialization and rollout

Migration `0185_white_celestials.sql` adds `squad_activity.preview` JSONB with `[]` as
its transitional storage default. All extractors generate spans from original sources;
previews participate in persistence hashes and both REST projections and live events.
Literal structural markers are prefixed separately, then enriched with work numbers
at the authorized read boundary. Source family selection, filters and permissions are
unchanged. Append-only webhook facts retain identity/authority: their original source
may regenerate presentation fields without deleting or reattributing the event.

**Existing retained rows must be regenerated from source before enabling updated
clients.** There is deliberately no parser/fallback for historical summaries. Plan a
coordinated rollout: apply the schema and new Core materializer, regenerate the retained
window, verify the results, then expose the updated client. This change does not itself
authorize a production migration, repair or deployment.

The existing leased repair command is the supported mechanism, from `apps/core`:

```sh
bun activity:repair --from <canonical-UTC-ISO> --to <canonical-UTC-ISO> --concurrency 1
```

Choose a window within the 30-day retention policy, at most 30 days wide, using canonical
millisecond UTC timestamps. Inspect the report for errors and rerun to verify idempotency.
The command reads original source snapshots; it cannot recover sources already deleted.
Local tests cover repairing intentionally damaged summaries/empty previews and repeat
repair idempotency, plus preview regeneration for immutable webhook rows. No production
regeneration has been performed as part of this implementation.

## Native adoption

Adopt only the reviewed **merged full Core SHA**, recorded in the delivery/PR evidence.
From a clean mobile worktree, the supported update process is:

```sh
bun run core:update -- <full-40-character-merged-Core-SHA> [--source /path/to/core]
bun run dependencies:check
```

Revalidate those commands against the current mobile base. The updater uses an isolated
exact-SHA checkout to pack shared/client-core/client-react and updates provenance and
archive/lock integrities. Do not hand-edit packed packages. Coordinate package pins with
other mobile changes before adoption. This Core change includes no native repository
edits or release actions. Native rendering should preserve the existing compact line
limits and feed scroll context, routing references through authorized in-app resolution.

## Activity subjects and received-message rollout

The primary row identity names its destination. Inbox messages and system notifications
identify their recipient (`agentId` and `agentTypeId`), not their sender. Descriptions say
“Received message from …”, “Received report from Subagent …”, or “Received system
notification …”. An unknown or foreign agent sender is “an agent”, never “system”.
Sender descriptors come only from the recipient's squad; terminated sender/recipient
records remain eligible. Inbox access still gates the row, and `agents:read` still gates
the primary agent-type attribution. Message text and same-squad sender descriptions are
inbox content, not a new grant of access to another squad's agent records.

Subagent reports remain one event in both Messages and Subagents. Spawn/abnormal-end rows
identify the parent whose chat hosts the transcript; no extra completion row is added.
Work, wait and handoff rows identify their work stream; PR/issue rows identify the external
resource. Their existing agent attribution is secondary (handoffs already describe the
recipient), and work objects never borrow an actor's live dot. Shared subject labels also
use “Agent”, not “system”, for missing/redacted agent types. Web received-message focus is
preserved even in the historical/off-roster conversation fallback.

No schema migration is required. Stable lane/row IDs and existing payload hashes let the
leased desired-state repair **update**, rather than duplicate, existing message rows.
A deployment alone does not refresh all history: the hourly/daily sweep only covers 48
hours, while retained history extends 30 days. Before enabling the new clients, an
**explicitly authorized operator** should:

1. Deploy the updated Core materializer, then freeze a UTC upper boundary and cover the
   retained window using consecutive, at-most-one-day repair windows and `--concurrency 1`
   with the existing command above. Keep the projection pass enabled; never delete the
   projection to force a rebuild. The command uses bounded pages and the shared repair
   lease, and clamps to retention. Process one window at a time.
2. Require zero errors in every report. Inspect representative ordinary messages, system
   notices and terminated-subagent reports: the stored agent and agent ref must name the
   same recipient; event identities/counts must not double. Verify recipient agent filters
   and both global/per-squad read paths, including viewers without agent-type access.
3. Rerun each frozen window to check idempotency (zero changes absent source mutations),
   then refresh client queries. Deleted original source records cannot be reconstructed.

The database regression covers a ten-day-old legacy sender-attributed projection, bounded
one-row pages, concurrency one, terminated agents, both read paths, recipient filters and
repeat-repair idempotency. No production repair, deployment or native release is performed
by this code change. Native clients adopt the same shared subject-label helper through the
repository's exact-SHA package/provenance update workflow; no packed file is edited by hand.
