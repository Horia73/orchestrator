/**
 * Safety net: strip a markdown code fence that surrounds the artifact body.
 *
 * Models sometimes wrap React/HTML/code artifact bodies in ```tsx ... ```
 * fences out of habit. That breaks our renderers (the iframe srcdoc would
 * literally contain the backticks). We strip a single leading fence and the
 * matching trailing fence; if the body isn't wrapped, content passes through
 * untouched.
 *
 * Conservative on purpose: only strips when the FIRST non-whitespace token
 * is a fence and the LAST non-whitespace token is a closing fence. We do
 * not try to dewrap nested fences or strip language hints from the middle.
 */
const FENCE_RE = /^(\s*)```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)\n```(\s*)$/

export function stripWrappingCodeFence(body: string): string {
    const m = body.match(FENCE_RE)
    if (!m) return body
    // m[3] is the unwrapped content; rebuild keeping the original leading/
    // trailing whitespace so the renderer's own layout isn't disturbed.
    return `${m[1]}${m[3]}${m[4]}`
}
