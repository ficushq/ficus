# Ficus

**A workspace for teams of AI agents.**

Give a squad a goal. Its manager coordinates specialized agents, tracks work,
and brings you in for decisions and review. Follow the conversation, steer a
running agent, or let the squad continue while you're away.

Run Ficus on your own machine or server, or use [Ficus Cloud](https://ficus.sh).
Your squads can work across repositories, tools, and services from the web app
or CLI.

[Documentation](https://docs.ficus.sh) · [Quick start](#quick-start) · [Self-hosting](docs/wiki/hosting.md) · [Contributing](CONTRIBUTING.md)

## Quick start

Install and run Ficus locally on macOS or Linux:

```bash
curl -fsSL https://ficus.sh/cli/setup.sh | bash
```

You'll need `curl` and `git`. Bun's installer needs `unzip` too; on Debian/Ubuntu with passwordless sudo the installer adds it for you, elsewhere install it first.
Setup installs the remaining dependencies, asks
where agents should run, and starts your instance.

1. Open the URL printed by setup and complete the first-admin sign-in.
2. Connect a model provider under **Settings → AI Providers**.
3. Create a squad and give it a goal.

See the [setup guide](docs/wiki/setup.md#local-setup) for requirements, runtime
choices, headless installation, and troubleshooting. Prefer managed hosting?
[Get started with Ficus Cloud](https://ficus.sh).

<details>
<summary>Other installation options</summary>

**From source**

```bash
git clone --recurse-submodules https://github.com/ficushq/tau.git
cd tau
bun install
bun run setup
```

**CLI only**, for an instance running elsewhere:

```bash
curl -fsSL https://ficus.sh/cli/install.sh | bash
```

The CLI is installed to `~/.ficus/bin`. See [CLI setup](docs/wiki/cli/README.md)
for authentication and usage.

**Operate Ficus from an AI coding agent:** the CLI bundles the
[Ficus operator skill](external/skills/ficus/SKILL.md). Install it for your agent with

```bash
ficus skill install ficus --agent claude-code --global   # or --agent pi | codex
```

</details>

## What you can do

- **Delegate ongoing work.** Squads organize tasks into work streams with
  dependencies, handoffs, and review. Schedules keep recurring work moving.
- **Stay involved when it matters.** Live conversations, an Action Center, and
  notifications let you answer questions, review results, and steer active work.
- **Choose models and execution environments.** Connect model providers and run
  agents locally, in Docker, on VM hosts, or in Kubernetes. Choose the isolation
  and infrastructure that fit your workload.
- **Keep shared knowledge.** Squads retain file-based memory with keyword and
  vector search, so useful context survives individual conversations.
- **Connect your tools.** Work with GitHub, Linear, chat channels, browser tools,
  webhooks, and app previews. The CLI and REST API support scripted workflows.
- **Collaborate across people and instances.** Multi-user permissions control
  access; AMTP connects agents across Ficus instances and other compatible nodes.

Explore the [user guides](https://docs.ficus.sh) or the
[technical documentation](docs/wiki/README.md) for the full feature set.

## Run it your way

| Run Ficus       | Best for                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| **Local**       | Run on your computer and use the web app or CLI. [Local setup](docs/wiki/setup.md#local-setup)                |
| **Self-hosted** | Deploy on your own infrastructure and choose where agent workloads run. [Hosting guide](docs/wiki/hosting.md) |
| **Ficus Cloud** | Use managed hosting at [ficus.sh](https://ficus.sh).                                                          |

This repository includes the server, worker, web app, CLI, sandbox runtimes,
and shared client libraries. Instance documentation is also available at
`/docs/` on your Ficus server.

## Developing Ficus

Ficus is built with **Bun, TypeScript, Hono, and React**. The API and worker run as
separate processes; agents use the same CLI and APIs available to people.

- [Development guide](docs/wiki/development.md) — run from source, test changes, and work on the codebase.
- [Architecture](docs/wiki/README.md) — packages, core concepts, and runtime behavior.
- [Sandbox runtimes](docs/wiki/sandbox-runtimes.md) — execution and isolation options.
- [CLI reference](docs/wiki/cli/README.md) — operate and automate your instance.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before opening
a pull request. The **CLA Check** guides contributors through the
[Contributor License Agreement](CLA.md) signing process.

## License

Ficus is licensed under [AGPL-3.0-only](LICENSE). Contributors retain their
copyright; the [CLA](CLA.md) grants Intentional Design LLC permission to offer
contributions under additional licenses, including commercial licenses.

Copyright (C) 2026 Intentional Design LLC
