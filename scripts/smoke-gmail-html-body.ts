/**
 * Smoke tests for Gmail body extraction.
 *
 * Run: npx tsx scripts/smoke-gmail-html-body.ts
 */
import { formatGmailThreadMessage, type GmailMessage } from "../lib/integrations/gmail"
import { base64UrlEncode, extractMessageBody, type GmailPayloadPart } from "../lib/integrations/gmail-message-formatting"

let failures = 0
function check(label: string, cond: unknown, detail?: unknown): void {
  const ok = Boolean(cond)
  if (!ok) failures += 1
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : "  (" + JSON.stringify(detail) + ")"}`)
}

function encoded(value: string): string {
  return base64UrlEncode(Buffer.from(value, "utf-8"))
}

function textPart(mimeType: "text/plain" | "text/html", value: string, partId: string): GmailPayloadPart {
  return {
    partId,
    mimeType,
    body: {
      data: encoded(value),
      size: Buffer.byteLength(value, "utf-8"),
    },
  }
}

{
  const payload = textPart("text/plain", "Plain order note with all details intact.", "0")
  const extracted = extractMessageBody(payload)
  check("plain-only: body preserved", extracted.body === "Plain order note with all details intact.", extracted)
  check("plain-only: source metadata", extracted.bodySource === "text/plain" && extracted.hasPlain && !extracted.hasHtml, extracted)
}

const plainFallback = [
  "View your Steam receipt online:",
  "https://store.steampowered.com/account/history/receipt/example",
].join("\n")

const steamLikeHtml = `
<!doctype html>
<html>
  <body>
    <p>Steam account: receipt_fixture_user</p>
    <table>
      <tr><th>Item</th><th>Price</th></tr>
      <tr><td>Subnautica Deep Ocean Bundle</td><td>26.99 EUR</td></tr>
      <tr><td>Includes</td><td>Subnautica 2</td></tr>
      <tr><td>Subtotal</td><td>22.31 EUR</td></tr>
      <tr><td>VAT</td><td>4.68 EUR</td></tr>
      <tr><td>Invoice</td><td>fixture-invoice-id</td></tr>
    </table>
  </body>
</html>
`

{
  const payload: GmailPayloadPart = {
    mimeType: "multipart/alternative",
    parts: [
      textPart("text/plain", plainFallback, "0"),
      textPart("text/html", steamLikeHtml, "1"),
    ],
  }
  const extracted = extractMessageBody(payload)
  check("multipart receipt: HTML source chosen", extracted.bodySource === "text/html", extracted)
  check("multipart receipt: plain/html metadata", extracted.hasPlain && extracted.hasHtml, extracted)
  check("multipart receipt: item retained", extracted.body.includes("Subnautica Deep Ocean Bundle"), extracted.body)
  check("multipart receipt: included item retained", extracted.body.includes("Subnautica 2"), extracted.body)
  check("multipart receipt: amount retained", extracted.body.includes("26.99 EUR"), extracted.body)
  check("multipart receipt: table row readable", extracted.body.includes("Subnautica Deep Ocean Bundle | 26.99 EUR"), extracted.body)
  check("multipart receipt: warning explains HTML preference", extracted.extractionWarnings.some(w => w.includes("HTML-derived")), extracted)

  const message: GmailMessage = {
    id: "msg-steam-fixture",
    threadId: "thread-steam-fixture",
    labelIds: ["INBOX"],
    snippet: "Thank you for your purchase.",
    payload: {
      ...payload,
      headers: [
        { name: "From", value: "Steam <noreply@steampowered.com>" },
        { name: "To", value: "user@example.com" },
        { name: "Date", value: "Sat, 06 Jun 2026 08:10:00 +0000" },
        { name: "Subject", value: "Your Steam purchase" },
      ],
    },
  }
  const formatted = formatGmailThreadMessage(message)
  check("read-thread formatter: exposes HTML-derived body", formatted.body.includes("Subnautica Deep Ocean Bundle | 26.99 EUR"), formatted)
  check("read-thread formatter: exposes source metadata", formatted.bodySource === "text/html" && formatted.hasHtml && formatted.hasPlain, formatted)
  check("read-thread formatter: exposes quality metadata", Array.isArray(formatted.extractionWarnings) && formatted.needsVisualInspection === false, formatted)
}

{
  const imageOnlyPayload: GmailPayloadPart = {
    mimeType: "multipart/alternative",
    parts: [
      textPart("text/plain", plainFallback, "0"),
      textPart("text/html", '<html><body><img src="cid:a"><img src="cid:b"><img src="cid:c"></body></html>', "1"),
    ],
  }
  const extracted = extractMessageBody(imageOnlyPayload)
  check("image-only HTML: visual inspection flagged", extracted.needsVisualInspection === true, extracted)
  check("image-only HTML: warning emitted", extracted.extractionWarnings.some(w => w.includes("visual inspection")), extracted)
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`)
process.exit(failures === 0 ? 0 : 1)
