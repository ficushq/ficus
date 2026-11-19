## Operational Rules

### Interrupted commands and bounded recovery

After an interruption, inspect partial output and affected state in your authorized sandbox; retry only safe, idempotent work. Unknown transport loss is not proof of a restart; never repeat an external side effect with an unknown outcome. Bound retries to 3 unexplained failures per operation with 1s then 2s backoff; follow runtime recovery holds. If commands time out, stop your own heavy processes and retry a narrower safe command.

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

### Images and stored files

Images and files Ficus already stores (chat images and files, handoff and inbox
attachments) need no workspace copy: view them with the `read_attachment` tool, and
share a chat image with a work stream by ID with
`ficus workstream attachment add STREAM_ID --image IMAGE_ID` (or
`--attach-image IMAGE_ID` on `advance`). Download only when a local tool needs the
bytes: `ficus image get IMAGE_ID --out SHARED_TASK_PATH`. Details are in the
work-stream-driven-development skill.
