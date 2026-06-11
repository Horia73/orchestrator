export function buildMapIframeCss(heightCss: string): string {
  return `
    *, *::before, *::after { box-sizing: border-box; }
    html, body { width: 100%; height: ${heightCss}; margin: 0; padding: 0; overflow: hidden; background: #f1f5f9; }
    body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif; color: #0f172a; }
    #map, #earth-map { position: absolute; inset: 0; width: 100%; height: ${heightCss}; }
    #map {
        z-index: 1;
        opacity: 1;
        transition: opacity 280ms ease;
    }
    #earth-map {
        z-index: 2;
        display: none;
        background: #f1f5f9;
        opacity: 0;
        pointer-events: none;
        transition: opacity 280ms ease;
    }
    body.is-earth3d #earth-map { display: block; }
    /* visibility (not just opacity) so the compositor can skip the 2D map's
       WebGL surface entirely while 3D owns the screen; the transition delay
       keeps the crossfade intact. Removing the class flips visibility back
       instantly because the delay only lives on this rule. */
    body.is-earth3d.earth3d-ready #map {
        opacity: 0;
        visibility: hidden;
        transition: opacity 280ms ease, visibility 0s linear 320ms;
    }
    body.is-earth3d.earth3d-ready #earth-map {
        opacity: 1;
        pointer-events: auto;
    }
    body.is-earth3d.earth3d-fading-out #map { opacity: 1; }
    body.is-earth3d.earth3d-fading-out #earth-map { opacity: 0; }
    #earth-loading {
        position: absolute;
        left: 50%;
        top: 50%;
        z-index: 4;
        display: none;
        align-items: center;
        gap: 9px;
        transform: translate(-50%, -50%);
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.32);
        background: rgba(248, 250, 252, 0.94);
        color: #334155;
        padding: 10px 14px;
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
        box-shadow: 0 12px 34px rgba(15, 23, 42, 0.16);
        backdrop-filter: blur(10px);
        pointer-events: none;
    }
    body.is-earth3d:not(.earth3d-ready) #earth-loading { display: flex; }
    #earth-loading[aria-hidden="true"] { display: none !important; }
    .earth-loading-spinner {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid rgba(148, 163, 184, 0.36);
        border-top-color: #0f172a;
        animation: earthLoadingSpin 800ms linear infinite;
    }
    @keyframes earthLoadingSpin {
        to { transform: rotate(360deg); }
    }

    /* Marker = numbered colored dot. Small, clean, identical visual
       language to Google's place dots — just with our colour + number. */
    .orch-dot {
        position: relative;
        display: flex; align-items: center; justify-content: center;
        width: 32px; height: 32px;
        border-radius: 50%;
        color: #fff;
        font: 700 14px/1 -apple-system, BlinkMacSystemFont, sans-serif;
        border: 3px solid #fff;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(0, 0, 0, 0.15);
        cursor: pointer;
        transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.18s ease;
        user-select: none;
        letter-spacing: -0.02em;
    }
    .orch-dot:hover { transform: scale(1.15); }
    .orch-dot.is-active {
        transform: scale(1.35);
        z-index: 100;
        box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.98), 0 6px 16px rgba(0, 0, 0, 0.5);
    }
    .orch-search-pin {
        position: relative;
        width: 30px; height: 30px;
        border-radius: 50% 50% 50% 4px;
        background: #ea4335;
        border: 3px solid #fff;
        box-shadow: 0 3px 12px rgba(0, 0, 0, 0.38), 0 0 0 1px rgba(0, 0, 0, 0.18);
        transform: rotate(-45deg);
        cursor: pointer;
    }
    .orch-search-pin::after {
        content: "";
        position: absolute;
        inset: 7px;
        border-radius: 50%;
        background: #fff;
    }
    .orch-selected-point {
        width: 14px; height: 14px;
        border-radius: 50%;
        background: #fff;
        border: 3px solid #d93025;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.34), 0 0 0 2px rgba(255, 255, 255, 0.82);
        cursor: pointer;
    }
    .orch-earth-selected-pin {
        position: relative;
        width: 30px; height: 30px;
        border-radius: 50% 50% 50% 5px;
        background: #d93025;
        border: 3px solid #fff;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.46), 0 0 0 1px rgba(0, 0, 0, 0.2);
        transform: rotate(-45deg);
        cursor: pointer;
    }
    .orch-earth-selected-pin::after {
        content: "";
        position: absolute;
        inset: 7px;
        border-radius: 50%;
        background: #fff;
    }
    .orch-map-toast {
        position: absolute;
        left: 50%;
        bottom: 18px;
        z-index: 5;
        transform: translateX(-50%);
        max-width: min(420px, calc(100% - 32px));
        border-radius: 999px;
        background: rgba(32, 33, 36, 0.92);
        color: #fff;
        padding: 9px 14px;
        font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
        box-shadow: 0 6px 22px rgba(0, 0, 0, 0.28);
        pointer-events: none;
    }
    .orch-draw-panel {
        position: absolute;
        left: 50%;
        bottom: 18px;
        z-index: 6;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        max-width: min(560px, calc(100% - 28px));
        transform: translateX(-50%);
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.24);
        background: rgba(32, 33, 36, 0.94);
        color: #fff;
        padding: 7px;
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.32);
        backdrop-filter: blur(10px);
        font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
    }
    .orch-draw-panel span {
        min-width: 0;
        padding: 0 6px 0 8px;
        white-space: normal;
        line-height: 1.25;
    }
    .orch-draw-panel button {
        height: 28px;
        border: 0;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.14);
        color: #fff;
        padding: 0 10px;
        font: 700 12px/1 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
        cursor: pointer;
    }
    .orch-draw-panel button:hover { background: rgba(255, 255, 255, 0.22); }
    .orch-draw-panel button:disabled {
        cursor: not-allowed;
        opacity: 0.45;
    }

    /* InfoWindow restyle — used only for lightweight route/polygon labels. */
    .gm-style-iw.gm-style-iw-c {
        padding: 0 !important;
        border-radius: 12px !important;
        max-width: 340px !important;
        max-height: 420px !important;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08) !important;
    }
    /* Scroll body when content overflows */
    .gm-style-iw-d {
        overflow: auto !important;
        padding: 0 !important;
        max-height: 380px !important;
    }
    /* Close button — match Google's POI card X */
    .gm-style-iw-chr {
        position: absolute !important;
        top: 6px !important; right: 6px !important;
        z-index: 2;
    }
    button.gm-ui-hover-effect {
        background: rgba(255, 255, 255, 0.94) !important;
        border-radius: 50% !important;
        width: 28px !important; height: 28px !important;
        opacity: 1 !important;
        backdrop-filter: blur(6px);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    }
    button.gm-ui-hover-effect > span {
        margin: 6px !important;
        width: 14px !important; height: 14px !important;
        background-color: #3c4043 !important;
    }
    /* Hide the default white tail/triangle so the card reads as a
       standalone sheet rather than a tooltip. */
    .gm-style .gm-style-iw-tc { display: none !important; }

    .orch-iw {
        width: 320px;
        font: 14px/1.4 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #202124;
    }
    .orch-iw-photo {
        display: block;
        width: 100%;
        height: 180px;
        object-fit: cover;
        background: #f1f3f4;
    }
    .orch-iw-body { padding: 16px 16px 14px; }
    .orch-iw-title {
        font: 500 18px/1.3 inherit;
        color: #202124;
        margin: 0 0 6px;
        letter-spacing: -0.01em;
    }
    .orch-iw-rating {
        display: flex; align-items: center; gap: 4px;
        margin: 0 0 10px;
        font: 13px/1 inherit;
        color: #3c4043;
    }
    .orch-iw-rating-num { font-weight: 500; }
    .orch-iw-stars { display: inline-flex; gap: 1px; font-size: 12px; }
    .orch-iw-star { color: #dadce0; }
    .orch-iw-star.is-full { color: #f9ab00; }
    .orch-iw-star.is-half {
        background: linear-gradient(90deg, #f9ab00 50%, #dadce0 50%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
    }
    .orch-iw-row {
        display: flex; align-items: flex-start; gap: 10px;
        margin: 8px 0;
        font: 13px/1.45 inherit;
        color: #5f6368;
    }
    .orch-iw-row-icon {
        width: 16px; height: 16px;
        flex-shrink: 0;
        margin-top: 2px;
        color: #5f6368;
    }
    .orch-iw-desc {
        font: 13.5px/1.5 inherit;
        color: #3c4043;
        margin: 10px 0 12px;
    }
    .orch-iw-link {
        display: inline-flex;
        align-items: center;
        font: 500 13px/1 inherit;
        color: #1a73e8;
        text-decoration: none;
        padding: 6px 0;
    }
    .orch-iw-link:hover { text-decoration: underline; }

    .orch-iframe-error {
        position: absolute; inset: 16px;
        background: #fef2f2; color: #b91c1c;
        border: 1px solid #fecaca; border-radius: 12px;
        padding: 14px 16px; font: 13px/1.45 -apple-system, sans-serif;
    }
    .orch-iframe-error b { display: block; font-weight: 600; margin-bottom: 4px; }
    `
}
