// One live voice session: bridges a connected client (browser today, ESPHome
// satellite later) to the Gemini Live API. Owns the Google-side connection,
// executes the guarded tool surface, streams transcripts back to the client,
// and persists each completed turn as normal conversation messages so voice
// chats show up in the app like any other conversation.
//
// Transcripts are plain ASR/TTS text — the artifact-repair contract for
// message-storing surfaces does not apply because no artifact syntax can be
// produced by an audio transcription.

import { randomUUID } from "crypto"

import {
  GoogleGenAI,
  Modality,
  type FunctionResponse,
  type LiveServerMessage,
  type LiveServerToolCall,
  type Session,
  type UsageMetadata,
} from "@google/genai"

import { getApiKey, getConfig } from "@/lib/config"
import { generateConversationTitleFromSeed } from "@/lib/ai/conversation-auto-title"
import {
  addMessage,
  createConversation,
  setConversationTitle,
  updateConversationContextUsage,
} from "@/lib/db"
import {
  logRequestComplete,
  logRequestStart,
} from "@/lib/observability/store"
import { runWithProfileContext } from "@/lib/profiles/context"
import type { ProfileRole } from "@/lib/profiles/types"
import { resolveVoiceLiveModel } from "@/lib/voice/model"
import {
  buildVoiceFunctionDeclarations,
  executeVoiceTool,
  voiceSettingsFromConfig,
} from "@/lib/voice/tools"
import {
  formatVoiceConversationFallbackTitle,
  type VoiceServerMessage,
  type VoiceSettings,
} from "@/lib/voice/schema"

const INPUT_AUDIO_MIME = "audio/pcm;rate=16000"
const MAX_RECONNECT_ATTEMPTS = 3

export interface VoiceLiveSessionOptions {
  profileId: string
  role: ProfileRole
  send: (message: VoiceServerMessage) => void
  sendAudio: (chunk: Buffer) => void
  onClose: (reason: string) => void
}

export class VoiceLiveSession {
  private readonly opts: VoiceLiveSessionOptions
  private readonly conversationId = randomUUID()
  private session: Session | null = null
  private settings: VoiceSettings
  private model = ""
  private closed = false
  private endRequested = false
  private conversationCreated = false
  private resumptionHandle: string | null = null
  private reconnectAttempts = 0
  private userTranscript = ""
  private assistantTranscript = ""
  private conversationSeedTitle = ""
  private autoNameRequested = false
  private readonly requestId = `voice_${randomUUID()}`
  private readonly startedAt = Date.now()
  private requestLogged = false
  private turnCount = 0
  private searchedThisTurn = false
  // Accumulated across turns in the Gemini snake_case shape the observability
  // usage-mapper already understands for provider "google" — voice sessions
  // then show up in Logs and the Usage report like any other request.
  private usage = {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_thought_tokens: 0,
    total_cached_tokens: 0,
    total_tokens: 0,
    input_tokens_by_modality: {} as Record<string, number>,
    output_tokens_by_modality: {} as Record<string, number>,
  }

  constructor(opts: VoiceLiveSessionOptions) {
    this.opts = opts
    this.settings = this.inCtx(() => voiceSettingsFromConfig())
  }

  async start(): Promise<void> {
    const apiKey = this.inCtx(() => getApiKey("google"))
    if (!apiKey) {
      this.opts.send({
        type: "error",
        message: "Google API key is not configured.",
        fatal: true,
      })
      this.finish("no-api-key")
      return
    }
    this.model = await this.inCtxAsync(() => resolveVoiceLiveModel())
    this.inCtx(() => {
      logRequestStart({
        requestId: this.requestId,
        conversationId: this.conversationId,
        agentId: "voice",
        provider: "google",
        model: this.model,
        thinkingLevel: "none",
        statefulMode: true,
        startedAt: this.startedAt,
        inputText: "[live voice session]",
      })
      this.requestLogged = true
    })
    await this.connect(apiKey)
  }

