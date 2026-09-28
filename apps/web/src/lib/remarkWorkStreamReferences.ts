import { visit, SKIP } from 'unist-util-visit'
import { entityReferenceHref } from '@ficus/shared'

/** Link work numbers in prose, leaving explicit links, code and PR/issue references alone. */
export function remarkWorkStreamReferences() {
  return (tree: any) => {
    visit(tree, (node: any, index: number | undefined, parent: any) => {
      if (['link', 'linkReference'].includes(node.type)) return SKIP
      if (node.type !== 'text') return
      if (index == null || !parent || ['link', 'linkReference'].includes(parent.type)) return
      const matches = [...node.value.matchAll(/(?<![\w/#])#([1-9]\d*)\b/g)] as RegExpMatchArray[]
      const children: any[] = []
      let cursor = 0
      for (const match of matches) {
        const start = match.index!
        if (Number(match[1]) > 2147483647 || /(?:PR|pull request|issue)\s*$/i.test(node.value.slice(0, start))) continue
        if (start > cursor) children.push({ type: 'text', value: node.value.slice(cursor, start) })
        children.push({
          type: 'link',
          url: entityReferenceHref('ws', match[1]!),
          children: [{ type: 'text', value: match[0] }],
        })
        cursor = start + match[0].length
      }
      if (!cursor) return
      if (cursor < node.value.length) children.push({ type: 'text', value: node.value.slice(cursor) })
      parent.children.splice(index, 1, ...children)
      return index + children.length
    })
  }
}
