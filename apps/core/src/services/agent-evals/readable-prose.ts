/*
 * How the readable-handoff scenario scores text. The shared "Readable text fields" rule asks for
 * normal prose with complete words and normal spacing; headings, bullets and identifiers are fine.
 * These checks are deliberately conservative, so a failure names something a reader would notice:
 *
 * - arrows or similar symbols standing in for words (→, ->, =>, ⇒, ✓, ✗);
 * - invented shorthand (b/c, w/, w/o, impl, cfg, prev, orig, chg, q, msg, approx);
 * - telegraphic text: too few function words ("the", "and", "is", "to" ...) per word of prose;
 * - words run together (a long lowercase token that is not an identifier, path or URL).
 *
 * Code spans, fenced blocks, paths, URLs, commit hashes and other identifiers are removed first, so
 * quoting `squad-agent-prompt.ts` or `4f1c2ab9` never counts against the text.
 */

const SYMBOLS_FOR_WORDS = /→|->|=>|⇒|✓|✔|✗|✘|(?<![\w/])&(?![\w/])/u

const INVENTED_SHORTHAND =
  /(?<![\w./-])(b\/c|w\/o|w\/|impl|cfg|prev|orig|chg|msg|approx|diff'd|q|qs|tbd|wip|fyi|asap|re:|ok'd)(?![\w./-])/i

const FUNCTION_WORDS = new Set(
  'a an the and or but so because if when while that which who this these those it its is are was were be been being has have had do does did not no to of in on at by for with from as into than then there their they we i you he she our your my me us'.split(
    ' '
  )
)

/** Below this share of function words, prose reads as telegraphic notes. Normal English is about 0.4. */
export const MIN_FUNCTION_WORD_SHARE = 0.22

/** Text without code spans, fenced blocks and URLs; paths are kept so "b/c" and "w/" stay visible. */
const withoutCode = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')

/** Text with code, identifiers, paths, URLs and numbers removed: what remains should be prose. */
export function proseOnly(text: string): string {
  return withoutCode(text)
    .replace(/\S*[/\\]\S*/g, ' ')
    .replace(/\b[\w-]+\.(ts|tsx|js|json|md|yaml|yml|sh)\b/g, ' ')
    .replace(/\b(?=[\w-]*\d)[\w-]{6,}\b/g, ' ')
    .replace(/\b[a-z]+[A-Z]\w*\b/g, ' ')
    .replace(/\b\w+_\w+\b/g, ' ')
    .replace(/\b\d+(\.\d+)?\b/g, ' ')
}

export function readableProseProblems(text: string): string[] {
  const problems: string[] = []
  const prose = proseOnly(text)
  const symbol = SYMBOLS_FOR_WORDS.exec(prose)
  if (symbol) problems.push(`uses "${symbol[0]}" in place of words`)
  const shorthand = INVENTED_SHORTHAND.exec(withoutCode(text))
  if (shorthand) problems.push(`uses the shorthand "${shorthand[0]}"`)
  const words = prose.toLowerCase().match(/[a-z']+/g) ?? []
  if (words.length >= 40) {
    const share = words.filter((word) => FUNCTION_WORDS.has(word)).length / words.length
    if (share < MIN_FUNCTION_WORD_SHARE)
      problems.push(
        `reads as telegraphic notes (${Math.round(share * 100)}% function words, below ${Math.round(MIN_FUNCTION_WORD_SHARE * 100)}%)`
      )
  }
  const runTogether = prose.match(/\b[a-z]{22,}\b/)
  if (runTogether) problems.push(`runs words together ("${runTogether[0]}")`)
  return problems
}
