import assert from "node:assert/strict"

import {
  consumeLocalSubmitAnchor,
  isLocalSubmitAnchorDetail,
  localSubmitAnchorKey,
  readLocalSubmitAnchor,
  writeLocalSubmitAnchor,
  type LocalSubmitAnchor,
} from "../lib/chat-local-submit-anchor"

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()
const anchor: LocalSubmitAnchor = {
  conversationId: "conversation_a",
  messageId: "message_1",
  submittedAt: 1_000,
}

assert.equal(isLocalSubmitAnchorDetail(anchor), true)
writeLocalSubmitAnchor(anchor, storage)
assert.deepEqual(readLocalSubmitAnchor("conversation_a", storage, 1_050), anchor)
assert.equal(
  storage.getItem(localSubmitAnchorKey("conversation_a"))?.includes("message_1"),
  true
)
assert.equal(consumeLocalSubmitAnchor("conversation_a", "message_x", storage, 1_050), null)
assert.deepEqual(
  consumeLocalSubmitAnchor("conversation_a", "message_1", storage, 1_050),
  anchor
)
assert.equal(readLocalSubmitAnchor("conversation_a", storage, 1_050), null)

writeLocalSubmitAnchor(anchor, storage)
assert.equal(readLocalSubmitAnchor("conversation_a", storage, 100_000), null)
assert.equal(storage.getItem(localSubmitAnchorKey("conversation_a")), null)

storage.setItem(localSubmitAnchorKey("conversation_a"), "{bad json")
assert.equal(readLocalSubmitAnchor("conversation_a", storage, 1_050), null)

console.log("chat local submit anchor smoke passed")
