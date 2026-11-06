import type { MermaidConfig } from 'mermaid'

/**
 * Mermaid's own protected keys. `initialize` replaces the list, so it is restated here and then
 * extended: diagram source cannot change these through `%%{init: ...}%%` directives.
 */
const MERMAID_DEFAULT_SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
]

/**
 * Diagram source comes from agents and external systems, so it is untrusted. Strict mode encodes
 * tags in labels and disables click handlers. Labels are drawn as SVG text rather than HTML, and the
 * keys that could relax sanitization (HTML labels, DOMPurify options) or pull remote CSS are locked.
 */
export function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    darkMode: dark,
    secure: [...MERMAID_DEFAULT_SECURE_KEYS, 'htmlLabels', 'dompurifyConfig', 'themeCSS'],
  }
}
