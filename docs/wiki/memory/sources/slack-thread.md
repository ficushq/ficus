# Slack Thread Source

`slack_thread` is an indexed, searchable, readable, incremental, external source. Default sensitivity is `internal`.

Slack threads are ingested on demand from a Slack permalink or stable source ID. Ficus does not tail channels; `list()` returns already-indexed threads so sync can reindex known documents without discovering new conversations.

## Source IDs

Source IDs use `channelId:threadTs`:

```text
C0123ABCDE:1715800000.123456
```

Permalinks are resolved from Slack archive URLs such as:

```text
https://acme.slack.com/archives/C0123ABCDE/p1715800000123456?thread_ts=1715800000.123456
```

If the URL has no `thread_ts` query parameter, Ficus derives the timestamp from the packed `p...` permalink segment.

## Frontmatter

Each Slack thread is one `memory_documents` row with frontmatter like:

```yaml
kind: slack_thread
sourceLinks:
  - https://slack.com/archives/C0123ABCDE/p1715800000123456
channelId: C0123ABCDE
threadTs: '1715800000.123456'
rootUser: U0123
messageCount: 8
relatedCanvases:
  - F0456
huddle: false
```

## Chunk metadata

Each Slack message becomes one chunk. All chunks include:

```json
{
  "sourceType": "slack_thread",
  "parent": {
    "channelId": "C0123ABCDE",
    "threadTs": "1715800000.123456",
    "canvases": ["F0456"]
  },
  "event": { "actor": "U0123", "ts": "1715800000.123456" }
}
```

`event.actor` is the Slack user ID, bot ID, or `unknown`.

## Policy and grants

`slack_thread` supports the base ingestion policy plus Slack channel filters under `scope`:

```json
{
  "enabled": true,
  "policy": {
    "scope": {
      "channelIds": ["C0123ABCDE"],
      "excludeChannelIds": ["C999999999"]
    }
  }
}
```

If `channelIds` is present, only those channels can be indexed. `excludeChannelIds` always denies matching channels. Grant filters support `channelIds` and compile to indexed search filters against `frontmatter.channelId`; malformed filters fail closed.

Slack Canvas documents found on thread messages are fanned out to `slack_canvas` indexing and inherit the same Slack channel policy.

## Limitations

- Requires `SLACK_BOT_TOKEN` and bot access to the channel.
- Fetches up to 200 thread replies.
- Does not ingest channel history automatically.
- User identity remains the Slack user/bot ID; Ficus does not resolve people across systems.

Source class: [`SlackThreadSource`](../../../../apps/core/src/services/memory/sources/SlackThreadSource.ts).

Refreshed periodically by the external-source reindex runner (default 30 min) and via `POST /api/memory/:squadId/reindex` with the matching `source` value. See [Reindexing](../reindex.md).
