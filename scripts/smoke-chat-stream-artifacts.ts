import assert from "node:assert/strict"

import {
  handleArtifactStreamEvent,
  type ArtifactStreamEventName,
} from "../hooks/chat-stream-artifacts"

const emitted: Array<{ name: ArtifactStreamEventName; detail: unknown }> = []
const emit = (name: ArtifactStreamEventName, detail: unknown) => {
  emitted.push({ name, detail })
}

assert.equal(
  handleArtifactStreamEvent(
    { type: "artifact_start", clientToken: "token", attrs: { type: "map" } },
    "message",
    emit
  ),
  true
)
assert.deepEqual(emitted[0], {
  name: "orch:artifact-start",
  detail: {
    clientToken: "token",
    messageId: "message",
    attrs: { type: "map" },
  },
})
assert.equal(
  handleArtifactStreamEvent(
    { type: "content", content: "hello" },
    "message",
    emit
  ),
  false
)

console.log("chat stream artifact bridge smoke passed")
