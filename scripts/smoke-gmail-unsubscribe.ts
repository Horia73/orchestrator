/**
 * Smoke tests for the Gmail unsubscribe plumbing (lib/integrations/gmail.ts).
 *
 * Runs fully offline and deterministically — exercises only the pure helpers,
 * no Gmail API call:
 *  - parseListUnsubscribe: RFC 2369 angle-bracket parsing, RFC 8058 one-click
 *    detection, https/mailto classification, method priority, subject parsing.
 *  - isSafeUnsubscribeHttpsUrl: HTTPS-only + SSRF (localhost / RFC1918 /
 *    link-local) blocking for the one-click POST path.
 *
 * Run: npx tsx scripts/smoke-gmail-unsubscribe.ts
 */
import { parseListUnsubscribe, isSafeUnsubscribeHttpsUrl } from "../lib/integrations/gmail"

let failures = 0
function check(label: string, cond: unknown, detail?: unknown): void {
  const ok = Boolean(cond)
  if (!ok) failures += 1
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : "  (" + JSON.stringify(detail) + ")"}`)
}

// --- parseListUnsubscribe ---------------------------------------------------

{
  const t = parseListUnsubscribe("<https://ex.com/u?id=1>, <mailto:unsub@ex.com>", "List-Unsubscribe=One-Click")
  check("one-click: method one_click", t.method === "one_click", t)
  check("one-click: httpsUrl captured", t.httpsUrl === "https://ex.com/u?id=1", t)
  check("one-click: mailto captured", t.mailto?.to === "unsub@ex.com", t)
  check("one-click: oneClick true", t.oneClick === true, t)
}

{
  const t = parseListUnsubscribe("<https://ex.com/u>", "List-Unsubscribe=One-Click")
  check("https + post (no mailto): one_click", t.method === "one_click", t)
}

{
  const t = parseListUnsubscribe("<https://ex.com/u>", "")
  check("https only, no post: link_only", t.method === "link_only", t)
  check("link_only: httpsUrl set", t.httpsUrl === "https://ex.com/u", t)
}

{
  const t = parseListUnsubscribe("<mailto:bye@list.com?subject=Unsub%20me>", "")
  check("mailto only: method mailto", t.method === "mailto", t)
  check("mailto: recipient parsed", t.mailto?.to === "bye@list.com", t)
  check("mailto: subject decoded", t.mailto?.subject === "Unsub me", t)
}

{
  // https + mailto, but no one-click → prefer the authenticated mailto path
  // over an unknown web link.
  const t = parseListUnsubscribe("<https://ex.com/u>, <mailto:x@ex.com>", "")
  check("https+mailto no post: prefers mailto", t.method === "mailto", t)
}

{
  const t = parseListUnsubscribe("", "")
  check("empty header: method none", t.method === "none", t)
  check("empty: hasNo httpsUrl/mailto", t.httpsUrl === null && t.mailto === null, t)
}

{
  const t = parseListUnsubscribe("<mailto:a@x.com>", "")
  check("mailto without subject: defaults to 'unsubscribe'", t.mailto?.subject === "unsubscribe", t)
}

// --- isSafeUnsubscribeHttpsUrl ---------------------------------------------

check("safe: public https ok", isSafeUnsubscribeHttpsUrl("https://list.example.com/u").ok === true)
check("unsafe: http rejected", isSafeUnsubscribeHttpsUrl("http://list.example.com/u").ok === false)
check("unsafe: localhost rejected", isSafeUnsubscribeHttpsUrl("https://localhost/u").ok === false)
check("unsafe: 127.x rejected", isSafeUnsubscribeHttpsUrl("https://127.0.0.1/u").ok === false)
check("unsafe: 10.x rejected", isSafeUnsubscribeHttpsUrl("https://10.0.0.5/u").ok === false)
check("unsafe: 192.168.x rejected", isSafeUnsubscribeHttpsUrl("https://192.168.1.10/u").ok === false)
check("unsafe: 172.16-31 rejected", isSafeUnsubscribeHttpsUrl("https://172.20.0.1/u").ok === false)
check("unsafe: 169.254 link-local rejected", isSafeUnsubscribeHttpsUrl("https://169.254.1.1/u").ok === false)
check("unsafe: invalid URL rejected", isSafeUnsubscribeHttpsUrl("not a url").ok === false)
check("safe: 172.15 (outside private) ok", isSafeUnsubscribeHttpsUrl("https://172.15.0.1/u").ok === true)

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`)
process.exit(failures === 0 ? 0 : 1)
