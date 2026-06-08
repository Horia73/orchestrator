// Matches a markdown list item at the start of a single textarea line:
// optional indent, then a bullet (-, *, +), an ordered marker (1. / 1)),
// or a single-letter marker (A. / a)), then at least one space or tab.
// Letters are limited to one character so "Note. ..." is not mistaken for a list.
const LIST_ITEM_RE =
  /^(\s*)(?:([-*+])|(\d+)([.)])|([A-Za-z])([.)]))([ \t]+)(.*)$/

export interface MarkdownListContinuation {
  nextValue: string
  nextCaret: number
}

function nextLetter(letter: string): string {
  if (letter === "z" || letter === "Z") return letter
  return String.fromCharCode(letter.charCodeAt(0) + 1)
}

export function computeMarkdownListContinuation(
  value: string,
  caret: number
): MarkdownListContinuation | null {
  if (caret < 0 || caret > value.length) return null

  const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1
  let lineEnd = value.indexOf("\n", caret)
  if (lineEnd === -1) lineEnd = value.length

  // Only continue lists from the end of the current line. Mid-line Enter keeps
  // the native textarea behavior instead of splitting list text unexpectedly.
  if (caret !== lineEnd) return null

  const match = LIST_ITEM_RE.exec(value.slice(lineStart, lineEnd))
  if (!match) return null

  const [, indent, bullet, num, numSep, letter, letterSep, spaces, content] =
    match
  const marker = bullet ?? (num ? `${num}${numSep}` : `${letter}${letterSep}`)

  if (content.trim().length === 0) {
    const markerLength = indent.length + marker.length + spaces.length
    return {
      nextValue:
        value.slice(0, lineStart) + value.slice(lineStart + markerLength),
      nextCaret: lineStart,
    }
  }

  const nextMarker = bullet
    ? bullet
    : num
      ? `${Number(num) + 1}${numSep}`
      : `${nextLetter(letter)}${letterSep}`
  const insertion = `\n${indent}${nextMarker}${spaces}`

  return {
    nextValue: value.slice(0, caret) + insertion + value.slice(caret),
    nextCaret: caret + insertion.length,
  }
}
