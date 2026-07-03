import { timingSafeEqual } from 'crypto'

/**
 * Auth pentru API-ul „AI Provider" consumat de AgenticWeb OS (dashboard-ul de
 * pe Vercel). Un singur secret partajat, trimis ca `Authorization: Bearer …`.
 *
 * Fără `AGENTICWEB_PROVIDER_SECRET` în env, namespace-ul e dezactivat complet
 * (503) — instanțele care nu servesc AgenticWeb nu expun nimic nou.
 */
export function checkProviderAuth(req: Request): { ok: true } | { ok: false; response: Response } {
    const secret = process.env.AGENTICWEB_PROVIDER_SECRET?.trim()
    if (!secret) {
        return {
            ok: false,
            response: Response.json(
                { error: 'AI Provider dezactivat: AGENTICWEB_PROVIDER_SECRET lipsește din env.' },
                { status: 503 },
            ),
        }
    }

    const header = req.headers.get('authorization') ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    if (presented && safeEqual(presented, secret)) return { ok: true }

    return {
        ok: false,
        response: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    }
}

function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
}
