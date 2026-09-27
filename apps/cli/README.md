# Ficus CLI

Command-line interface for Ficus.

## Install

Install the latest released Ficus CLI:

```bash
curl -fsSL https://ficus.sh/cli/install.sh | bash
```

The installer writes the CLI to `~/.tau/bin/ficus` and bundled CLI assets to `~/.tau/share`. To reinstall or upgrade later, run `ficus install`.

Add Ficus to your `PATH` if needed:

```bash
export PATH="$HOME/.tau/bin:$PATH"
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
