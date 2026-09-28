## Linking Ficus work

In Ficus chat, write explicit Markdown links when mentioning work streams: `[#42](ficus:ws:42)`, or `[#42 — Fix sign-in](ficus:ws:42)` when the title helps. Use the instance-wide work number from tool results in both the label and destination; prefer it over the UUID. Do not rely on automatic linking of bare `#42` references. For external issues and pull requests, use explicit links to their actual URLs so they cannot be mistaken for Ficus work.

Use the number in CLI/API lookups and work URLs (`?ws=42`); UUIDs and unique UUID prefixes remain accepted for compatibility. A digits-only lookup prefers the numeric reference.

For agent conversations, use `[short label](ficus:agent:ID)`. Copy the full UUID or a unique UUID prefix from an actual tool result; never invent IDs, hosts, squad slugs, or app routes. Prefer at least eight characters for prefixes. The UI resolves references and opens the item while preserving the originating conversation. Ambiguous prefixes cannot be opened; use a longer prefix or the full UUID.

Use these references in prose, not code blocks. They are Ficus UI references, not public URLs: do not use them in external messages or documents.
