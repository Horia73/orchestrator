import { NextResponse } from 'next/server'

import { resolveRequestOrigin } from '@/lib/app-origin'
import { completeGmailOAuth } from '@/lib/integrations/gmail'
import { completeGoogleCalendarOAuth } from '@/lib/integrations/google-calendar'
import { completeGoogleDriveOAuth } from '@/lib/integrations/google-drive'
import {
    getGoogleOAuthCallbackStateProvider,
    type GoogleOAuthCallbackProvider,
} from '@/lib/integrations/google-oauth-callback'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const origin = resolveRequestOrigin(request)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const oauthError = url.searchParams.get('error')
        const stateProvider = getGoogleOAuthCallbackStateProvider(state)
        const fallbackProvider = stateProvider ?? 'googleCalendar'
        const fallbackLabel = providerLabel(fallbackProvider)

        if (oauthError) {
            return htmlResponse(renderCallbackPage({
                provider: fallbackProvider,
                ok: false,
                title: `${fallbackLabel} authorization was cancelled`,
                message: url.searchParams.get('error_description') || oauthError,
            }))
        }

        if (!code || !state) {
            return htmlResponse(renderCallbackPage({
                provider: fallbackProvider,
                ok: false,
                title: `${fallbackLabel} authorization failed`,
                message: 'Google did not return the expected authorization code and state.',
            }))
        }

        const provider = stateProvider
        if (!provider) {
            return htmlResponse(renderCallbackPage({
                provider: 'google',
                ok: false,
                title: 'Google authorization failed',
                message: 'OAuth state is missing or expired. Start Google login again.',
            }))
        }

        try {
            const result = provider === 'gmail'
                ? await completeGmailOAuth({ origin, code, state })
                : provider === 'googleDrive'
                    ? await completeGoogleDriveOAuth({ origin, code, state })
                    : await completeGoogleCalendarOAuth({ origin, code, state })
            const label = providerLabel(provider)
            return htmlResponse(renderCallbackPage({
                provider,
                ok: true,
                title: `${label} connected`,
                message: result.accountEmail ? `Connected ${result.accountEmail}.` : `${label} is connected.`,
            }))
        } catch (err) {
            const label = providerLabel(provider)
            return htmlResponse(renderCallbackPage({
                provider,
                ok: false,
                title: `${label} authorization failed`,
                message: err instanceof Error ? err.message : `Could not complete ${label} OAuth.`,
            }))
        }
  })
}

function providerLabel(provider: GoogleOAuthCallbackProvider): string {
    if (provider === 'gmail') return 'Gmail'
    return provider === 'googleDrive' ? 'Google Drive' : 'Google Calendar'
}

function htmlResponse(html: string): NextResponse {
    return new NextResponse(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    })
}

function renderCallbackPage(args: { provider: string; ok: boolean; title: string; message: string }): string {
    const payload = JSON.stringify({
        type: 'orchestrator:integration-auth',
        provider: args.provider,
        ok: args.ok,
        message: args.message,
    })
    const title = escapeHtml(args.title)
    const message = escapeHtml(args.message)
    const tone = args.ok ? '#047857' : '#b91c1c'

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #fafafa;
      color: #18181b;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      border: 1px solid #e4e4e7;
      border-radius: 14px;
      background: white;
      padding: 22px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 18px;
      line-height: 1.25;
      color: ${tone};
    }
    p {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: #52525b;
    }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
  <script>
    const payload = ${payload};
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
      window.setTimeout(() => window.close(), 500);
    }
  </script>
</body>
</html>`
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}
