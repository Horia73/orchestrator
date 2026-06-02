import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-audio-context-'))
process.env.ORCHESTRATOR_STATE_DIR = root

try {
  const { persistUploadBytes } = await import('@/lib/uploads')
  const {
    prepareAudioContextsForProvider,
    providerNeedsAudioContext,
  } = await import('@/lib/ai/audio-context')

  const saved = persistUploadBytes(
    Buffer.from('fake audio bytes'),
    'audio/mp4',
    'voice.m4a',
    'voice-message'
  )
  const message = {
    id: 'user-audio',
    role: 'user' as const,
    content: 'What is in this audio?',
    attachments: [saved.attachment],
    timestamp: Date.now(),
  }
  const parentCtx = {
    callerAgentId: 'orchestrator',
    depth: 0,
    conversationId: 'smoke-audio-context',
    parentRequestId: 'smoke-audio-context-request',
  }

  assert.equal(providerNeedsAudioContext('codex', saved.attachment), true)
  assert.equal(providerNeedsAudioContext('google', saved.attachment), false)

  let calls = 0
  const runner = async ({ attachments }: { attachments: typeof message.attachments }) => {
    calls++
    return {
      success: true,
      data: {
        output: `## Audible content\nSpeech is present in ${attachments[0].filename}.\n\n## Useful facts for Orchestrator\n- Smoke summary.`,
      },
    }
  }

  const first = await prepareAudioContextsForProvider({
    messages: [message],
    provider: 'codex',
    parentCtx,
    runner,
  })
  assert.equal(calls, 1)
  assert.equal(first.size, 1)
  assert.match(first.get(message.id) ?? '', /Runtime audio context/)
  assert.match(first.get(message.id) ?? '', /upload_id:/)
  assert.match(first.get(message.id) ?? '', /cache: miss/)
  assert.match(first.get(message.id) ?? '', /Smoke summary/)

  const second = await prepareAudioContextsForProvider({
    messages: [message],
    provider: 'codex',
    parentCtx,
    runner,
  })
  assert.equal(calls, 1)
  assert.match(second.get(message.id) ?? '', /cache: hit/)

  const native = await prepareAudioContextsForProvider({
    messages: [message],
    provider: 'google',
    parentCtx,
    runner,
  })
  assert.equal(native.size, 0)

  console.log('audio context smoke ok')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
