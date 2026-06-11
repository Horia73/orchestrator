// Tiny external store telling the chat page which conversation the ChatView
// has fully settled for (initial messages rendered + scroll restored). The
// page gates its fade-in on this so the view eases in over a finished layout
// instead of revealing content that is still shifting into place.
//
// A module store (not a window event) so the page can read the current value
// on mount — ChatView publishes from a layout effect that runs before the
// page's own effects could attach an event listener.

let settledConversationId: string | null = null
const listeners = new Set<() => void>()

export function publishChatViewSettled(conversationId: string | null) {
  if (settledConversationId === conversationId) return
  settledConversationId = conversationId
  for (const listener of listeners) listener()
}

export function subscribeChatViewSettled(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getChatViewSettledConversationId(): string | null {
  return settledConversationId
}

export function getServerChatViewSettledConversationId(): string | null {
  return null
}
