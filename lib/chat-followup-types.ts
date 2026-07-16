export type ChatFollowUpSource = "user" | "background-job" | "async-delegation"

/** Safe client-facing projection of an in-memory follow-up queue entry. */
export interface ChatFollowUpSnapshot {
  followUpId: string
  userMessageId: string
  source: ChatFollowUpSource
  queuedAt: number
}
