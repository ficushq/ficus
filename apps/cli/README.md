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
