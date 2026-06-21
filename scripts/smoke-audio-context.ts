import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentConfig, PromptContext } from '@/lib/ai/agents/types'
import type { Attachment } from '@/lib/types'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-audio-context-'))
process.env.ORCHESTRATOR_STATE_DIR = root

try {
  const { persistUploadBytes } = await import('@/lib/uploads')
  const {
    AUDIO_TRANSCRIPT_AGENT_ID,
    prepareAudioContextsForProvider,
    providerNeedsAudioContext,
  } = await import('@/lib/ai/audio-context')

  const saved = persistUploadBytes(
    Buffer.from('fake audio bytes'),
    'audio/wav',
    'voice.wav',
    'voice-message'
  )
  const fileUploadMessage = {
    id: 'user-audio-file',
    role: 'user' as const,
    content: 'What is in this audio?',
    attachments: [{ ...saved.attachment, origin: 'file_upload' as const }],
    timestamp: Date.now(),
  }
  const voiceMessage = {
    id: 'user-audio',
    role: 'user' as const,
    content: '',
    attachments: [{ ...saved.attachment, origin: 'voice_recording' as const }],
    timestamp: Date.now(),
  }
  const voiceWithTextMessage = {
    id: 'user-audio-with-text',
    role: 'user' as const,
    content: 'Also read this instruction first.',
    attachments: [{ ...saved.attachment, origin: 'voice_recording' as const }],
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
  const runner = async ({ attachments }: { attachments: Attachment[] }) => {
    calls++
    return {
      success: true,
      data: {
        output: `## Audible content\nSpeech is present in ${attachments[0].filename}.\n\n## Useful facts for Orchestrator\n- Smoke summary.`,
      },
    }
  }

  const skippedFileUpload = await prepareAudioContextsForProvider({
    messages: [fileUploadMessage],
    provider: 'codex',
    parentCtx,
    runner,
  })
  assert.equal(calls, 0)
  assert.equal(skippedFileUpload.size, 0)

  const skippedVoiceWithText = await prepareAudioContextsForProvider({
    messages: [voiceWithTextMessage],
    provider: 'codex',
    parentCtx,
    runner,
  })
  assert.equal(calls, 0)
  assert.equal(skippedVoiceWithText.size, 0)

  const first = await prepareAudioContextsForProvider({
    messages: [voiceMessage],
    provider: 'codex',
    parentCtx,
    runner,
  })
  assert.equal(calls, 1)
  assert.equal(first.size, 1)
  assert.match(first.get(voiceMessage.id) ?? '', /Runtime audio context/)
  assert.match(first.get(voiceMessage.id) ?? '', /upload_id:/)
  assert.match(first.get(voiceMessage.id) ?? '', /cache: miss/)
  assert.match(first.get(voiceMessage.id) ?? '', /Smoke summary/)

  const second = await prepareAudioContextsForProvider({
    messages: [voiceMessage],
    provider: 'codex',
    parentCtx,
    runner,
  })
  assert.equal(calls, 1)
  assert.match(second.get(voiceMessage.id) ?? '', /cache: hit/)

  const native = await prepareAudioContextsForProvider({
    messages: [voiceMessage],
    provider: 'google',
    parentCtx,
    runner,
  })
  assert.equal(native.size, 0)

  // --- On-demand transcription primitive + TranscribeAudio tool -------------
  const { transcribeAudioAttachment } = await import('@/lib/ai/audio-context')
  const { executeTranscribeAudio } = await import('@/lib/ai/tools/transcribe-audio')

  let transcriptCalls = 0
  const promptCtx: PromptContext = {
    agentId: AUDIO_TRANSCRIPT_AGENT_ID,
    userName: '',
    assistantName: 'Audio Transcript Agent',
    availableTools: [],
    availableAgents: [],
  }
  const transcriptRunner = async ({ target, prompt }: { target: Pick<AgentConfig, 'id' | 'buildPrompt'>, prompt: string }) => {
    transcriptCalls++
    assert.equal(target.id, AUDIO_TRANSCRIPT_AGENT_ID)
    const systemPrompt = target.buildPrompt?.(promptCtx) ?? ''
    assert.doesNotMatch(systemPrompt, /Markdown report/i)
    assert.doesNotMatch(systemPrompt, /Useful facts/i)
    assert.doesNotMatch(systemPrompt, /timeline/i)
    assert.doesNotMatch(systemPrompt, /excerpts?/i)
    // The transcript mode must use the verbatim-transcript instruction, not the
    // analysis report instruction.
    assert.match(prompt, /verbatim TRANSCRIPT/)
    assert.doesNotMatch(prompt, /audio report/i)
    assert.doesNotMatch(prompt, /Useful facts/i)
    return { success: true, data: { output: 'Speaker 1: hello from the smoke transcript.' } }
  }

  const t1 = await transcribeAudioAttachment({
    attachment: saved.attachment,
    parentCtx,
    runner: transcriptRunner,
  })
  assert.equal(t1.status, 'ok')
  assert.equal(transcriptCalls, 1)
  assert.equal(t1.status === 'ok' && t1.cacheHit, false)
  assert.match(t1.status === 'ok' ? t1.content : '', /smoke transcript/)

  // Transcript mode has its own cache namespace: the analysis pre-pass cached
  // this same file above, but transcript mode still had to run its own agent
  // call (transcriptCalls became 1 rather than reusing the analysis entry).
  const t2 = await transcribeAudioAttachment({
    attachment: saved.attachment,
    parentCtx,
    runner: transcriptRunner,
  })
  assert.equal(transcriptCalls, 1) // second call served from the transcript cache
  assert.equal(t2.status === 'ok' && t2.cacheHit, true)

  // Gemini does not receive m4a/x-m4a directly through the audio-context path:
  // it is transcoded to WAV first, then attached to the sub-agent call.
  const m4aPath = path.join(root, 'sample.m4a')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '0.1',
    '-c:a',
    'aac',
    m4aPath,
  ])
  const m4a = persistUploadBytes(fs.readFileSync(m4aPath), 'audio/m4a', 'sample.m4a', 'sample')
  let convertedMime = ''
  const conversionRunner = async ({ attachments }: { attachments: Attachment[] }) => {
    convertedMime = attachments[0]?.mimeType ?? ''
    return { success: true, data: { output: 'Speaker 1: converted m4a.' } }
  }
  const converted = await transcribeAudioAttachment({
    attachment: m4a.attachment,
    parentCtx,
    runner: conversionRunner,
  })
  assert.equal(converted.status, 'ok')
  assert.equal(convertedMime, 'audio/wav')

  const brokenM4a = persistUploadBytes(Buffer.from('not actually media'), 'audio/m4a', 'broken.m4a', 'broken')
  const broken = await transcribeAudioAttachment({
    attachment: brokenM4a.attachment,
    parentCtx,
    runner: conversionRunner,
  })
  assert.equal(broken.status, 'unavailable')
  assert.match(broken.status === 'unavailable' ? broken.reason : '', /copy_upload_to_workspace/)
  assert.match(broken.status === 'unavailable' ? broken.reason : '', /ffmpeg/)
  assert.match(broken.status === 'unavailable' ? broken.reason : '', /TranscribeAudio/)

  // Tool validation paths (no model call needed).
  const noIds = await executeTranscribeAudio({ upload_ids: [] }, parentCtx)
  assert.equal(noIds.success, false)
  assert.match(noIds.error ?? '', /upload_id|path/)

  const missing = await executeTranscribeAudio({ upload_ids: ['does-not-exist.m4a'] }, parentCtx)
  assert.equal(missing.success, false)

  // A non-audio upload is rejected before any agent call, with guidance toward
  // the copy → convert → paths flow.
  const doc = persistUploadBytes(Buffer.from('plain text'), 'text/plain', 'notes.txt', 'notes')
  const nonAudio = await executeTranscribeAudio({ upload_ids: [doc.attachment.id] }, parentCtx)
  assert.equal(nonAudio.success, false)
  assert.match(nonAudio.error ?? '', /Not an audio file/)
  assert.match(nonAudio.error ?? '', /copy_upload_to_workspace/)

  // A legacy .bin upload is sniffed before rejection: text bytes stay rejected
  // even though the extension alone says nothing.
  const { resolveUploadPath } = await import('@/lib/uploads')
  const { randomUUID } = await import('node:crypto')
  const legacyBinId = `${randomUUID()}.bin`
  fs.writeFileSync(resolveUploadPath(legacyBinId)!, Buffer.from('still just text'))
  const legacyBin = await executeTranscribeAudio({ upload_ids: [legacyBinId] }, parentCtx)
  assert.equal(legacyBin.success, false)
  assert.match(legacyBin.error ?? '', /Not an audio file \(text\/plain\)/)

  // Workspace `paths`: sandbox escapes and non-audio files are rejected before
  // any agent call or upload persistence.
  const escape = await executeTranscribeAudio({ paths: ['../outside.mp3'] }, parentCtx)
  assert.equal(escape.success, false)

  const { activeRuntimePaths } = await import('@/lib/runtime-paths')
  const workspaceDir = activeRuntimePaths().agentWorkspaceDir
  fs.mkdirSync(path.join(workspaceDir, 'tmp'), { recursive: true })
  fs.writeFileSync(path.join(workspaceDir, 'tmp', 'notes.txt'), 'workspace text file')
  const nonAudioPath = await executeTranscribeAudio({ paths: ['tmp/notes.txt'] }, parentCtx)
  assert.equal(nonAudioPath.success, false)
  assert.match(nonAudioPath.error ?? '', /Not an audio file/)

  // Attachment prompt context must show the exact upload_id even when a Codex
  // provider also gets a local filesystem path.
  const { buildAttachmentContext } = await import('@/lib/ai/attachment-context')
  const attachmentPrompt = buildAttachmentContext([doc.attachment], { includeLocalPath: true })
  assert.ok(attachmentPrompt.includes(`upload_id: ${doc.attachment.id}`))
  assert.ok(attachmentPrompt.includes('local path: '))
  assert.match(attachmentPrompt, /including the file extension/)

  // --- copy_upload_to_workspace ---------------------------------------------
  const { executeCopyUploadToWorkspace } = await import('@/lib/ai/tools/copy-upload')

  const missingCopy = executeCopyUploadToWorkspace({ upload_id: 'does-not-exist.bin' })
  assert.equal(missingCopy.success, false)

  // If a model strips the extension from a UUID-style upload id, recover the
  // single matching stored upload instead of forcing a retry.
  const bareUploadId = doc.attachment.id.replace(/\.[^.]+$/, '')
  const copiedBare = executeCopyUploadToWorkspace({ upload_id: bareUploadId, dest_path: 'tmp/bare-upload.txt' })
  assert.equal(copiedBare.success, true)
  assert.equal((copiedBare.data as { upload_id: string }).upload_id, doc.attachment.id)

  // Default destination: tmp/<name> with the upload's bytes intact.
  const copied = executeCopyUploadToWorkspace({ upload_id: doc.attachment.id })
  assert.equal(copied.success, true)
  const copiedPath = (copied.data as { path: string }).path
  assert.match(copiedPath, /^\/tmp\//)
  assert.equal(
    fs.readFileSync(path.join(workspaceDir, copiedPath.replace(/^\//, '')), 'utf8'),
    'plain text'
  )

  // A legacy .bin upload holding real media gets a sniffed extension on the
  // copy so command-line tools recognize the format (OggS magic → .ogg).
  const oggBytes = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)])
  const legacyAudioId = `${randomUUID()}.bin`
  fs.writeFileSync(resolveUploadPath(legacyAudioId)!, oggBytes)
  const sniffedCopy = executeCopyUploadToWorkspace({ upload_id: legacyAudioId, dest_path: 'tmp/voice-note.bin' })
  assert.equal(sniffedCopy.success, true)
  assert.equal((sniffedCopy.data as { mimeType: string }).mimeType, 'audio/ogg')

  // Explicit dest_path collisions dedupe instead of overwriting.
  const again = executeCopyUploadToWorkspace({ upload_id: doc.attachment.id, dest_path: copiedPath })
  assert.equal(again.success, true)
  assert.notEqual((again.data as { path: string }).path, copiedPath)

  console.log('audio context smoke ok')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
