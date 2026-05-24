import { INLINE_HEIGHT_PX } from "./constants"
import { buildMapIframeCss } from "./iframe-css"
import { INIT_SCRIPT } from "./iframe-runtime"

// ---------------------------------------------------------------------------
// Iframe HTML + the init script that runs inside it.
//
// The init flow:
//   1. Google Maps JS bootstraps via `?callback=__orchBoot`.
//   2. `__orchBoot` posts `ready` back to parent and listens for `init`.
//   3. On `init`, build the map with the artifact's viewport + styles
//      that hide all POIs, transit, and label icons. Drop pins via
//      AdvancedMarker. Wire click → active marker + postMessage out.
// ---------------------------------------------------------------------------

export function buildIframeHtml({
  apiKey,
  mapId,
  mode,
  channelToken,
}: {
  apiKey: string
  mapId: string
  mode: "inline" | "panel"
  channelToken: string
}): string {
  const heightCss = mode === "panel" ? "100vh" : `${INLINE_HEIGHT_PX}px`
  const script = INIT_SCRIPT.replaceAll("__MAP_ID__", JSON.stringify(mapId))
    .replaceAll("__MAP_CHANNEL_TOKEN__", JSON.stringify(channelToken))
    .replaceAll("__API_KEY__", encodeURIComponent(apiKey))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>map</title>
<style>${buildMapIframeCss(heightCss)}</style>
</head>
<body>
<div id="map"></div>
<div id="earth-map" aria-hidden="true"></div>
<div id="earth-loading" aria-hidden="true">
  <span class="earth-loading-spinner"></span>
  <span>Loading 3D imagery...</span>
</div>
${script}
</body>
</html>`
}
