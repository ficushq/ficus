# Tau's pi 0.99.1 patch sources

Upstream release: `earendil-works/pi` at `d86654abb8862e201933517d6f1fce9f88dd117f` (`v0.99.1`).

The six TypeScript overlays preserve Tau's session event sanitization and persistence ordering, SDK exports, read-tool behavior, and host-provided extension module resolution. They were three-way merged from the 0.87.1 overlays against the new upstream source. Upstream 0.99 added nested tool-call recording (`ctx.executeTool()`) at the top of `_handleAgentEvent`; the merge runs Tau's sanitizer first, so the nested-call bookkeeping, extension emission, listener emission, and persistence all see the sanitized event. Tau's `session_message_persisted` emission stays on top of upstream's entry-ID bookkeeping. The extension-loader merge keeps upstream's new MCP server and virtual-model registration APIs while retaining Tau's host-module fallback for unbundled artifacts. It also always loads jiti's static entry: upstream switched non-embedded runtimes to jiti's lazy entry, which loads Babel from a path relative to jiti's own file (`../dist/babel.cjs`) that does not exist once Core's `bun build` bundles the SDK, so TypeScript extensions failed to load in Tau artifacts.

Regenerate from a clean checkout of that upstream commit:

```sh
PI_MONO_DIR=/path/to/pristine/pi bun run patch:pi-coding-agent --write
```

Omit `--write` to verify the committed patch without changing it. Node.js 22.19 or newer and Bun are required. CI uses Node 24. Run `bun install` in this repository first: the sanitizer dataflow gate needs the TypeScript 5 compiler API from the root `node_modules`.

The script installs with the build-only `bun.lock` here and lifecycle scripts disabled. This lock was migrated by Bun from upstream's v0.99.1 `package-lock.json` and pins the isolated build dependencies explicitly, including upstream's compiler pin (TypeScript 7.0.2; 0.99 replaced the TypeScript native preview and `tsx`). Disposable-clone package scripts use Bun in place of upstream's recursive npm calls; application manifests are not changed by regeneration.

The checks require pristine source outputs to match the verified published package, both independent overlay builds and patches to be byte-identical, sanitizer dataflow to pass, and all files outside the output allowlist to remain unchanged. The patch applies to the unbundled SDK used by Tau, not pi's standalone CLI bundles.

The separate pi-ai patch retains the two hard-plan-limit retry classifiers (upstream 0.99.1 has not absorbed them; it only added its own `subscription_sharing_usage_limit_exceeded` entry, which the ported hunk sits after) and the Claude subscription credential refusal. Keep the refreshed upstream model catalog intact.
