# Ficus Memory CLI Reference

Use the Ficus CLI path shown in the installed skill's **Installed Ficus CLI** section. In this reference, `<ficus-cli>` means that exact command path. Always include `--squad <squad-id>` on memory commands.

## Auth and Backend Selection

```bash
<ficus-cli> auth login work --api-url "https://ficus.example.com"
<ficus-cli> auth login local --api-url "http://localhost:3000"
<ficus-cli> auth list
<ficus-cli> auth switch work
<ficus-cli> auth status
<ficus-cli> squad list
```

Prefer the hidden prompt or `FICUS_PASSWORD` environment variable over passing secrets on the command line. Never print, commit, or write `FICUS_PASSWORD` or `$HOME/.tau/cli/auth.json` contents into memory.

## Search

```bash
<ficus-cli> memory search "authentication flow" --squad <squad-id> --limit 5
<ficus-cli> memory search "rate limits" --squad <squad-id> --kind decision --tag api --path 'decisions/**'
```

Available filters include `--mode hybrid|vector|keyword`, `--source-type`, `--kind`, `--tag`, and `--path`.

## List and Read

```bash
<ficus-cli> memory list /memory --squad <squad-id>
<ficus-cli> memory list /memory/patterns --squad <squad-id>
<ficus-cli> memory get /memory/context.md --squad <squad-id>
<ficus-cli> memory get /memory/map.md --squad <squad-id>
<ficus-cli> memory get /memory/patterns/api-errors.md --squad <squad-id>
```

## Write or Create

`write` overwrites the entire file. Use it for new files or intentional full-file replacement only.

```bash
<ficus-cli> memory write /memory/patterns/api-errors.md --squad <squad-id> < api-errors.md
```

For multiline content, prefer stdin/heredoc to avoid shell quoting problems:

```bash
cat <<'EOF' | <ficus-cli> memory write /memory/patterns/example.md --squad <squad-id>
---
title: "Example Pattern"
kind: pattern
tags: [example]
---

# Example Pattern

Durable guidance here.
EOF
```

## Append

Use append for additive notes that belong at the end of an existing file.

```bash
<ficus-cli> memory append /memory/runbooks/deploy.md --squad <squad-id> --newline --content "..."
```

For multiline appends:

```bash
cat <<'EOF' | <ficus-cli> memory append /memory/runbooks/deploy.md --squad <squad-id> --newline

## Rollback note

Durable rollback guidance with sources.
EOF
```

## Patch

Use patch for surgical exact-match replacements. The match text must appear exactly once; if it appears multiple times, use a longer match.

```bash
<ficus-cli> memory patch /memory/patterns/api-errors.md --squad <squad-id> --match "old exact text" --replace "new text"
```

## Delete

Delete only when the file is obsolete, duplicated, or harmful, and preferably after confirming with a human or vault owner.

```bash
<ficus-cli> memory write /memory/obsolete.md --squad <squad-id> --delete
```

## Backlinks

Check backlinks before renaming, deleting, or heavily editing a file.

```bash
<ficus-cli> memory backlinks /memory/patterns/api-errors.md --squad <squad-id>
```
