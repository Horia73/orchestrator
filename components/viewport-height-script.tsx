const VIEWPORT_HEIGHT_SCRIPT = `
(() => {
  const root = document.documentElement;
  const nav = window.navigator;
  const isIOS = /iP(ad|hone|od)/.test(nav.platform) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);

  function isStandalone() {
    return Boolean(
      nav.standalone ||
        window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches
    );
  }

  function screenBlockSize() {
    const screenWidth = Number(window.screen?.width) || 0;
    const screenHeight = Number(window.screen?.height) || 0;
    if (!screenWidth || !screenHeight) return 0;
    const portrait = window.matchMedia("(orientation: portrait)").matches || window.innerHeight >= window.innerWidth;
    return portrait ? Math.max(screenWidth, screenHeight) : Math.min(screenWidth, screenHeight);
  }

  function updateViewportHeight() {
    const visualHeight = Math.round(window.visualViewport?.height || 0);
    const innerHeight = Math.round(window.innerHeight || 0);
    const clientHeight = Math.round(root.clientHeight || 0);
    const visibleHeight = visualHeight || innerHeight || clientHeight;
    let appHeight = Math.max(visibleHeight, innerHeight, clientHeight);

    if (isIOS && isStandalone()) {
      const screenHeight = screenBlockSize();
      const missingHeight = screenHeight - appHeight;
      if (missingHeight > 0 && missingHeight <= Math.max(160, screenHeight * 0.18)) {
        appHeight = screenHeight;
      }
    }

    if (appHeight > 0) {
      root.style.setProperty("--orch-viewport-height", appHeight + "px");
    }

    const smallHeight = isIOS && isStandalone() ? appHeight : visibleHeight;
    if (smallHeight > 0) {
      root.style.setProperty("--orch-small-viewport-height", smallHeight + "px");
    }
  }

  updateViewportHeight();
  window.addEventListener("resize", updateViewportHeight, { passive: true });
  window.addEventListener("orientationchange", updateViewportHeight, { passive: true });
  window.addEventListener("pageshow", updateViewportHeight, { passive: true });
  window.visualViewport?.addEventListener("resize", updateViewportHeight);
  window.visualViewport?.addEventListener("scroll", updateViewportHeight);
})();
`

export function ViewportHeightScript() {
  return (
    <script
      id="orch-viewport-height"
      dangerouslySetInnerHTML={{ __html: VIEWPORT_HEIGHT_SCRIPT }}
    />
  )
}
