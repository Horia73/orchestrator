import crypto from "crypto"

import { redactLikelySecrets } from "@/lib/agent-needs"

import { ADMIN_PROFILE_ID } from "./constants"
import { getControlDb, recordProfileAudit } from "./store"

export const OWNER_AGENT_REQUEST_STATUSES = [
  "pending",
  "running",
  "handled",
  "needs_user",
  "failed",
] as const

export type OwnerAgentRequestStatus =
  (typeof OWNER_AGENT_REQUEST_STATUSES)[number]

export interface OwnerAgentRequest {
  id: string
  requesterProfileId: string
  requesterConversationId: string
  requesterAgentId: string
  ownerProfileId: string
  ownerConversationId: string | null
  ownerAgentThreadId: string | null
  title: string
  request: string
  status: OwnerAgentRequestStatus
  response: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

const ACTIVE_STATUSES: OwnerAgentRequestStatus[] = ["pending", "running"]
const ACTIVE_STALE_MS = 45 * 60 * 1000
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const RATE_WINDOW_MS = 60 * 60 * 1000
const MAX_REQUESTS_PER_PROFILE_PER_WINDOW = 12
const MAX_ACTIVE_REQUESTS_GLOBALLY = 4
const MAX_TITLE_CHARS = 120
const MAX_REQUEST_CHARS = 12_000
const MAX_RESPONSE_CHARS = 12_000
const MAX_ERROR_CHARS = 2_000

export function createOwnerAgentRequest(input: {
  requesterProfileId: string
  requesterConversationId: string
  requesterAgentId: string
  title: string
  request: string
}): OwnerAgentRequest {
  const requesterProfileId = cleanId(input.requesterProfileId, "requester profile")
  if (requesterProfileId === ADMIN_PROFILE_ID) {
    throw new Error("Owner-agent help is only available to member profiles.")
  }
  const requesterConversationId = cleanText(
    input.requesterConversationId,
    180,
    "requester conversation",
  )
  const requesterAgentId = cleanText(input.requesterAgentId, 80, "requester agent")
  const title = cleanText(input.title, MAX_TITLE_CHARS, "title")
  const request = cleanText(input.request, MAX_REQUEST_CHARS, "request")
  const database = getControlDb()
  const now = Date.now()
  const id = `oar_${crypto.randomUUID()}`

  const create = database.transaction(() => {
    database
      .prepare(
        `
          UPDATE owner_agent_requests
          SET status = 'failed',
              error = 'Request expired while still active.',
              updatedAt = @now,
              completedAt = @now
          WHERE status IN ('pending', 'running')
            AND updatedAt < @staleBefore
        `,
      )
      .run({ now, staleBefore: now - ACTIVE_STALE_MS })

    database
      .prepare(
        `
          DELETE FROM owner_agent_requests
          WHERE status NOT IN ('pending', 'running')
            AND updatedAt < ?
        `,
      )
      .run(now - RETENTION_MS)

    const alreadyActive = database
      .prepare(
        `
          SELECT id
          FROM owner_agent_requests
          WHERE requesterProfileId = ?
            AND status IN ('pending', 'running')
          LIMIT 1
        `,
      )
      .get(requesterProfileId) as { id: string } | undefined
    if (alreadyActive) {
      throw new Error(
        `This profile already has an active owner-agent request (${alreadyActive.id}). Wait for it to finish before asking again.`,
      )
    }

    const recent = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM owner_agent_requests
          WHERE requesterProfileId = ?
            AND createdAt >= ?
        `,
      )
      .get(requesterProfileId, now - RATE_WINDOW_MS) as { count: number }
    if (recent.count >= MAX_REQUESTS_PER_PROFILE_PER_WINDOW) {
      throw new Error(
        "Owner-agent request rate limit reached for this profile. Try again later.",
      )
    }

    const active = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM owner_agent_requests
          WHERE status IN ('pending', 'running')
        `,
      )
      .get() as { count: number }
    if (active.count >= MAX_ACTIVE_REQUESTS_GLOBALLY) {
      throw new Error("The owner agent is busy with other profile requests. Try again shortly.")
    }

    database
      .prepare(
        `
          INSERT INTO owner_agent_requests (
            id, requesterProfileId, requesterConversationId, requesterAgentId,
            ownerProfileId, ownerConversationId, ownerAgentThreadId, title,
            request, status, response, error, createdAt, updatedAt, completedAt
          ) VALUES (
            @id, @requesterProfileId, @requesterConversationId, @requesterAgentId,
            @ownerProfileId, NULL, NULL, @title,
            @request, 'pending', NULL, NULL, @createdAt, @updatedAt, NULL
          )
        `,
      )
      .run({
        id,
        requesterProfileId,
        requesterConversationId,
        requesterAgentId,
        ownerProfileId: ADMIN_PROFILE_ID,
        title,
        request,
        createdAt: now,
        updatedAt: now,
      })
  })
  create()

  recordProfileAudit({
    actorProfileId: requesterProfileId,
    targetProfileId: ADMIN_PROFILE_ID,
    type: "owner_agent.requested",
    summary: `Requested owner-agent help: ${title}`,
    payload: { requestId: id, requesterAgentId },
  })

  const created = getOwnerAgentRequest(id)
  if (!created) throw new Error(`Failed to create owner-agent request ${id}.`)
  return created
}

