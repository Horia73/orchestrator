self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4)
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/")
  const raw = self.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

async function getApplicationServerKey() {
  const response = await fetch("/api/push/vapid-public-key", {
    cache: "no-store",
  })
  if (!response.ok) throw new Error("Push configuration is unavailable")
  const data = await response.json()
  if (typeof data.publicKey !== "string" || !data.publicKey) {
    throw new Error("Push public key is unavailable")
  }
  return urlBase64ToUint8Array(data.publicKey)
}

async function savePushSubscription(subscription) {
  const response = await fetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  })
  if (!response.ok) throw new Error("Push subscription could not be saved")
}

async function deletePushSubscription(subscription) {
  if (!subscription?.endpoint) return
  await fetch("/api/push/subscriptions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined)
}

const CHAT_PRESENCE_PROBE_TIMEOUT_MS = 300

function probeClientForActiveChat(client, chatId) {
  // Keep the previous focus-only behavior as a compatibility fallback while
  // an older already-open page is still running a bundle without the probe
  // responder. A refreshed page returns the exact active conversation state.
  const fallback = client.focused === true
  if (typeof MessageChannel !== "function") return Promise.resolve(fallback)

  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      self.clearTimeout(timer)
      channel.port1.close()
      resolve(value)
    }
    const timer = self.setTimeout(
      () => finish(fallback),
      CHAT_PRESENCE_PROBE_TIMEOUT_MS
    )

    channel.port1.onmessage = (event) => {
      const state = event.data || {}
      finish(
        state.type === "orchestrator:chat-presence-state" &&
          state.chatId === chatId &&
          state.active === true &&
          state.visible === true
      )
    }

    try {
      client.postMessage(
        {
          type: "orchestrator:chat-presence-probe",
          chatId,
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        [channel.port2]
      )
    } catch {
      finish(fallback)
    }
  })
}

async function hasVisibleActiveChatClient(chatId) {
  if (typeof chatId !== "string" || !chatId) return false
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  })
  const sameOriginClients = windowClients.filter((client) => {
    try {
      return new URL(client.url).origin === self.location.origin
    } catch {
      return false
    }
  })
  const presence = await Promise.all(
    sameOriginClients.map((client) => probeClientForActiveChat(client, chatId))
  )
  return presence.some(Boolean)
}

async function postMessageToWindowClients(message) {
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  })
  for (const client of windowClients) {
    try {
      const clientUrl = new URL(client.url)
      if (clientUrl.origin !== self.location.origin) continue
      client.postMessage(message)
    } catch {
      // Ignore stale or malformed clients; notification display is independent.
    }
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const applicationServerKey = await getApplicationServerKey()
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })
      await savePushSubscription(subscription)
      await deletePushSubscription(event.oldSubscription)
    })()
  )
})

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }

  const title =
    typeof data.title === "string" && data.title
      ? data.title
      : data.type === "chat"
        ? "Chat finished"
        : "Inbox"
  const body =
    typeof data.body === "string"
      ? data.body
      : data.type === "chat"
        ? "The assistant finished responding."
        : "New Inbox item"
  const unread = Number.isFinite(data.unread) ? data.unread : undefined
  const url =
    typeof data.url === "string" && data.url
      ? data.url
      : data.type === "chat"
        ? "/"
        : "/inbox"
  const isInbox = data.type === "inbox"
  const isChat = data.type === "chat"

  event.waitUntil(
    (async () => {
      if (
        isChat &&
        (await hasVisibleActiveChatClient(
          typeof data.chatId === "string" ? data.chatId : ""
        ))
      ) {
        return
      }

      if (isInbox) {
        await postMessageToWindowClients({
          type: "orchestrator:inbox-push",
          inboxId:
            typeof data.inboxId === "string" && data.inboxId
              ? data.inboxId
              : undefined,
          unread,
          url,
          at: Date.now(),
        })
      }

      const registrationWithBadge = self.registration
      if (
        typeof unread === "number" &&
        typeof registrationWithBadge.setAppBadge === "function"
      ) {
        try {
          if (unread > 0) await registrationWithBadge.setAppBadge(unread)
          else if (typeof registrationWithBadge.clearAppBadge === "function")
            await registrationWithBadge.clearAppBadge()
        } catch {
          // Badge support varies by browser; notification delivery is independent.
        }
      }

      await self.registration.showNotification(title, {
        body,
        tag:
          typeof data.tag === "string" && data.tag
            ? data.tag
            : typeof data.inboxId === "string"
              ? `inbox-${data.inboxId}`
              : typeof data.chatId === "string"
                ? `chat-${data.chatId}`
                : "inbox",
        icon: "/icon.svg",
        badge: "/icon.svg",
        renotify: isInbox,
        requireInteraction: isInbox,
        silent: false,
        timestamp: Date.now(),
        data: { url, type: data.type || "inbox" },
        actions: isInbox
          ? [{ action: "open", title: "Open Inbox" }]
          : isChat
            ? [{ action: "open", title: "Open Chat" }]
            : [],
      })
    })()
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const targetUrl = new URL(
    event.notification.data?.url || "/inbox",
    self.location.origin
  ).href

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      for (const client of windowClients) {
        const clientUrl = new URL(client.url)
        if (clientUrl.origin !== self.location.origin) continue
        if ("navigate" in client) await client.navigate(targetUrl)
        if ("focus" in client) return client.focus()
      }
      return self.clients.openWindow(targetUrl)
    })()
  )
})
