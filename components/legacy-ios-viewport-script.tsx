const LEGACY_IOS_VIEWPORT_SCRIPT = `
(() => {
  const root = document.documentElement;
  const nav = window.navigator;
  const isIOS = /iP(ad|hone|od)/.test(nav.platform) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);

  function standalone() {
    return Boolean(
      nav.standalone ||
        window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches
    );
  }

  function platformMajorVersion() {
    const ua = nav.userAgent || "";
    const osMatch = ua.match(/(?:CPU(?: iPhone)? OS|CPU OS) (\\d+)_/);
    if (osMatch) return Number(osMatch[1]) || 0;
    const safariMatch = ua.match(/Version\\/(\\d+)/);
    if (safariMatch) return Number(safariMatch[1]) || 0;
    return 0;
  }

  function screenBlockSize() {
    const width = Number(window.screen?.width) || 0;
    const height = Number(window.screen?.height) || 0;
    if (!width || !height) return 0;
    const portrait = window.matchMedia("(orientation: portrait)").matches || window.innerHeight >= window.innerWidth;
    return portrait ? Math.max(width, height) : Math.min(width, height);
  }

  function clear() {
    delete root.dataset.orchLegacyIosWebapp;
    root.style.removeProperty("--orch-legacy-ios-webapp-height");
  }

  function update() {
    const major = platformMajorVersion();
    if (!isIOS || !standalone() || major <= 0 || major >= 27) {
      clear();
      return;
    }

    const appHeight = Math.round(Math.max(window.innerHeight || 0, root.clientHeight || 0));
    const screenHeight = screenBlockSize();
    const missing = screenHeight - appHeight;
    if (appHeight <= 0 || screenHeight <= 0 || missing <= 0 || missing > Math.max(160, screenHeight * 0.18)) {
      clear();
      return;
    }

    root.dataset.orchLegacyIosWebapp = "true";
    root.style.setProperty("--orch-legacy-ios-webapp-height", screenHeight + "px");
  }

  update();
  window.addEventListener("resize", update, { passive: true });
  window.addEventListener("orientationchange", update, { passive: true });
  window.addEventListener("pageshow", update, { passive: true });
})();
`

export function LegacyIosViewportScript() {
  return (
    <script
      id="orch-legacy-ios-viewport"
      dangerouslySetInnerHTML={{ __html: LEGACY_IOS_VIEWPORT_SCRIPT }}
    />
  )
}