export function getOwnerAgentRequest(id: string): OwnerAgentRequest | null {
  const row = getControlDb()
    .prepare(`SELECT * FROM owner_agent_requests WHERE id = ?`)
    .get(id) as OwnerAgentRequest | undefined
  return row ? normalizeRow(row) : null
}

export function startOwnerAgentRequest(
  id: string,
  ownerConversationId: string,
  ownerAgentThreadId: string,
): OwnerAgentRequest {
  const now = Date.now()
  const result = getControlDb()
    .prepare(
      `
        UPDATE owner_agent_requests
        SET status = 'running',
            ownerConversationId = @ownerConversationId,
            ownerAgentThreadId = @ownerAgentThreadId,
            updatedAt = @updatedAt
        WHERE id = @id AND status = 'pending'
      `,
    )
    .run({ id, ownerConversationId, ownerAgentThreadId, updatedAt: now })
  if (result.changes === 0) {
    throw new Error(`Owner-agent request ${id} is no longer pending.`)
  }
  const request = getOwnerAgentRequest(id)
  if (!request) throw new Error(`Owner-agent request ${id} disappeared.`)
  return request
}

export function completeOwnerAgentRequest(input: {
  id: string
  status: "handled" | "needs_user"
  response: string
}): { request: OwnerAgentRequest; transitioned: boolean } {
  const response = cleanText(input.response, MAX_RESPONSE_CHARS, "response")
  const now = Date.now()
  const result = getControlDb()
    .prepare(
      `
        UPDATE owner_agent_requests
        SET status = @status,
            response = @response,
            error = NULL,
            updatedAt = @updatedAt,
            completedAt = @completedAt
        WHERE id = @id AND status IN ('pending', 'running')
      `,
    )
    .run({
      id: input.id,
      status: input.status,
      response,
      updatedAt: now,
      completedAt: now,
    })
  const request = getOwnerAgentRequest(input.id)
  if (!request) throw new Error(`Unknown owner-agent request: ${input.id}`)
  if (result.changes > 0) {
    recordProfileAudit({
      actorProfileId: ADMIN_PROFILE_ID,
      targetProfileId: request.requesterProfileId,
      type:
        input.status === "needs_user"
          ? "owner_agent.escalated"
          : "owner_agent.handled",
      summary:
        input.status === "needs_user"
          ? `Owner agent escalated: ${request.title}`
          : `Owner agent handled: ${request.title}`,
      payload: { requestId: request.id, status: input.status },
    })
  }
  return { request, transitioned: result.changes > 0 }
}

export function failOwnerAgentRequest(id: string, error: string): OwnerAgentRequest {
  const now = Date.now()
  const cleanError = cleanText(error, MAX_ERROR_CHARS, "error")
  const result = getControlDb()
    .prepare(
      `
        UPDATE owner_agent_requests
        SET status = 'failed',
            error = @error,
            updatedAt = @updatedAt,
            completedAt = @completedAt
        WHERE id = @id AND status IN ('pending', 'running')
      `,
    )
    .run({ id, error: cleanError, updatedAt: now, completedAt: now })
  const request = getOwnerAgentRequest(id)
  if (!request) throw new Error(`Unknown owner-agent request: ${id}`)
  if (result.changes > 0) {
    recordProfileAudit({
      actorProfileId: ADMIN_PROFILE_ID,
      targetProfileId: request.requesterProfileId,
      type: "owner_agent.failed",
      summary: `Owner-agent help failed: ${request.title}`,
      payload: { requestId: request.id },
    })
  }
  return request
}

export function failOwnerAgentEscalation(
  id: string,
  error: string,
): OwnerAgentRequest {
  const now = Date.now()
  const cleanError = cleanText(error, MAX_ERROR_CHARS, "error")
  const result = getControlDb()
    .prepare(
      `
        UPDATE owner_agent_requests
        SET status = 'failed',
            error = @error,
            updatedAt = @updatedAt,
            completedAt = @completedAt
        WHERE id = @id AND status = 'needs_user'
      `,
    )
    .run({ id, error: cleanError, updatedAt: now, completedAt: now })
  const request = getOwnerAgentRequest(id)
  if (!request) throw new Error(`Unknown owner-agent request: ${id}`)
  if (result.changes > 0) {
    recordProfileAudit({
      actorProfileId: ADMIN_PROFILE_ID,
      targetProfileId: request.requesterProfileId,
      type: "owner_agent.failed",
      summary: `Owner-agent escalation failed: ${request.title}`,
      payload: { requestId: request.id },
    })
  }
  return request
}

function cleanId(value: string, label: string): string {
  const clean = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(clean)) {
    throw new Error(`Invalid ${label}.`)
  }
  return clean
}

function cleanText(value: string, maxChars: number, label: string): string {
  const clean = redactLikelySecrets(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
  if (!clean) throw new Error(`${label} must be a non-empty string.`)
  return clean.length <= maxChars
    ? clean
    : `${clean.slice(0, maxChars - 24).trimEnd()}\n[truncated]`
}

function normalizeRow(row: OwnerAgentRequest): OwnerAgentRequest {
  const status = OWNER_AGENT_REQUEST_STATUSES.includes(row.status)
    ? row.status
    : "failed"
  return {
    ...row,
    status,
    ownerConversationId: row.ownerConversationId ?? null,
    ownerAgentThreadId: row.ownerAgentThreadId ?? null,
    response: row.response ?? null,
    error: row.error ?? null,
    completedAt: row.completedAt ?? null,
  }
}

export const OWNER_AGENT_ACTIVE_STATUSES = new Set(ACTIVE_STATUSES)
