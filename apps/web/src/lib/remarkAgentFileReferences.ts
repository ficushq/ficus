import { extractAgentAttachmentReferences } from '@ficus/shared'
import { visit } from 'unist-util-visit'

export function remarkAgentFileReferences(options: { agentId: string }) {
  return (tree: any) => {
    visit(tree, 'text', (node: any, index: number | undefined, parent: any) => {
      if (index == null || !parent || parent.type === 'link' || parent.type === 'linkReference') return
      const references = extractAgentAttachmentReferences(node.value)
      if (!references.length) return
      const children: any[] = []
      let cursor = 0
      for (const reference of references) {
        if (reference.start > cursor) children.push({ type: 'text', value: node.value.slice(cursor, reference.start) })
        children.push({
          type: 'link',
          url: `/api/agents/${encodeURIComponent(options.agentId)}/files/${reference.id}`,
          children: [{ type: 'text', value: reference.name }],
          data: {
            hProperties: {
              'data-agent-file-id': reference.id,
              'data-agent-file-name': reference.name,
            },
          },
        })
        cursor = reference.end
      }
      if (cursor < node.value.length) children.push({ type: 'text', value: node.value.slice(cursor) })
      parent.children.splice(index, 1, ...children)
      return index + children.length
    })
  }
}
