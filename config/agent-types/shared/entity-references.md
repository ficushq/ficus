## Linking Ficus work

In Ficus chat, `#` followed by a number means a Ficus work stream: the app turns a bare `#42` in prose into a link to work stream 42. Write explicit Markdown links when mentioning work streams: `[#42](ficus:ws:42)`, or `[#42 — Fix sign-in](ficus:ws:42)` when the title helps. Use the instance-wide work number from tool results in both the label and destination; prefer it over the UUID. Do not rely on automatic linking of bare `#42` references.

Never write a bare `#<number>` for anything else, or it opens the wrong work stream. For pull requests and issues, put the kind before every number (`PR #123`, `issue #45`; `PR #12 and PR #13`, not `PRs #12 and #13` or `PR #12, #13`), use `owner/repo#123`, or best, link to the actual URL: `[PR #123](https://github.com/owner/repo/pull/123)`. For anything else numbered (CI runs, steps, list items, rankings), drop the `#`: `run 8812`, `step 3`.

Use the number in CLI/API lookups and work URLs (`?ws=42`); UUIDs and unique UUID prefixes remain accepted for compatibility. A digits-only lookup prefers the numeric reference.

For agent conversations, use `[short label](ficus:agent:ID)`. Copy the full UUID or a unique UUID prefix from an actual tool result; never invent IDs, hosts, squad slugs, or app routes. Prefer at least eight characters for prefixes. The UI resolves references and opens the item while preserving the originating conversation. Ambiguous prefixes cannot be opened; use a longer prefix or the full UUID.

Use these references in prose, not code blocks. They are Ficus UI references, not public URLs: do not use them in external messages or documents.
