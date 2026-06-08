import assert from "node:assert/strict"

import { computeMarkdownListContinuation } from "../lib/markdown-list-continuation"

function atEnd(value: string) {
  return computeMarkdownListContinuation(value, value.length)
}

{
  const value = "1. First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "1. First item\n2. ",
    nextCaret: "1. First item\n2. ".length,
  })
}

{
  const value = "  9) First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "  9) First item\n  10) ",
    nextCaret: "  9) First item\n  10) ".length,
  })
}

{
  const value = "- First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "- First item\n- ",
    nextCaret: "- First item\n- ".length,
  })
}

{
  const value = "\t* First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "\t* First item\n\t* ",
    nextCaret: "\t* First item\n\t* ".length,
  })
}

{
  const value = "A. First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "A. First item\nB. ",
    nextCaret: "A. First item\nB. ".length,
  })
}

{
  const value = "1. First item\n2. "
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "1. First item\n",
    nextCaret: "1. First item\n".length,
  })
}

assert.equal(computeMarkdownListContinuation("1. First item", 3), null)
assert.equal(atEnd("This is not a list."), null)

console.log("markdown list continuation smoke passed")
