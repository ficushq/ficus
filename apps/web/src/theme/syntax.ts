/**
 * Inline selector/typography data adapted from react-syntax-highlighter one-dark.
 *
 * MIT License
 *
 * Copyright (c) 2019 Conor Hastings
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { CSSProperties } from 'react'

/**
 * App-owned Prism inline theme. The selector/typography contract matches the
 * previously used oneDark style, but every painted color is a token. CSS selects
 * the palette from the resolved theme/appearance before first paint and updates
 * already-mounted blocks (including scoped previews) without React remounting.
 * Ficus deliberately keeps the same dark code palette in BOTH appearances.
 *
 * Only inline selectors supported by react-syntax-highlighter are included;
 * upstream Prism plugin CSS selectors never applied in this renderer.
 */
export const syntaxTheme = {
  // The highlighter also uses selector names to filter emitted class names.
  // Empty entries preserve that contract for the old, inert CSS-plugin rules.
  after: {},
  'attr-equals': {},
  blockquote: {},
  'code-snippet': {},
  'command-line-prompt': {},
  content: {},
  css: {},
  div: {},
  hr: {},
  'interpolation-punctuation': {},
  'line-highlight': {},
  'line-numbers': {},
  'line-numbers-rows': {},
  'linkable-line-numbers': {},
  list: {},
  null: {},
  pre: {},
  'prism-previewer': {},
  'prism-previewer-angle': {},
  'prism-previewer-color': {},
  'prism-previewer-easing': {},
  'prism-previewer-flipped': {},
  'prism-previewer-gradient': {},
  'prism-previewer-time': {},
  rule: {},
  title: {},
  token: {},
  toolbar: {},
  'toolbar-item': {},
  'url-reference': {},
  value: {},
  'code[class*="language-"]': {
    background: 'rgb(var(--syntax-bg))',
    color: 'rgb(var(--syntax-fg))',
    textShadow: '0 1px rgb(var(--syntax-shadow))',
    fontFamily: '"Fira Code", "Fira Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    direction: 'ltr',
    textAlign: 'left',
    whiteSpace: 'pre',
    wordSpacing: 'normal',
    wordBreak: 'normal',
    lineHeight: '1.5',
    MozTabSize: '2',
    OTabSize: '2',
    tabSize: '2',
    WebkitHyphens: 'none',
    MozHyphens: 'none',
    msHyphens: 'none',
    hyphens: 'none',
  },
  'pre[class*="language-"]': {
    background: 'rgb(var(--syntax-bg))',
    color: 'rgb(var(--syntax-fg))',
    textShadow: '0 1px rgb(var(--syntax-shadow))',
    fontFamily: '"Fira Code", "Fira Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    direction: 'ltr',
    textAlign: 'left',
    whiteSpace: 'pre',
    wordSpacing: 'normal',
    wordBreak: 'normal',
    lineHeight: '1.5',
    MozTabSize: '2',
    OTabSize: '2',
    tabSize: '2',
    WebkitHyphens: 'none',
    MozHyphens: 'none',
    msHyphens: 'none',
    hyphens: 'none',
    padding: '1em',
    margin: '0.5em 0',
    overflow: 'auto',
    borderRadius: '0.3em',
  },
  comment: {
    color: 'rgb(var(--syntax-comment))',
    fontStyle: 'italic',
  },
  prolog: {
    color: 'rgb(var(--syntax-comment))',
  },
  cdata: {
    color: 'rgb(var(--syntax-comment))',
  },
  doctype: {
    color: 'rgb(var(--syntax-fg))',
  },
  punctuation: {
    color: 'rgb(var(--syntax-punctuation))',
  },
  entity: {
    color: 'rgb(var(--syntax-fg))',
    cursor: 'help',
  },
  'attr-name': {
    color: 'rgb(var(--syntax-number))',
  },
  'class-name': {
    color: 'rgb(var(--syntax-number))',
  },
  boolean: {
    color: 'rgb(var(--syntax-number))',
  },
  constant: {
    color: 'rgb(var(--syntax-number))',
  },
  number: {
    color: 'rgb(var(--syntax-number))',
  },
  atrule: {
    color: 'rgb(var(--syntax-number))',
  },
  keyword: {
    color: 'rgb(var(--syntax-keyword))',
  },
  property: {
    color: 'rgb(var(--syntax-property))',
  },
  tag: {
    color: 'rgb(var(--syntax-property))',
  },
  symbol: {
    color: 'rgb(var(--syntax-property))',
  },
  deleted: {
    color: 'rgb(var(--syntax-property))',
  },
  important: {
    color: 'rgb(var(--syntax-property))',
  },
  selector: {
    color: 'rgb(var(--syntax-string))',
  },
  string: {
    color: 'rgb(var(--syntax-string))',
  },
  char: {
    color: 'rgb(var(--syntax-string))',
  },
  builtin: {
    color: 'rgb(var(--syntax-string))',
  },
  inserted: {
    color: 'rgb(var(--syntax-string))',
  },
  regex: {
    color: 'rgb(var(--syntax-string))',
  },
  'attr-value': {
    color: 'rgb(var(--syntax-string))',
  },
  variable: {
    color: 'rgb(var(--syntax-variable))',
  },
  operator: {
    color: 'rgb(var(--syntax-operator))',
  },
  function: {
    color: 'rgb(var(--syntax-function))',
  },
  url: {
    color: 'rgb(var(--syntax-url))',
  },
  bold: {
    fontWeight: 'bold',
  },
  italic: {
    fontStyle: 'italic',
  },
  namespace: {
    // Preserve upstream spelling: this was not a painted opacity declaration.
    Opacity: '0.8',
  },
} as Record<string, CSSProperties>
