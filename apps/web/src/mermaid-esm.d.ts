/**
 * Mermaid's self-contained ESM build: the same API as the `mermaid` entry, with its own copies of d3
 * and its other dependencies. See lib/mermaidRenderer.ts for why the app imports this build.
 */
declare module 'mermaid/dist/mermaid.esm.min.mjs' {
  import mermaid from 'mermaid'
  export default mermaid
}
