self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }

  const title =
    typeof data.title === "string" && data.title ? data.title : "Inbox"
  const body = typeof data.body === "string" ? data.body : "New Inbox item"
  const unread = Number.isFinite(data.unread) ? data.unread : undefined
  const url = typeof data.url === "string" && data.url ? data.url : "/inbox"
  const isInbox = data.type === "inbox"

  event.waitUntil(
    (async () => {
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
          typeof data.inboxId === "string" ? `inbox-${data.inboxId}` : "inbox",
        icon: "/icon.svg",
        badge: "/icon.svg",
        renotify: isInbox,
        requireInteraction: isInbox,
        silent: false,
        data: { url },
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
