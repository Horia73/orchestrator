import assert from "node:assert/strict"

import { hideInlineImageAttachments } from "../lib/chat-attachment-display"
import type { Attachment } from "../lib/types"

const inlineImage: Attachment = {
  id: "screen-shot.jpg",
  filename: "Wolt confirmation",
  mimeType: "image/jpeg",
  size: 123,
  type: "image",
}
const otherImage: Attachment = {
  id: "other.png",
  filename: "Other image",
  mimeType: "image/png",
  size: 456,
  type: "image",
}

assert.deepEqual(
  hideInlineImageAttachments(
    [inlineImage, otherImage],
    "![Confirmation](/api/uploads/screen-shot.jpg)"
  ),
  [otherImage]
)

assert.deepEqual(
  hideInlineImageAttachments(
    [inlineImage],
    "![Confirmation](/orchestrator/api/uploads/screen-shot.jpg?preview=1)"
  ),
  []
)

// A plain download link is not a visible inline image, so its attachment card
// remains available.
assert.deepEqual(
  hideInlineImageAttachments(
    [inlineImage],
    "[Download](/api/uploads/screen-shot.jpg)"
  ),
  [inlineImage]
)

console.log("chat attachment display smoke passed")
