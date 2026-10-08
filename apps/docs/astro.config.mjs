import process from 'node:process'
import { unified } from '@astrojs/markdown-remark'
import { prefixDocsLinks } from './scripts/embedded-links.mjs'
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

const embedded = process.env.FICUS_DOCS_EMBEDDED === '1'

export default defineConfig({
  base: embedded ? '/docs' : '/',
  outDir: embedded ? '../core/docs-dist' : './dist',
  // Core and platform builds may run concurrently in the monorepo.
  cacheDir: embedded ? './node_modules/.astro-embedded' : './node_modules/.astro',
  markdown: { processor: unified({ remarkPlugins: embedded ? [prefixDocsLinks] : [] }) },
  site: embedded ? undefined : 'https://docs.ficus.sh',
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Ficus Docs',
      description: 'Practical guides to working with Ficus, in the cloud or on your own machine.',
      logo: { light: './src/assets/ficus-mark.svg', dark: './src/assets/ficus-mark-dark.svg' },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/ficus.css'],
      components: {
        Head: './src/components/Head.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      // Only approved user content belongs in this collection. Repository docs
      // and the private review directory are intentionally not imported.
      sidebar: [
        { label: 'Welcome to Ficus', slug: 'index' },
        {
          label: 'Get started',
          items: [
            { label: 'Set up Ficus Cloud', slug: 'start/cloud' },
            { label: 'Self-host Ficus', slug: 'start/self-host' },
            { label: 'Complete your first task', slug: 'start/first-task' },
          ],
        },
        {
          label: 'Work with Ficus',
          items: [
            { label: 'Use the Assistant', slug: 'use/assistant' },
            { label: 'Squads', slug: 'use/squads' },
            { label: 'Work streams', slug: 'use/work-streams' },
            { label: 'Workflows', slug: 'use/workflows' },
            { label: 'Review and intervene', slug: 'use/review-and-intervene' },
            { label: 'Themes and appearance', slug: 'use/themes' },
          ],
        },
        {
          label: 'Configure your workspace',
          collapsed: true,
          items: [
            { label: 'Models and credentials', slug: 'configure/models' },
            { label: 'Agent configuration', slug: 'configure/agents' },
            { label: 'Squad presets', slug: 'configure/squad-presets' },
            { label: 'Accounts and access', slug: 'configure/access' },
          ],
        },
        {
          label: 'Connect your tools',
          collapsed: true,
          items: [
            { label: 'GitHub', slug: 'connect/github' },
            { label: 'Project tools', slug: 'connect/project-tools' },
            { label: 'Chat channels', slug: 'connect/chat' },
            { label: 'Notifications', slug: 'connect/notifications' },
            { label: 'Mobile app and Pro', slug: 'connect/mobile' },
          ],
        },
        {
          label: 'Maintain self-hosted Ficus',
          collapsed: true,
          items: [
            { label: 'Runtime and access', slug: 'self-host/runtime-and-access' },
            { label: 'Updates and backups', slug: 'self-host/maintenance' },
            { label: 'Troubleshooting', slug: 'self-host/troubleshooting' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { label: 'CLI', slug: 'reference/cli' },
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'Workflow definitions', slug: 'reference/workflow-definition' },
          ],
        },
      ],
      // The hosted site (docs.ficus.sh) is public and indexable; the copy
      // embedded in each instance under /docs sits behind that instance's
      // sign-in and is kept out of search.
      head: embedded ? [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' } }] : [],
      credits: false,
    }),
  ],
})
