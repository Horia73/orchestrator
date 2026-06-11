import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import webpush from "web-push"

import db from "@/lib/db"
import { getEnvValue, PRIVATE_STATE_DIR } from "@/lib/config"

interface VapidKeys {
  publicKey: string
  privateKey: string
}

interface PushSubscriptionPayload {
  endpoint: string
  expirationTime?: number | null
  keys: {
    p256dh: string
    auth: string
  }
}

const VAPID_KEY_PATH = path.join(PRIVATE_STATE_DIR, "web-push-vapid.json")
let cachedVapidKeys: VapidKeys | null = null
let vapidConfigured = false

function getVapidSubject(): string {
  const configured =
    getEnvValue("WEB_PUSH_SUBJECT")?.trim() ||
    getEnvValue("ORCHESTRATOR_APP_URL")?.trim() ||
    getEnvValue("NEXT_PUBLIC_APP_URL")?.trim()

  if (!configured) return "mailto:orchestrator@example.com"
  if (
    configured.startsWith("mailto:") ||
    configured.startsWith("https://") ||
    configured.startsWith("http://")
  ) {
    return configured
  }
  return `mailto:${configured}`
}

function readOrCreateVapidKeys(): VapidKeys {
  if (cachedVapidKeys) return cachedVapidKeys

  const envPublicKey = getEnvValue("WEB_PUSH_PUBLIC_KEY")?.trim()
  const envPrivateKey = getEnvValue("WEB_PUSH_PRIVATE_KEY")?.trim()
  if (envPublicKey && envPrivateKey) {
    cachedVapidKeys = { publicKey: envPublicKey, privateKey: envPrivateKey }
    return cachedVapidKeys
  }

  try {
    const stored = JSON.parse(
      fs.readFileSync(VAPID_KEY_PATH, "utf8")
    ) as Partial<VapidKeys>
    if (stored.publicKey && stored.privateKey) {
      cachedVapidKeys = {
        publicKey: stored.publicKey,
        privateKey: stored.privateKey,
      }
      return cachedVapidKeys
    }
  } catch {
    // Missing or malformed local keys: generate a stable pair below.
  }

  const generated = webpush.generateVAPIDKeys()
  cachedVapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  }
  fs.mkdirSync(PRIVATE_STATE_DIR, { recursive: true })
  fs.writeFileSync(VAPID_KEY_PATH, JSON.stringify(cachedVapidKeys, null, 2), {
    mode: 0o600,
  })
  return cachedVapidKeys
}

function configureWebPush() {
  if (vapidConfigured) return
  const keys = readOrCreateVapidKeys()
  webpush.setVapidDetails(getVapidSubject(), keys.publicKey, keys.privateKey)
  vapidConfigured = true
}

function subscriptionId(endpoint: string): string {
  return `push_${createHash("sha256").update(endpoint).digest("base64url")}`
}

function assertPushSubscription(value: unknown): PushSubscriptionPayload {
  if (!value || typeof value !== "object")
    throw new Error("Missing subscription.")
  const candidate = value as PushSubscriptionPayload
  if (typeof candidate.endpoint !== "string" || !candidate.endpoint) {
    throw new Error("Subscription endpoint is required.")
  }
  if (
    !candidate.keys ||
    typeof candidate.keys.p256dh !== "string" ||
    typeof candidate.keys.auth !== "string"
  ) {
    throw new Error("Subscription keys are required.")
  }
  return candidate
}

export function getVapidPublicKey(): string {
  return readOrCreateVapidKeys().publicKey
}

export function savePushSubscription(
  subscriptionValue: unknown,
  userAgent: string | null
): void {
  const subscription = assertPushSubscription(subscriptionValue)
  const now = Date.now()

  db.prepare(
    `
        INSERT INTO push_subscriptions (id, endpoint, subscription, userAgent, createdAt, updatedAt)
        VALUES (@id, @endpoint, @subscription, @userAgent, @createdAt, @updatedAt)
        ON CONFLICT(endpoint) DO UPDATE SET
            subscription = excluded.subscription,
            userAgent = excluded.userAgent,
            updatedAt = excluded.updatedAt
    `
  ).run({
    id: subscriptionId(subscription.endpoint),
    endpoint: subscription.endpoint,
    subscription: JSON.stringify(subscription),
    userAgent,
    createdAt: now,
    updatedAt: now,
  })
}

export function deletePushSubscription(endpoint: string): void {
  if (!endpoint) return
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint)
}

