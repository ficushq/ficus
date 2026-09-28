# Contributing to Ficus

Thanks for your interest in contributing to Ficus! This page explains how to send changes and what you're agreeing to when you do.

## Quick start

1. Fork the repo and create a branch off `main`.
2. Read [`AGENTS.md`](AGENTS.md) for the project conventions (Bun, monorepo layout, formatting, tests).
3. Make your change, run `bun typecheck` and `bun run lint`, and open a PR against `main`.
4. The **CLA Check** on your PR will ask contributors without an existing signature to sign the [Contributor License Agreement](CLA.md) — see below.
5. A maintainer will review and merge.

## Licensing in plain English

Ficus is released under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`). When you contribute, you're submitting your changes under the same license. **You retain copyright in your contributions** — there is no copyright assignment.

In addition, by signing the CLA you grant Intentional Design LLC (the project owner) permission to also distribute your contribution under other licenses, including commercial ones. This is what lets the project offer a paid non-AGPL option to companies that can't comply with the AGPL's network-source-disclosure requirement. The open-source version of Ficus will always remain AGPL-3.0-only.

If you don't want your contribution to be available under any license other than AGPL-3.0-only, please don't open the PR — sign the CLA only if you're comfortable with the dual-licensing terms in [CLA.md](CLA.md).

## Signing the CLA

Read [CLA.md](CLA.md) in full. On your pull request, post this exact comment:

`I have read the CLA Document and I hereby sign the CLA`

The bot records your signature and checks the PR author and commit authors. Existing signatures for the current CLA version remain valid across pull requests. Dependabot, Renovate, and GitHub Actions bots are excluded.

If you contribute on behalf of your employer, the Corporate CLA in Part B also applies. Contact a maintainer on the PR to arrange the authorized employer signature. The automated individual check does not replace employer authorization.

## What the reviewer is looking for

- The change matches an open issue or has clear motivation in the PR description.
- Tests are added or updated where behavior changes.
- `bun typecheck` and `bun run lint` pass.
- No unrelated drive-by changes.

## Reporting security issues

Please don't open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for how to report one privately; we'll coordinate disclosure with you.
