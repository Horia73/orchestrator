"use client"

import * as React from "react"
import { HtmlSandboxRenderer, type SandboxMode } from "./html-sandbox-renderer"

/**
 * Sandboxed React artifact.
 *
 * We build a self-contained HTML page that:
 *   - Loads React + ReactDOM from esm.sh via an import map
 *   - Loads a small handful of commonly-used libraries the same way
 *     (lucide-react, recharts — extend as artifacts demand)
 *   - Loads @babel/standalone from a CDN so we can JSX-compile at runtime
 *   - Wraps the model's source in `import React from 'react'` etc., compiles,
 *     and mounts the default export as the app root
 *
 * Everything runs in the same sandboxed iframe as plain HTML artifacts,
 * with `allow-scripts` and NO `allow-same-origin`. The artifact can't touch
 * our cookies, our DOM, or our localStorage — its own document is an opaque
 * origin.
 *
 * Errors during compile/render surface inside the iframe as a styled message
 * (instead of a silent blank), which is what the artifact author needs to
 * iterate on the code.
 */

// Pin versions explicitly — esm.sh "@latest" can flip and break artifacts
// retroactively. Bump intentionally when we want new features.
const ESM_HOST = 'https://esm.sh'
const REACT_VERSION = '19.0.0'
const BABEL_VERSION = '7.26.4'

const IMPORT_MAP = {
    imports: {
        'react': `${ESM_HOST}/react@${REACT_VERSION}`,
        'react/jsx-runtime': `${ESM_HOST}/react@${REACT_VERSION}/jsx-runtime`,
        'react-dom': `${ESM_HOST}/react-dom@${REACT_VERSION}`,
        'react-dom/client': `${ESM_HOST}/react-dom@${REACT_VERSION}/client`,
        'lucide-react': `${ESM_HOST}/lucide-react?bundle&deps=react@${REACT_VERSION}`,
        'recharts': `${ESM_HOST}/recharts?bundle&deps=react@${REACT_VERSION}`,
    },
}

function buildShell(source: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>artifact</title>
<!--
  Tailwind Play CDN. Models often reach for utility classes (\`min-h-screen\`,
  \`bg-gradient-to-br\`, \`text-purple-600\`...) without explicit imports. We
  mirror that here so React artifacts authored for this runtime render the same
  in our iframe. The Play CDN observes the DOM for new classes, so React
  components that mount after this script loads still pick up the styles.
-->
<script src="https://cdn.tailwindcss.com"></script>
<style>
    /* Body has no padding so a model's full-bleed root reaches every edge of
       the iframe. Keep the default background transparent so inline artifacts
       can sit naturally in the chat unless the artifact paints its own page. */
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: transparent; color: #0a0a0a; }
    .__orch-error { margin: 16px; padding: 12px 14px; border: 1px solid #fda4af; background: #fff1f2; border-radius: 8px; color: #be123c; font-size: 13px; }
    .__orch-error pre { margin: 6px 0 0; font-size: 11px; white-space: pre-wrap; }
</style>
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
<script src="https://unpkg.com/@babel/standalone@${BABEL_VERSION}/babel.min.js"></script>
</head>
<body>
<div id="root"></div>
<script id="user-source" type="text/babel-source">${escapeForScript(source)}</script>
<script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'

function renderError(message, stack) {
    const root = document.getElementById('root')
    root.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = '__orch-error'
    wrap.innerHTML = '<strong>Artifact failed:</strong> ' + escapeHtml(message) + (stack ? '<pre>' + escapeHtml(stack) + '</pre>' : '')
    root.appendChild(wrap)
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

try {
    const src = document.getElementById('user-source').textContent
    // Compile JSX → JS via Babel standalone. Targets ES modules so import
    // statements inside the artifact go through the import map.
    const compiled = Babel.transform(src, {
        presets: [['react', { runtime: 'automatic' }], 'typescript'],
        filename: 'artifact.tsx',
    }).code
    // Babel emits CommonJS by default — wrap as an es module by wiring up
    // exports manually. We dynamically import a blob URL of the compiled
    // module so we can read its default export.
    // Easier path: wrap in an immediately-evaluated function that returns
    // module.exports / default — but JSX uses imports. So use blob URL.
    const blob = new Blob([compiled], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    const mod = await import(url)
    const App = mod.default
    if (typeof App !== 'function' && (typeof App !== 'object' || App === null)) {
        renderError('Artifact must export a default React component.')
    } else {
        createRoot(document.getElementById('root')).render(React.createElement(App))
    }
} catch (err) {
    renderError(err && err.message ? err.message : String(err), err && err.stack)
}
</script>
</body>
</html>`
}

function escapeForScript(s: string): string {
    // Inside <script type="text/babel-source"> we just need to break the
    // closing tag of the parent script so it doesn't terminate early.
    return s.replace(/<\/script>/gi, '<\\/script>')
}

export function ReactSandboxRenderer({
    source,
    title,
    className,
    mode = 'bounded',
    minHeight,
    maxHeight,
    artifactId,
}: {
    source: string
    title: string
    className?: string
    mode?: SandboxMode
    minHeight?: number
    maxHeight?: number
    /** Stable artifact UUID — enables the AppHost data bridge for registered apps. */
    artifactId?: string
}) {
    const html = React.useMemo(() => buildShell(source), [source])
    return (
        <HtmlSandboxRenderer
            source={html}
            title={title}
            className={className}
            mode={mode}
            minHeight={minHeight}
            maxHeight={maxHeight}
            artifactId={artifactId}
        />
    )
}
