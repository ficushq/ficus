---
name: notion
description: Safely use Ficus's authenticated Notion CLI
---

# Notion CLI

Use Ficus's authenticated `ntn` CLI to work with the Notion workspace assigned to the current squad.

## Discover before acting

Start with `ntn api ls --json`. Inspect an endpoint with `ntn api <endpoint> --help`, `--spec`, or `--docs`; do not guess request shapes. Search with `ntn api v1/search`. Read pages with `ntn pages get` and query data sources with `ntn datasources query`. Respect the page picker and child-page boundaries: access is limited to resources shared with the integration.

## Safe reads and writes

Prefer JSON and stdin. Build structured requests with `jq ... | ntn api ...`. Use `ntn pages create` or `ntn pages edit` for scoped page changes. Diagnose HTTP 429 with backoff; distinguish authentication failures, unsupported capabilities, and resources that were not shared with the integration.

Get explicit confirmation immediately before trashing or archiving content, using `pages edit --allow-deleting-content`, attaching/detaching workers or databases, or any broad mutation.

## Ficus owns authentication

Never run `ntn login`, `ntn logout`, or `ntn workers oauth token`. Ficus owns OAuth, refresh, reconnect, and revocation. Never print or echo `NOTION_API_TOKEN`, dump the environment, inspect or copy auth files, or use `--unsafe-verbose`. Do not expose tokens in commands, logs, output, files, or messages. If authentication requires attention, report that the Notion connection must be reconnected in Ficus Settings.
