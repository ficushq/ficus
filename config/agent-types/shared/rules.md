## Operational Rules

### Readable text fields

Write every text field in normal, readable prose with normal spacing and complete
words. Never remove spaces, run words together, invent abbreviations, or use
telegraphic shorthand to save tokens or length. These fields are read by people
and other agents; compressed prose is a defect, not an optimization.

This applies to work stream descriptions; step instructions and outputs; wait,
approval, and review messages; questions; inbox and steering messages; metadata
values; and pull request text. When material is long, use headings, bullets, or a
linked file instead of compressing it. Preserve exact identifiers, code, URLs,
paths, and quoted source material; this rule governs the prose you write, not
literal data.

### Slot Coordination

Before work a pool protects, claim it with `ficus slot claim <key>`. The squad's pools and their usage guidance (what each protects and when to claim it) are listed in the generated Slot Pools section; squad context may also name a protected resource and its pool. A successful command exit does not mean a slot was granted; automation must inspect the returned `outcome` before starting protected work. A blocked claim queues you automatically and returns `queued` with a waiter id — that is not ownership, so end the turn and do not begin until the grant wake arrives. Renew only while the resource is still needed, and release immediately after protected work finishes, including failure cleanup. Renew, release, and unsubscribe take only the claim or waiter id (`ficus slot release <claim-id>`), with no pool key or squad. Treat expiry or dormancy cleanup as authoritative loss of ownership. After interruption or uncertainty, recover authoritative state with `ficus slot list`. A `disabled` outcome (or a notice that a pool you were queued on was disabled) means the pool is not enforced right now: nothing was claimed or queued, the work is not slot-gated, so proceed under the remaining squad rules. Claim it again if it is re-enabled.

### Monitor Tool

Use the `monitor` tool to observe background commands that emit selective, actionable events (for example, `tail -F app.log | grep --line-buffered ERROR` or a targeted readiness check). Monitors should be event-driven and quiet: prefer commands that emit output only when a specific actionable condition happens, such as completion, error, readiness, state transition, failure, or another condition that requires attention. Do not use a monitor to detach a one-shot build, generation, migration, or test that must complete; run it as one foreground Bash invocation with timeout up to 3600 seconds. Avoid firehose output and avoid polling loops that print every interval (for example, do not echo job status every 60 seconds), because that spams chat/monitor batches. If polling is needed, loop silently and print only when the job reaches a terminal or actionable state, or filter output with tools like `grep`/`awk` so only actionable events are emitted.

Example: noisy: `while true; do echo "still running"; sleep 60; done`; quiet: `while true; do if job_done; then echo "complete"; exit 0; fi; if job_failed; then echo "failed"; exit 1; fi; sleep 60; done`.

Create monitors with `create`, inspect them with `get`/`list`, and `cancel` them when no longer needed. Monitor follow-up events help you react to changes, but they do not replace normal tests or foreground verification commands.

Monitors survive Core restarts. If the sandbox restarts, a monitor fails by default (`restart: "never"`); set `restart: "on-loss"` only for idempotent, safe-to-rerun watchers (for example `tail -F | grep` or a quiet watch loop) so the command is relaunched automatically, never for one-shot or side-effecting commands.

### Messaging / Shell Safety

- When running any CLI command from a shell:
  - DO NOT include Markdown backticks ( `like this` ) inside a double-quoted string (bash treats them as command substitution).
  - Prefer safe patterns:
    - Single quotes: `ficus inbox send <id> '...multiline...'`
    - Or heredoc/stdin patterns for multiline content.
  - If you must show "code formatting" in a message, use escape backticks.
  - Do not put literal `\n` sequences inside double-quoted shell strings expecting them to become newlines. Bash does not expand `\n` in double quotes, so CLIs will receive backslash+n literally.
  - For multiline CLI message bodies, prefer heredocs or stdin/body-file flags.
  - If you see errors like "Permission denied" or "not a git repository" immediately after sending a message, it may be that the message text was shell-expanded; resend using the safe quoting patterns above.

Safe heredoc example:

```bash
ficus inbox send <id> "$(cat <<'EOF'
...content...
EOF
)"
```

GitHub PR comment example:

```bash
gh pr comment 173 --body-file - <<'EOF'
Provider skill source verification has been reviewed and pushed.

Summary:
- Sources were cited.
- Validation passed.
EOF
```

Put screenshots and recordings on a PR or issue with `ficus pr attach` (`gh --attach`
fails with the squad's GitHub App credential). It commits the files to `<number>/` on
the shared branch `ficus/pr-assets` of the same repository and posts a comment; alt text follows
the path after `#`, and `![alt](./after.png)` in the body is replaced inline:

```bash
ficus pr attach 173 './before.png#Before' './after.png#After' --body "Before / after"
```

`--edit-body` appends to the description instead; `--no-comment` only prints the
Markdown. Attachments have the repository's visibility — never attach anything you
would not paste into that thread.
