import assert from "node:assert/strict"

import {
  computeMarkdownListContinuation,
  computeMarkdownListTabSpacing,
} from "../lib/markdown-list-continuation"

function atEnd(value: string) {
  return computeMarkdownListContinuation(value, value.length)
}

{
  const value = "1. First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "  1. First item\n  2.\t",
    nextCaret: "  1. First item\n  2.\t".length,
  })
}

{
  const value = "  1.\tFirst item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "  1.\tFirst item\n  2.\t",
    nextCaret: "  1.\tFirst item\n  2.\t".length,
  })
}

{
  const value = "  9) First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "  9) First item\n  10)\t",
    nextCaret: "  9) First item\n  10)\t".length,
  })
}

{
  const value = "- First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "  - First item\n  -\t",
    nextCaret: "  - First item\n  -\t".length,
  })
}

{
  const value = "\t* First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "\t* First item\n\t*\t",
    nextCaret: "\t* First item\n\t*\t".length,
  })
}

{
  const value = "A. First item"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "  A. First item\n  B.\t",
    nextCaret: "  A. First item\n  B.\t".length,
  })
}

{
  const value = "1. First item\n2.\t"
  const next = atEnd(value)
  assert.deepEqual(next, {
    nextValue: "1. First item\n",
    nextCaret: "1. First item\n".length,
  })
}

{
  const value = "1. First item"
  const next = computeMarkdownListTabSpacing(value, value.length)
  assert.deepEqual(next, {
    nextValue: "  1.\tFirst item",
    nextCaret: "  1.\tFirst item".length,
  })
}

{
  const value = "- First item"
  const next = computeMarkdownListTabSpacing(value, value.length)
  assert.deepEqual(next, {
    nextValue: "  -\tFirst item",
    nextCaret: "  -\tFirst item".length,
  })
}

{
  const value = "A. First item"
  const next = computeMarkdownListTabSpacing(value, value.length)
  assert.deepEqual(next, {
    nextValue: "  A.\tFirst item",
    nextCaret: "  A.\tFirst item".length,
  })
}

assert.equal(computeMarkdownListContinuation("1. First item", 3), null)
assert.equal(computeMarkdownListTabSpacing("1.\tFirst item", "1.\tFirst item".length), null)
assert.equal(atEnd("This is not a list."), null)

console.log("markdown list continuation smoke passed")
