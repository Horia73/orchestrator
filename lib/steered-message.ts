/**
 * Steered-message content tag.
 *
 * A user message delivered INTO a running turn (provider steering, e.g. codex
 * `turn/steer`) is persisted as a normal user row whose content is wrapped in
 * this tag — mirroring the `<background-job-notice>` pattern, so no schema
 * change is needed and the row survives every slim/full message builder.
 *
 * Chat hides the standalone bubble for tagged rows: the message renders inline
 * inside the assistant turn at its exact injection point (the
 * `steered_message` reasoning entry). History replayed to providers keeps the
 * tag — it is self-explanatory context that the input arrived mid-turn.
 */
export const STEERED_MESSAGE_TAG = "steered-message"

const STEERED_MESSAGE_RE = /^<steered-message>\n?([\s\S]*?)\n?<\/steered-message>\s*$/

export function wrapSteeredMessage(text: string): string {
  return `<${STEERED_MESSAGE_TAG}>\n${text}\n</${STEERED_MESSAGE_TAG}>`
}

/** The inner text when `content` is a steered-message row, else null. */
export function parseSteeredMessage(content: string): string | null {
  const match = STEERED_MESSAGE_RE.exec(content.trim())
  return match ? match[1] : null
}

export function isSteeredMessageContent(content: string): boolean {
  return STEERED_MESSAGE_RE.test(content.trim())
}
