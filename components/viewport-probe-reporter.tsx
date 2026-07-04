"use client"

import * as React from "react"

// TEMPORARY diagnostic (2026-07-04): iOS 26/27 standalone report conflicting
// viewport geometry (dvh short on 26, lvh too tall on both — see globals.css
// note), and two blind fixes are burned. This silently POSTs the real
// on-device numbers to /api/dev/viewport-report (visible in `docker compose
// logs`) so the next fix is designed from data. Remove once the standalone
// viewport bug is resolved.
const MAX_REPORTS_PER_SESSION = 6

function measure(reason: string) {
  const de = document.documentElement
  const vv = window.visualViewport
  const probe = document.createElement("div")
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;"
  document.body.appendChild(probe)
  const unit = (h: string) => {
    probe.style.height = h
    return Math.round(probe.getBoundingClientRect().height * 100) / 100
  }
  const units = {
    vh: unit("100vh"),
    dvh: unit("100dvh"),
    svh: unit("100svh"),
    lvh: unit("100lvh"),
    fill: unit("-webkit-fill-available"),
  }
  probe.style.height = "0"
  probe.style.paddingTop = "env(safe-area-inset-top)"
  probe.style.paddingBottom = "env(safe-area-inset-bottom)"
  const probeStyle = getComputedStyle(probe)
  const safeTop = parseFloat(probeStyle.paddingTop) || 0
  const safeBottom = parseFloat(probeStyle.paddingBottom) || 0
  probe.remove()

  const body = document.body
  return {
    reason,
    at: new Date().toISOString(),
    ua: navigator.userAgent,
    standalone:
      (navigator as { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches,
    fullscreen: window.matchMedia("(display-mode: fullscreen)").matches,
    screen: { w: window.screen?.width ?? 0, h: window.screen?.height ?? 0 },
    dpr: window.devicePixelRatio,
    inner: { w: window.innerWidth, h: window.innerHeight },
    client: { w: de.clientWidth, h: de.clientHeight },
    scroll: { docH: de.scrollHeight, y: window.scrollY },
    vv: vv
      ? {
          w: Math.round(vv.width),
          h: Math.round(vv.height),
          top: Math.round(vv.offsetTop),
          left: Math.round(vv.offsetLeft),
          scale: vv.scale,
        }
      : null,
    units,
    safeTop,
    safeBottom,
    bodyRect: (() => {
      const r = body.getBoundingClientRect()
      return { top: Math.round(r.top), h: Math.round(r.height) }
    })(),
  }
}

export function ViewportProbeReporter() {
  React.useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) return

    let sent = 0
    const send = (reason: string) => {
      if (sent >= MAX_REPORTS_PER_SESSION) return
      sent++
      try {
        void fetch("/api/dev/viewport-report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(measure(reason)),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // measurement/serialization must never break the app shell
      }
    }

    const t1 = window.setTimeout(() => send("load"), 1500)
    const t2 = window.setTimeout(() => send("settled"), 5000)
    let debounce: number | undefined
    const onViewportChange = () => {
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => send("viewport-change"), 500)
    }
    window.visualViewport?.addEventListener("resize", onViewportChange)
    window.addEventListener("orientationchange", onViewportChange)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(debounce)
      window.visualViewport?.removeEventListener("resize", onViewportChange)
      window.removeEventListener("orientationchange", onViewportChange)
    }
  }, [])

  return null
}
