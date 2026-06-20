/**
 * Smoke tests for Gmail outgoing MIME HTML/CID formatting.
 *
 * Runs fully offline and deterministically. It verifies that HTML emails use
 * multipart/alternative and CID inline images use multipart/related with
 * Content-ID + inline disposition, instead of being emitted as text/plain.
 *
 * Run: npx tsx scripts/smoke-gmail-mime-html.ts
 */
import { assertOutgoingAttachmentBudget, buildMimeMessage } from "../lib/integrations/gmail-message-formatting"

let failures = 0
function check(label: string, cond: unknown, detail?: unknown): void {
  const ok = Boolean(cond)
  if (!ok) failures += 1
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : "  (" + JSON.stringify(detail) + ")"}`)
}

const htmlOnly = buildMimeMessage({
  from: "horia@example.com",
  to: ["test@example.com"],
  cc: [],
  bcc: [],
  subject: "HTML test",
  body: "Plain fallback",
  html: "<p>Hello <strong>HTML</strong></p>",
})

check("html-only: uses multipart/alternative", htmlOnly.includes("Content-Type: multipart/alternative; boundary="), htmlOnly)
check("html-only: includes text/html part", htmlOnly.includes('Content-Type: text/html; charset="UTF-8"'), htmlOnly)
check("html-only: includes plain fallback", htmlOnly.includes("Plain fallback"), htmlOnly)
check("html-only: top entity is not text/plain", !htmlOnly.split("\r\n\r\n")[0].includes('Content-Type: text/plain; charset="UTF-8"'), htmlOnly)

const htmlWithInline = buildMimeMessage({
  from: "horia@example.com",
  to: ["test@example.com"],
  cc: [],
  bcc: [],
  subject: "CID test",
  body: "Plain fallback with logo",
  html: '<html><body><img src="cid:logo"><img src="cid:hero1"></body></html>',
  inlineAttachments: [
    {
      filename: "logo.png",
      mimeType: "image/png",
      contentId: "logo",
      bytes: Buffer.from("fake-png"),
    },
    {
      filename: "hero1.jpeg",
      mimeType: "image/jpeg",
      contentId: "hero1",
      bytes: Buffer.from("fake-jpeg"),
    },
  ],
})

check("inline: uses multipart/related", htmlWithInline.includes("Content-Type: multipart/related; boundary="), htmlWithInline)
check("inline: nests multipart/alternative", htmlWithInline.includes("Content-Type: multipart/alternative; boundary="), htmlWithInline)
check("inline: logo Content-ID", htmlWithInline.includes("Content-ID: <logo>"), htmlWithInline)
check("inline: hero Content-ID", htmlWithInline.includes("Content-ID: <hero1>"), htmlWithInline)
check("inline: inline disposition", (htmlWithInline.match(/Content-Disposition: inline/g) ?? []).length === 2, htmlWithInline)
check("inline: HTML references cid", htmlWithInline.includes('src="cid:logo"') && htmlWithInline.includes('src="cid:hero1"'), htmlWithInline)
check("inline: not normal attachment disposition", !htmlWithInline.includes("Content-Disposition: attachment"), htmlWithInline)

const htmlInlineAndAttachment = buildMimeMessage({
  from: "horia@example.com",
  to: ["test@example.com"],
  cc: [],
  bcc: [],
  subject: "CID plus attachment",
  body: "Plain fallback",
  html: '<p><img src="cid:logo"></p>',
  inlineAttachments: [{
    filename: "logo.png",
    mimeType: "image/png",
    contentId: "logo",
    bytes: Buffer.from("fake-png"),
  }],
  attachments: [{
    filename: "offer.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from("fake-pdf"),
  }],
})

check("mixed: outer multipart/mixed", htmlInlineAndAttachment.includes("Content-Type: multipart/mixed; boundary="), htmlInlineAndAttachment)
check("mixed: keeps inline image inline", htmlInlineAndAttachment.includes("Content-ID: <logo>"), htmlInlineAndAttachment)
check("mixed: keeps normal attachment as attachment", htmlInlineAndAttachment.includes('Content-Disposition: attachment; filename="offer.pdf"'), htmlInlineAndAttachment)

try {
  assertOutgoingAttachmentBudget({
    attachments: [{ filename: "a.bin", mimeType: "application/octet-stream", bytes: Buffer.alloc(20 * 1024 * 1024) }],
    inlineAttachments: [{ filename: "b.bin", mimeType: "application/octet-stream", contentId: "b", bytes: Buffer.alloc(6 * 1024 * 1024) }],
  })
  check("budget: rejects combined over 25MB", false)
} catch (err) {
  check("budget: rejects combined over 25MB", err instanceof Error && err.message.includes("including inline images"), err)
}

if (failures > 0) {
  console.error(`smoke-gmail-mime-html failed: ${failures} failure(s)`)
  process.exit(1)
}

console.log("smoke-gmail-mime-html passed")