  private async connect(apiKey: string): Promise<void> {
    const ai = new GoogleGenAI({ apiKey })
    try {
      this.session = await ai.live.connect({
        model: this.model,
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            this.handleServerMessage(message).catch((err) => {
              console.error("[voice] server message handling failed", err)
            })
          },
          onerror: (event) => {
            console.error("[voice] live connection error", event?.message ?? event)
          },
          onclose: (event) => {
            this.handleConnectionClosed(event?.reason || "connection closed")
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: this.inCtx(() => buildSystemInstruction()),
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: this.settings.voiceName },
            },
            ...(this.settings.languageCode
              ? { languageCode: this.settings.languageCode }
              : {}),
          },
          tools: [
            { googleSearch: {} },
            { functionDeclarations: buildVoiceFunctionDeclarations() },
          ],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: this.resumptionHandle
            ? { handle: this.resumptionHandle }
            : {},
        },
      })
    } catch (err) {
      console.error("[voice] live connect failed", err)
      this.opts.send({
        type: "error",
        message: "Could not reach the live voice model.",
        fatal: true,
      })
      this.finish("connect-failed")
    }
  }

  sendAudioChunk(chunk: Buffer): void {
    if (this.closed || !this.session) return
    try {
      this.session.sendRealtimeInput({
        audio: { data: chunk.toString("base64"), mimeType: INPUT_AUDIO_MIME },
      })
    } catch (err) {
      console.error("[voice] failed to forward audio chunk", err)
    }
  }

  /** Speak a background update (e.g. a finished delegation) into the session. */
  injectAnnouncement(text: string): void {
    if (this.closed || !this.session) return
    try {
      this.session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: `[system notice] ${text}` }] }],
        turnComplete: true,
      })
    } catch (err) {
      console.error("[voice] failed to inject announcement", err)
    }
  }

  /** Client asked to stop (end button or socket closed). */
  finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.persistPendingTurn()
    if (this.usage.total_input_tokens || this.usage.total_output_tokens) {
      console.log(
        `[voice] session ended (${reason}) model=${this.model} tokens in=${this.usage.total_input_tokens} out=${this.usage.total_output_tokens}`
      )
    }
    if (this.requestLogged) {
      try {
        this.inCtx(() =>
          logRequestComplete({
            requestId: this.requestId,
            endedAt: Date.now(),
            provider: "google",
            usage: this.usage,
            outputText: `[voice session] ${this.turnCount} turn(s), ended: ${reason}`,
          })
        )
      } catch (err) {
        console.error("[voice] failed to log session usage", err)
      }
    }
    try {
      this.session?.close()
    } catch {
      // Already closed on the Google side.
    }
    this.session = null
    this.opts.onClose(reason)
  }

  get conversation(): string {
    return this.conversationId
  }

  private async handleServerMessage(message: LiveServerMessage): Promise<void> {
    if (this.closed) return
    if (message.setupComplete) {
      this.reconnectAttempts = 0
      this.opts.send({
        type: "ready",
        model: this.model,
        voiceName: this.settings.voiceName,
        conversationId: this.conversationId,
      })
      this.opts.send({ type: "listening" })
      return
    }
    if (message.toolCall) {
      await this.handleToolCall(message.toolCall)
      return
    }
    if (message.usageMetadata) this.accumulateUsage(message.usageMetadata)
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle
    }
    if (message.goAway) {
      // The server is about to drop us; reconnect proactively with the last
      // resumption handle so the conversation continues seamlessly.
      this.scheduleReconnect("go-away")
      return
    }

    const content = message.serverContent
    if (!content) return
    if (content.interrupted) {
      this.opts.send({ type: "interrupted" })
    }
    if (content.groundingMetadata && !this.searchedThisTurn) {
      // Native google_search runs inside the model; grounding metadata is the
      // only signal it happened. Surface it so the UI can show/announce it.
      this.searchedThisTurn = true
      this.opts.send({ type: "tool", name: "google_search", status: "done" })
    }
    if (content.inputTranscription?.text) {
      this.userTranscript += content.inputTranscription.text
      this.opts.send({
        type: "transcript",
        role: "user",
        text: this.userTranscript,
        final: false,
      })
    }
    if (content.outputTranscription?.text) {
      this.assistantTranscript += content.outputTranscription.text
      this.opts.send({
        type: "transcript",
        role: "assistant",
        text: this.assistantTranscript,
        final: false,
      })
    }
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data
      if (data) this.opts.sendAudio(Buffer.from(data, "base64"))
    }
    if (content.turnComplete) {
      this.turnCount += 1
      this.searchedThisTurn = false
      this.persistPendingTurn()
      this.updateConversationUsage()
      this.opts.send({ type: "turn_complete" })
      if (this.endRequested) {
        this.opts.send({ type: "closed", reason: "assistant-ended" })
        this.finish("assistant-ended")
      }
    }
  }

  private async handleToolCall(toolCall: LiveServerToolCall): Promise<void> {
    const responses: FunctionResponse[] = []
    for (const call of toolCall.functionCalls ?? []) {
      const name = call.name ?? ""
      this.opts.send({ type: "tool", name, status: "running" })
      try {
        const output = await this.inCtxAsync(() =>
          executeVoiceTool(name, (call.args ?? {}) as Record<string, unknown>, {
            conversationId: this.conversationId,
            settings: this.settings,
            injectAnnouncement: (text) => this.injectAnnouncement(text),
            requestEnd: () => {
              this.endRequested = true
            },
          })
        )
        responses.push({ id: call.id, name, response: output })
        this.opts.send({ type: "tool", name, status: "done" })
      } catch (err) {
        console.error(`[voice] tool ${name} failed`, err)
        responses.push({
          id: call.id,
          name,
          response: { error: err instanceof Error ? err.message : String(err) },
        })
        this.opts.send({ type: "tool", name, status: "error" })
      }
    }
    if (responses.length && this.session) {
      try {
        this.session.sendToolResponse({ functionResponses: responses })
      } catch (err) {
        console.error("[voice] failed to send tool responses", err)
      }
    }
  }

  private persistPendingTurn(): void {
    const userText = this.userTranscript.trim()
    const assistantText = this.assistantTranscript.trim()
    this.userTranscript = ""
    this.assistantTranscript = ""
    if (!userText && !assistantText) return
    try {
      this.inCtx(() => {
        this.ensureConversation()
        const now = Date.now()
        if (userText) {
          this.opts.send({ type: "transcript", role: "user", text: userText, final: true })
          addMessage(this.conversationId, {
            id: randomUUID(),
            role: "user",
            content: userText,
            timestamp: now,
          })
        }
        if (assistantText) {
          this.opts.send({
            type: "transcript",
            role: "assistant",
            text: assistantText,
            final: true,
          })
          addMessage(this.conversationId, {
            id: randomUUID(),
            role: "assistant",
            content: assistantText,
            status: "ok",
            timestamp: now + 1,
          })
        }
        this.maybeAutoNameConversation({ userText, assistantText })
      })
    } catch (err) {
      console.error("[voice] failed to persist transcript turn", err)
    }
  }

  private ensureConversation(): void {
    if (this.conversationCreated) return
    const startedAt = new Date()
    const config = getConfig()
    const title = formatVoiceConversationFallbackTitle(
      startedAt,
      config.timezone
    )
    createConversation({
      id: this.conversationId,
      title,
      messages: [],
      createdAt: startedAt.getTime(),
    })
    this.conversationSeedTitle = title
    this.conversationCreated = true
  }

  private maybeAutoNameConversation(seed: {
    userText: string
    assistantText: string
  }): void {
    if (this.autoNameRequested || !this.conversationSeedTitle) return
    if (!seed.userText.trim() && !seed.assistantText.trim()) return

    const currentTitle = this.conversationSeedTitle
    this.autoNameRequested = true
    void this.inCtxAsync(async () => {
      try {
        const title = await generateConversationTitleFromSeed({
          conversationId: this.conversationId,
          seed,
        })
        if (!title || title === currentTitle) return
        setConversationTitle(this.conversationId, title, currentTitle)
      } catch (err) {
        console.error("[voice] auto-name failed", err)
      }
    })
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.opts.send({
        type: "error",
        message: "The live voice connection dropped and could not be resumed.",
        fatal: true,
      })
      this.finish(`reconnect-exhausted:${reason}`)
      return
    }
    this.reconnectAttempts += 1
    const apiKey = this.inCtx(() => getApiKey("google"))
    if (!apiKey) {
      this.finish("no-api-key")
      return
    }
    try {
      this.session?.close()
    } catch {
      // Old connection is already gone.
    }
    this.session = null
    void this.connect(apiKey)
  }

  private handleConnectionClosed(reason: string): void {
    if (this.closed || !this.session) return
    // An unexpected server-side close (session time limit, transient network)
    // gets the same resume treatment as goAway.
    this.scheduleReconnect(reason)
  }

  private accumulateUsage(usage: UsageMetadata): void {
    this.usage.total_input_tokens += usage.promptTokenCount ?? 0
    this.usage.total_output_tokens += usage.responseTokenCount ?? 0
    this.usage.total_thought_tokens += usage.thoughtsTokenCount ?? 0
    this.usage.total_cached_tokens += usage.cachedContentTokenCount ?? 0
    this.usage.total_tokens += usage.totalTokenCount ?? 0
    for (const detail of usage.promptTokensDetails ?? []) {
      if (!detail.modality) continue
      this.usage.input_tokens_by_modality[detail.modality] =
        (this.usage.input_tokens_by_modality[detail.modality] ?? 0) +
        (detail.tokenCount ?? 0)
    }
    for (const detail of usage.responseTokensDetails ?? []) {
      if (!detail.modality) continue
      this.usage.output_tokens_by_modality[detail.modality] =
        (this.usage.output_tokens_by_modality[detail.modality] ?? 0) +
        (detail.tokenCount ?? 0)
    }
  }

  private updateConversationUsage(): void {
    if (!this.conversationCreated) return
    try {
      this.inCtx(() =>
        updateConversationContextUsage(this.conversationId, {
          provider: "google",
          model: this.model,
          source: "provider-final",
          accuracy: "actual",
          updatedAt: Date.now(),
          inputTokens: this.usage.total_input_tokens,
          outputTokens: this.usage.total_output_tokens,
          thinkingTokens: this.usage.total_thought_tokens || null,
          cachedTokens: this.usage.total_cached_tokens || null,
          totalTokens: this.usage.total_tokens,
        })
      )
    } catch (err) {
      console.error("[voice] failed to update conversation usage", err)
    }
  }

  private inCtx<T>(fn: () => T): T {
    return runWithProfileContext(
      { profileId: this.opts.profileId, role: this.opts.role },
      fn
    )
  }

  private inCtxAsync<T>(fn: () => Promise<T>): Promise<T> {
    return runWithProfileContext(
      { profileId: this.opts.profileId, role: this.opts.role },
      fn
    )
  }
}

