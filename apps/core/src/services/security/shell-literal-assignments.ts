type Word = { value: string; literal: boolean; key?: string; end: number }

/** Skip an unevaluated substitution, keeping its nested/quoted newlines out of the assignment scan. */
function skipSubstitution(source: string, start: number, close: string): number {
  const frames = [{ close, quote: '' }]
  let i = start
  while (i < source.length) {
    const frame = frames.at(-1)!
    const char = source[i]!
    if (char === '\\' && frame.quote !== "'") {
      i += 2
      continue
    }
    if (frame.quote === "'") {
      if (char === "'") frame.quote = ''
    } else if (char === frame.quote) frame.quote = ''
    else if (frame.quote === '' && (char === "'" || char === '"')) frame.quote = char
    else if (frame.quote === '' && char === frame.close) {
      frames.pop()
      if (frames.length === 0) return i + 1
    } else if (char === '$' && (source[i + 1] === '(' || source[i + 1] === '{')) {
      frames.push({ close: source[i + 1] === '(' ? ')' : '}', quote: '' })
      i++
    } else if (char === '`') frames.push({ close: '`', quote: '' })
    else if (frame.quote === '' && char === '(') frames.push({ close: ')', quote: '' })
    i++
  }
  return i
}

const ANSI_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  e: 27,
  E: 27,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
  "'": 39,
  '"': 34,
  '?': 63,
}

/** Bash $'...' quote removal, as bytes (UTF-8 may span concatenated fragments). */
function ansiQuote(source: string, start: number, unicode: boolean): { bytes: Buffer; end: number; closed: boolean } {
  const chunks: Buffer[] = []
  let i = start
  while (i < source.length && source[i] !== "'") {
    let char = String.fromCodePoint(source.codePointAt(i)!)
    i += char.length
    if (char !== '\\' || i === source.length) {
      chunks.push(Buffer.from(char))
      continue
    }
    char = source[i++]!
    if (Object.hasOwn(ANSI_ESCAPES, char)) chunks.push(Buffer.from([ANSI_ESCAPES[char]!]))
    else if (/[0-7]/.test(char)) {
      const digits = char + (/^[0-7]{0,2}/.exec(source.slice(i))?.[0] ?? '')
      i += digits.length - 1
      chunks.push(Buffer.from([parseInt(digits, 8) & 255]))
    } else if (char === 'x' && /^[0-9a-f]/i.test(source.slice(i, i + 1))) {
      const digits = /^[0-9a-f]{1,2}/i.exec(source.slice(i))![0]
      i += digits.length
      chunks.push(Buffer.from([parseInt(digits, 16)]))
    } else if ((char === 'u' || char === 'U') && /^[0-9a-f]/i.test(source.slice(i, i + 1))) {
      const digits = new RegExp(`^[0-9a-f]{1,${char === 'u' ? 4 : 8}}`, 'i').exec(source.slice(i))![0]
      i += digits.length
      const point = parseInt(digits, 16)
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
        return { bytes: Buffer.alloc(0), end: source.length, closed: false }
      const escaped = `\\${point <= 0xffff ? 'u' : 'U'}${point
        .toString(16)
        .toUpperCase()
        .padStart(point <= 0xffff ? 4 : 8, '0')}`
      chunks.push(Buffer.from(unicode || point < 128 ? String.fromCodePoint(point) : escaped))
    } else if (char === 'c' && i < source.length) {
      const control = source[i++]!
      chunks.push(Buffer.from([control === '?' ? 127 : control.toUpperCase().charCodeAt(0) & 31]))
    } else chunks.push(Buffer.from(`\\${char}`))
  }
  const bytes = Buffer.concat(chunks)
  const nul = bytes.indexOf(0)
  // Bash truncates the ANSI-C fragment at NUL; later quote fragments still append.
  return { bytes: nul < 0 ? bytes : bytes.subarray(0, nul), end: i + 1, closed: i < source.length }
}

