# Ficus CLI

Command-line interface for Ficus.

## Install

Install the latest released Ficus CLI:

```bash
curl -fsSL https://ficus.sh/cli/install.sh | bash
```

The installer writes the CLI to `~/.ficus/bin/ficus` and bundled CLI assets to `~/.ficus/share`. To reinstall or upgrade later, run `ficus install`.

Add Ficus to your `PATH` if needed:

```bash
export PATH="$HOME/.ficus/bin:$PATH"
```

Verify the install:

```bash
ficus --help
```

## Local Development

From the repository root:

```bash
bun run build:cli
./apps/cli/dist/ficus.js --help
```

## Integration credentials

Assigned, healthy integrations authenticate globally provisioned CLIs through
per-command PATH wrappers, including commands launched by child processes. If a
CLI reports unauthenticated, ask a person to connect, validate, enable or assign
the account in Settings → Integrations and the squad’s Integrations tab.

Project-local CLIs, npx/bunx and npm/bun/pnpm scripts can bypass global wrappers:

```bash
ficus integration exec <provider> -- npm run deploy
ficus integration exec <provider> -- bun run deploy
ficus integration exec <provider> -- pnpm run deploy
ficus integration exec <provider> --connection <connection-id> -- <command>
```

The squad runtime supplies `FICUS_SQUAD_ID`. Outside that context add
`--squad <squad-id>` before `--`. Selection never grants authorization. Exec is
unrestricted, but never read, print, log, commit or persist integration tokens.
Human terminals receive no Ficus integration credentials; wrappers pass through
to the person’s own login with a stderr note. Custom app secrets belong in squad
Environment Variables (visible to agents and terminals) or human-directed files
in the squad or agent workspace. Integration credentials do not belong there.

## Operator credential automation

`ficus secret` is operator-only; it and `/api/secrets` remain available to people
automating supported instance settings with the appropriate permissions:

```bash
ficus secret list
ficus secret get <key>
ficus secret set <key> <value>
ficus secret delete <key>
```

Integration-owned credentials must use their owning settings forms instead.
Arbitrary keys are not delivered to squads. This is not an agent credential
delivery mechanism and is omitted from generated agent help.
