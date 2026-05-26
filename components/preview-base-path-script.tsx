const PREVIEW_BASE_PATH_SCRIPT = `
(() => {
  if (typeof window === "undefined") return;

  const match = window.location.pathname.match(/^\\/dev-preview\\/[^/?#]+/);
  if (!match) return;

  const basePath = match[0];
  const flag = "__orchestratorPreviewBasePathPatched";
  if (window[flag] === basePath) return;
  window[flag] = basePath;

  function shouldPrefix(value) {
    return (
      typeof value === "string" &&
      value.startsWith("/") &&
      !value.startsWith("//") &&
      value !== basePath &&
      !value.startsWith(basePath + "/")
    );
  }

  function prefixPath(value) {
    return shouldPrefix(value) ? basePath + value : value;
  }

  function prefixUrl(value) {
    if (typeof value === "string") return prefixPath(value);
    if (typeof URL !== "undefined" && value instanceof URL && value.origin === window.location.origin) {
      const next = new URL(value.toString());
      next.pathname = prefixPath(next.pathname);
      return next;
    }
    return value;
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function(input, init) {
      if (typeof input === "string" || (typeof URL !== "undefined" && input instanceof URL)) {
        return originalFetch.call(this, prefixUrl(input), init);
      }
      if (typeof Request !== "undefined" && input instanceof Request) {
        const requestUrl = new URL(input.url, window.location.href);
        if (requestUrl.origin === window.location.origin && shouldPrefix(requestUrl.pathname)) {
          requestUrl.pathname = prefixPath(requestUrl.pathname);
          return originalFetch.call(this, new Request(requestUrl.toString(), input), init);
        }
      }
      return originalFetch.call(this, input, init);
    };
  }

  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === "function") {
    const PatchedEventSource = function(url, eventSourceInitDict) {
      return new OriginalEventSource(prefixUrl(String(url)), eventSourceInitDict);
    };
    PatchedEventSource.prototype = OriginalEventSource.prototype;
    PatchedEventSource.CONNECTING = OriginalEventSource.CONNECTING;
    PatchedEventSource.OPEN = OriginalEventSource.OPEN;
    PatchedEventSource.CLOSED = OriginalEventSource.CLOSED;
    window.EventSource = PatchedEventSource;
  }

  if (typeof XMLHttpRequest !== "undefined") {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
      return originalOpen.call(this, method, prefixUrl(url), async, user, password);
    };
  }

  for (const method of ["pushState", "replaceState"]) {
    const original = window.history && window.history[method];
    if (typeof original !== "function") continue;
    window.history[method] = function(state, title, url) {
      return original.call(this, state, title, url == null ? url : prefixUrl(url));
    };
  }
})();
`

export function PreviewBasePathScript() {
  return (
    <script
      id="orchestrator-preview-base-path"
      dangerouslySetInnerHTML={{ __html: PREVIEW_BASE_PATH_SCRIPT }}
    />
  )
}
