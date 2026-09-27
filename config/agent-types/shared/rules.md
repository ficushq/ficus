## Operational Rules

### Slot Coordination

When squad context declares a protected resource, claim its pool with `ficus slot claim` before starting. A successful command exit does not mean a slot was granted; automation must inspect the returned `outcome` before starting protected work. A blocked claim queues you automatically and returns `queued` with a waiter id — that is not ownership, so end the turn and do not begin until the grant wake arrives. Renew only while the resource is still needed, and release immediately after protected work finishes, including failure cleanup. Renew, release, and unsubscribe take only the claim or waiter id (`ficus slot release <claim-id>`), with no pool key or squad. Treat expiry or dormancy cleanup as authoritative loss of ownership. After interruption or uncertainty, recover authoritative state with `ficus slot list`.

### Monitor Tool

Use the `monitor` tool to observe background commands that emit selective, actionable events (for example, `tail -F app.log | grep --line-buffered ERROR` or a targeted readiness check). Monitors should be event-driven and quiet: prefer commands that emit output only when a specific actionable condition happens, such as completion, error, readiness, state transition, failure, or another condition that requires attention. Do not use a monitor to detach a one-shot build, generation, migration, or test that must complete; run it as one foreground Bash invocation with timeout up to 3600 seconds. Avoid firehose output and avoid polling loops that print every interval (for example, do not echo job status every 60 seconds), because that spams chat/monitor batches. If polling is needed, loop silently and print only when the job reaches a terminal or actionable state, or filter output with tools like `grep`/`awk` so only actionable events are emitted.

Example: noisy: `while true; do echo "still running"; sleep 60; done`; quiet: `while true; do if job_done; then echo "complete"; exit 0; fi; if job_failed; then echo "failed"; exit 1; fi; sleep 60; done`.

Create monitors with `create`, inspect them with `get`/`list`, and `cancel` them when no longer needed. Monitor follow-up events help you react to changes, but they do not replace normal tests or foreground verification commands.

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

Screenshots and recordings go on GitHub with `gh`'s built-in `--attach` flag
(`gh pr|issue create|edit|comment`). Repeat it for several files; alt text
follows the path after `#`; a `![alt](./after.png)` reference already in the
body is rewritten to the uploaded URL, so images can sit inline or in tables:

```bash
gh pr comment 173 --body "Before / after" --attach './before.png#Before' --attach './after.png#After'
```

Attachments inherit the PR or issue's visibility — never attach anything you
would not paste into that thread.