export interface PushSubscriptionSummary {
  id: string
  endpoint: string
  userAgent: string | null
  createdAt: number
  updatedAt: number
}

export function listPushSubscriptions(): PushSubscriptionSummary[] {
  return db
    .prepare(
      "SELECT id, endpoint, userAgent, createdAt, updatedAt FROM push_subscriptions ORDER BY updatedAt DESC"
    )
    .all() as PushSubscriptionSummary[]
}

function compactNotificationBody(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "code block")
    .replace(/[*_`>#~-]/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220)
}

async function sendPushPayloadToAll(
  payload: string,
  options: { TTL: number; urgency: "very-low" | "low" | "normal" | "high" }
): Promise<void> {
  const rows = db
    .prepare("SELECT endpoint, subscription FROM push_subscriptions")
    .all() as Array<{
    endpoint: string
    subscription: string
  }>
  if (rows.length === 0) return

  configureWebPush()

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          JSON.parse(row.subscription),
          payload,
          options
        )
      } catch (error) {
        const statusCode = (error as { statusCode?: unknown }).statusCode
        if (statusCode === 404 || statusCode === 410) {
          deletePushSubscription(row.endpoint)
          return
        }
        console.warn("Failed to send push notification", error)
      }
    })
  )
}

export interface PushTestResult {
  endpoint: string
  ok: boolean
  statusCode: number | null
  removed: boolean
  error: string | null
}

/**
 * Sends a test notification and reports the push service's response per
 * endpoint, so the settings UI can distinguish "the push service accepted the
 * message" from "nothing is subscribed" / "the endpoint is dead".
 */
export async function sendTestPushNotification(
  endpoint?: string
): Promise<PushTestResult[]> {
  const rows = (
    endpoint
      ? db
          .prepare(
            "SELECT endpoint, subscription FROM push_subscriptions WHERE endpoint = ?"
          )
          .all(endpoint)
      : db.prepare("SELECT endpoint, subscription FROM push_subscriptions").all()
  ) as Array<{ endpoint: string; subscription: string }>
  if (rows.length === 0) return []

  configureWebPush()

  const payload = JSON.stringify({
    type: "test",
    title: "Test notification",
    body: "Push notifications are working on this device.",
    url: "/settings?tab=notifications",
    tag: `push-test-${Date.now()}`,
  })

  return Promise.all(
    rows.map(async (row): Promise<PushTestResult> => {
      try {
        const result = await webpush.sendNotification(
          JSON.parse(row.subscription),
          payload,
          { TTL: 5 * 60, urgency: "high" }
        )
        return {
          endpoint: row.endpoint,
          ok: true,
          statusCode: result.statusCode,
          removed: false,
          error: null,
        }
      } catch (error) {
        const statusCode = (error as { statusCode?: unknown }).statusCode
        const removed = statusCode === 404 || statusCode === 410
        if (removed) deletePushSubscription(row.endpoint)
        return {
          endpoint: row.endpoint,
          ok: false,
          statusCode: typeof statusCode === "number" ? statusCode : null,
          removed,
          error: error instanceof Error ? error.message : "Push send failed",
        }
      }
    })
  )
}

export async function sendInboxPushNotification(args: {
  conversationId: string
  title: string
  body: string
}): Promise<void> {
  const unreadRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM conversations WHERE origin = 'inbox' AND readAt IS NULL"
    )
    .get() as { n: number }

  const payload = JSON.stringify({
    type: "inbox",
    inboxId: args.conversationId,
    title: args.title || "Inbox",
    body: compactNotificationBody(args.body) || "New Inbox item",
    url: `/inbox?item=${encodeURIComponent(args.conversationId)}`,
    unread: unreadRow.n,
  })

  await sendPushPayloadToAll(payload, { TTL: 60 * 60, urgency: "high" })
}

export async function sendChatCompletionPushNotification(args: {
  conversationId: string
  title: string
  body: string
}): Promise<void> {
  const payload = JSON.stringify({
    type: "chat",
    chatId: args.conversationId,
    title: args.title || "Chat finished",
    body:
      compactNotificationBody(args.body) ||
      "The assistant finished responding.",
    url: `/?chat=${encodeURIComponent(args.conversationId)}`,
    tag: `chat-${args.conversationId}`,
  })

  await sendPushPayloadToAll(payload, { TTL: 60 * 60, urgency: "normal" })
}
