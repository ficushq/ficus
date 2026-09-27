# Ficus documentation

Private user documentation for `docs.ficus.sh`, built with Astro Starlight. The initial 21-page guide set covers Cloud and self-hosted setup, a first completed task, the Assistant, work, configuration, integrations, and maintenance.

## Local development

Use the repository's Bun version (1.3.8) and Node.js 22.12 or newer. From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run dev:docs
```

Open `http://127.0.0.1:4321`. The scripts bind to loopback by default. To preview from another device on your network, use `bun run --filter @ficus/docs preview --host 0.0.0.0 --port 4321`; restrict access to your trusted network. No Ficus backend, database, provider credentials, submodules, or root postinstall hooks are needed.

To check and preview the production build:

```sh
bun run check:docs
bun run --filter @ficus/docs preview --port 4321
```

With this Astro version, preview starts a background server. To inspect or stop it, from `apps/docs`:

```sh
ASTRO_TELEMETRY_DISABLED=1 bunx --no-install astro preview status
ASTRO_TELEMETRY_DISABLED=1 bunx --no-install astro preview stop
```

Stop a dev server using the terminal that started it before binding a preview to the same port. Astro telemetry is disabled in the package scripts.

## What belongs where

| Directory                                                 | Purpose                                                | Included in the static site? |
| --------------------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| `src/content/docs/`                                       | Approved, edited user guides and reference pages       | Yes                          |
| `src/styles/`                                             | Ficus theme                                            | Yes                          |
| `public/`                                                 | Curated public assets only                             | Yes, copied directly         |
| `review/`                                                 | Proposed page map, source audit, verification evidence | No                           |
| `scripts/`                                                | Build validation                                       | No                           |
| Repository `docs/`, `config/`, plans and contributor docs | Source material to verify selectively                  | No                           |

Do not glob or symlink repository documentation into the content collection. Do not copy screenshots from live customer or production instances. Use fictional examples and a clean demo workspace when adding examples or screenshots. Audit notes remain outside the published collection and search index.

The sidebar lists the curated guide set explicitly in `astro.config.mjs`; avoid empty placeholders or broken navigation. Repository documentation lives separately in `docs/wiki` (current guidance), `docs/history` (historical records), and `docs/backlog` (unfinished proposals).

## Validation

`bun run check:docs` runs Astro type/content checks, link-checker tests, a static build with Pagefind search, and the generated-site link check. The checker validates local routes, fragments and linked resources, including absolute links to `docs.ficus.sh`. It does not make external requests or validate third-party sites.

The `Documentation` GitHub Actions workflow runs the same checks for relevant changes. It has read-only repository access and does not upload or deploy anything.

See content coverage and remaining gaps, validation evidence, the historical-document inventory, and [deployment instructions](DEPLOYMENT.md). Starlight's [manual setup](https://starlight.astro.build/manual-setup/) and [configuration reference](https://starlight.astro.build/reference/configuration/) describe the underlying site framework.

## Cloud and self-hosted instructions

The setup selector is beside the desktop theme control and in the mobile menu. It stores `ficus-docs-mode` locally and carries `?mode=cloud` or `?mode=self-hosted` in documentation links. An explicit URL mode overrides a saved preference; the `/start/cloud/` and `/start/self-host/` setup entrypoints select their own mode. Invalid values default to the saved preference or Cloud. Storage failures do not prevent selection or navigation.

Write shared explanations once. In an MDX guide, wrap only differing instructions:

```mdx
import ModeContent from '../../components/ModeContent.astro'

Shared explanation and heading.

<ModeContent mode="cloud">Cloud-specific steps.</ModeContent>

<ModeContent mode="self-hosted">Self-host-specific steps.</ModeContent>
```

Resolve the import relative to the guide's location. Keep headings and navigation anchors outside the variants so the table of contents and shared links never target a hidden heading. Use lists, paragraphs, code and screenshots within variants. Each block supplies a mode label and switch control. Without JavaScript both labeled variants remain readable; the inactive selector is hidden.

Mode-specific blocks are excluded from Pagefind snippets to avoid directing users to hidden instructions. Put searchable task names and the shared explanation outside the blocks. Search result links still inherit the selected mode. This is one shared search index, not two separate versions of the site.

For an explicit setup choice link, use `data-docs-mode-link="cloud"` or `data-docs-mode-link="self-hosted"` and include the matching query parameter in its static `href`. Ordinary internal documentation links inherit the current mode automatically; external links, assets and downloads remain unchanged. The canonical URL stays independent of mode.

The implementation uses Starlight's supported [component overrides](https://starlight.astro.build/reference/overrides/) for `Head` and `ThemeSelect`, retaining the default theme control. The inline head script applies the preference before content paints. DOM regression tests use owned windows and do not install process-wide browser globals.
