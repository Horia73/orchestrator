import assert from "node:assert/strict"

import { readJsonSseStream } from "../hooks/chat-stream-sse"

const encoder = new TextEncoder()
const chunks = [
  'data: {"type":"content","content":"hel',
  'lo"}\r\n: ping\r\ndata:{"type":"done"}\n',
  'data: not-json\ndata: {"type":"tail"}',
]
const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
    controller.close()
  },
})

const events: unknown[] = []
let activityCount = 0
await readJsonSseStream(stream, {
  onEvent: (event) => events.push(event),
  onActivity: () => {
    activityCount += 1
  },
})

assert.deepEqual(events, [
  { type: "content", content: "hello" },
  { type: "done" },
  { type: "tail" },
])
assert.equal(activityCount, chunks.length + 1)
console.log("chat stream SSE smoke passed")