export function buildSystemInstruction(): string {
  const config = getConfig()
  const now = new Date().toLocaleString("en-US", {
    timeZone: config.timezone || undefined,
    dateStyle: "full",
    timeStyle: "short",
  })
  return [
    `Role: You are ${config.assistantName || "Orchestrator"}, ${config.userName || "the user"}'s home voice assistant in a real-time spoken conversation.`,
    `Current time: ${now} (${config.timezone}).`,
    "",
    "Goal: Resolve the user's immediate spoken request naturally, or hand slow work to Orchestrator with a clear expectation.",
    "",
    "Success criteria: the answer is accurate, brief, in the user's language, and grounded in tool results whenever fresh or device state matters.",
    "",
    "Style: answer briefly and conversationally — one to three short sentences, no markdown, no lists, no URLs read aloud. Match the user's language (they may speak Romanian or English).",
    "",
    "Capabilities:",
    "- You DO have live smart-home access through the home_assistant_* tools — never claim you cannot reach or control the home without actually calling them first. If you are not sure of an entity id, call home_assistant_find_entities first; never invent ids. If a tool call fails, say what failed specifically instead of a generic disclaimer. Security devices (locks, alarms) are the only off-limits domain from voice.",
    "- Use Google Search for anything fresh: weather, sports, news, opening hours.",
    "- For complex or slow work (research, multi-step tasks, writing), call delegate_to_orchestrator and tell the user you will get back to them — the result is announced automatically when ready.",
    "- When a [system notice] message arrives, relay it naturally to the user.",
    "- Stop rule: when the user is done, say a short goodbye, call end_conversation, and do nothing further.",
  ].join("\n")
}
