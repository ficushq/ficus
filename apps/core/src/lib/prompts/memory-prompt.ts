import { resolveWorkspaceLayout } from '../../services/sandbox/workspace-layout'

/**
 * Memory System Prompt Documentation
 *
 * This is the documentation for the memory system that is conditionally
 * injected into agent system prompts when memory is enabled for a squad.
 */

/**
 * Build the memory system prompt with the actual map.md contents.
 * @param squadId - The squad id used to resolve namespaced memory/workspace paths
 * @param mapContent - The contents of map.md (or undefined if not found)
 */
export function buildMemorySystemPrompt(squadId: string, mapContent?: string): string {
  const { workspaceMount, memoryMount } = resolveWorkspaceLayout({ squadId })
  const mapSection = mapContent
    ? `### Memory Map\n\n${mapContent}`
    : `### Memory Map\n\nNo map.md found. Create \`${memoryMount}/map.md\` to define your vault structure.`

  return `## Memory System

Your squad has a shared memory vault at \`${memoryMount}\`. Memory persists knowledge across sessions and agents.

### Special Files
- **\`${memoryMount}/context.md\`** — Essential squad context (always injected into prompts)
- **\`${memoryMount}/map.md\`** — Self-describing vault structure (editable by agents)

${mapSection}

### Finding Context
Before starting work, look for relevant context:
\`\`\`
memory_search({ query: "authentication flow" })
\`\`\`
Returns ranked results with snippets. Use this to avoid re-solving solved problems.

To see what exists, browse the map of folders, documents and headings, or find sections by their headings, then read just the section you need:
\`\`\`
memory_outline({ query: "token rotation" })
memory_outline({ path: "decisions" })
memory_get({ path: "decisions/auth.md", section: "Implementation > Key rotation" })
\`\`\`

### Writing to Memory
- **\`memory_write\`**: Create or overwrite a file
- **\`memory_patch\`**: Replace exact text (must match exactly once)
- **\`memory_append\`**: Add content to end of file

### Frontmatter Convention
Include YAML frontmatter with metadata:
\`\`\`yaml
---
id: mem_01JABCXYZ
title: "API Rate Limiting Pattern"
kind: pattern
tags: [api, backend]
createdAt: 2026-02-22T00:20:00Z
updatedAt: 2026-02-22T00:41:00Z
---
\`\`\`

Required fields: \`kind\` and \`title\`. Common kinds: \`pattern\`, \`playbook\`, \`reference\`, \`incident\`.

### Wikilinks
Use wikilinks to connect related documents:
- \`[[Page]]\` — Link to another document
- \`[[Page#Heading]]\` — Link to a specific heading
- \`[[Page|Alias]]\` — Link with display alias

### What Belongs in Memory
Memory is for **durable squad knowledge** that stays useful across many tasks:
- Patterns and conventions discovered in the codebase
- Playbooks for recurring operations (deploy, debug, onboard)
- Reference docs (API contracts, environment setup, key contacts)
- Incident postmortems with lessons learned
- Project-specific gotchas and workarounds

### What Does NOT Belong in Memory
- **Plans and decisions** — Use \`${workspaceMount}/docs/plans/\` and \`${workspaceMount}/docs/decisions/\` instead. These are ephemeral working documents for the current task.
- **Work logs** — The work stream and git history already capture what was done.
- **Transient state** — "I am currently doing X", progress updates, task chatter.
- **Anything tied to a specific task** — If it won't help future tasks, don't store it.

Use \`${workspaceMount}/docs/\` for all per-task coordination. Use \`${memoryMount}/\` only for knowledge you'd want any squad member to find months from now.`
}
