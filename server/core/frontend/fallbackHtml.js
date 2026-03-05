export function renderMissingFrontendHtml() {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Orchestrator build missing</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0f172a;
        color: #e2e8f0;
        font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(640px, calc(100vw - 48px));
        padding: 32px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 20px;
        background: rgba(15, 23, 42, 0.88);
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.45);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
      }
      p {
        margin: 0 0 12px;
      }
      code {
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(148, 163, 184, 0.12);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Frontend build missing</h1>
      <p>Build the Vite app before opening Orchestrator in production mode.</p>
      <p>Run <code>npm run build</code> and restart the server, or use <code>npm run setup</code> for first-time onboarding.</p>
    </main>
  </body>
</html>`;
}