function readWord(source: string, start: number, unicode: boolean): Word {
  const chunks: Buffer[] = []
  const key = /^([A-Za-z_](?:[A-Za-z0-9_]|\\\n)*)=/.exec(source.slice(start))?.[1]?.replace(/\\\n/g, '')
  let i = start
  let quote = ''
  let literal = true
  let previous = ''
  while (i < source.length) {
    const char = String.fromCodePoint(source.codePointAt(i)!)
    const next = source[i + 1]
    if (quote === "'") {
      if (char === "'") quote = ''
      else chunks.push(Buffer.from(char))
    } else if (char === '\\') {
      if (next === undefined) {
        literal = false
        i++
        break
      }
      if (next === '\n') {
        i += 2
        continue
      }
      if (quote !== '"' || /[$`"\\]/.test(next)) {
        const escaped = String.fromCodePoint(source.codePointAt(i + 1)!)
        chunks.push(Buffer.from(escaped))
        i += 1 + escaped.length
        previous = escaped
        continue
      }
      chunks.push(Buffer.from('\\'))
    } else if (char === quote) quote = ''
    else if (char === '"' || (char === "'" && quote === '')) quote = char
    else if (char === '$' && next === "'" && quote === '') {
      const ansi = ansiQuote(source, i + 2, unicode)
      chunks.push(ansi.bytes)
      literal &&= ansi.closed
      i = ansi.end
      continue
    } else if (char === '$' && (next === '(' || next === '{' || next === '[')) {
      literal = false
      i = skipSubstitution(source, i + 2, next === '(' ? ')' : next === '{' ? '}' : ']')
      continue
    } else if (char === '`') {
      literal = false
      i = skipSubstitution(source, i + 1, '`')
      continue
    } else if (
      char === '$' &&
      next !== undefined &&
      (/[A-Za-z_0-9*@#?$!-]/.test(next) || (next === '"' && quote === ''))
    ) {
      literal = false
      // $"..." is locale-dependent, not a literal quote form.
      if (next === '"' && quote === '') {
        quote = '"'
        i += 2
        continue
      }
      chunks.push(Buffer.from(char))
    } else if (quote === '' && (char === '<' || char === '>') && next === '(') {
      literal = false
      i = skipSubstitution(source, i + 2, ')')
      continue
    } else if (quote === '' && /[ \t\n;|&<>()]/.test(char)) break
    else {
      // Assignment tilde expansion is dynamic, including after a colon.
      if (quote === '' && char === '~' && (previous === '=' || previous === ':')) literal = false
      chunks.push(Buffer.from(char))
    }
    previous = char
    i += char.length
  }
  return { key, value: Buffer.concat(chunks).toString('utf8'), literal: literal && quote === '', end: i }
}

/**
 * Decode assignment words / export declarations without running a shell. Only
 * literal words are returned. Expansions and script control flow are not
 * interpreted; command arguments cannot become environment declarations.
 */
function literalAssignments(source: string, unicode: boolean): Record<string, string> {
  const values: Record<string, string> = Object.create(null)
  let words: Word[] = []
  let unsupported = false
  const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = []
  const finish = () => {
    if (!unsupported) {
      const exported = words[0]?.literal && words[0]?.value === 'export'
      for (const word of exported ? words.slice(1) : words) {
        if (!word.key) {
          if (exported && word.literal && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.value)) continue
          break
        }
        if (word.literal) values[word.key] = word.value.slice(word.key.length + 1)
        else delete values[word.key]
      }
    }
    words = []
    unsupported = false
  }
  let i = 0
  while (i < source.length) {
    const char = source[i]!
    if (char === '\\' && source[i + 1] === '\n') {
      i += 2
      continue
    }
    if (char === ' ' || char === '\t') {
      i++
      continue
    }
    if (char === '#') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    if (char === '\n' || char === ';') {
      finish()
      i++
      if (char === '\n') {
        for (const { delimiter, stripTabs } of heredocs.splice(0)) {
          while (i < source.length) {
            const end = source.indexOf('\n', i)
            const line = source.slice(i, end < 0 ? source.length : end)
            i = end < 0 ? source.length : end + 1
            if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break
          }
        }
      }
      continue
    }
    if (source.startsWith('<<', i) && !source.startsWith('<<<', i)) {
      unsupported = true
      i += 2
      const stripTabs = source[i] === '-'
      if (stripTabs) i++
      while (source[i] === ' ' || source[i] === '\t') i++
      const word = readWord(source, i, unicode)
      if (word.literal) heredocs.push({ delimiter: word.value, stripTabs })
      i = word.end
      continue
    }
    if (/[|&<>()]/.test(char)) {
      unsupported = true
      i++
      continue
    }
    const word = readWord(source, i, unicode)
    words.push(word)
    i = word.end
  }
  finish()
  return values
}

/**
 * Match both UTF-8 and C-locale forms of ANSI-C Unicode literals without reading
 * runtime env or guessing a shell's locale. Equal candidates are deduplicated.
 */
export function parseShellLiteralAssignments(source: string): Array<{ key: string; value: string }> {
  const utf8 = literalAssignments(source, true)
  const ascii = literalAssignments(source, false)
  return Object.entries(utf8).flatMap(([key, value]) => {
    const entries = [{ key, value }]
    if (ascii[key] !== undefined && ascii[key] !== value) entries.push({ key, value: ascii[key] })
    return entries
  })
}
