import { NextResponse } from 'next/server';
import { guardSensitiveRequest } from '@/lib/api/request-guard';
import { getRuntimeConfig, updateConfig } from '@/lib/config';

export async function GET(request: Request) {
    const guard = guardSensitiveRequest(request);
    if (guard) return guard;

    try {
        const config = getRuntimeConfig();
        void import('@/lib/memory/daily-consolidation-offer').then((mod) =>
            mod.maybeOfferDailyMemoryConsolidation()
        ).catch((err) => console.warn('[memory-offer] background check failed', err))
        return NextResponse.json(config);
    } catch (error) {
        console.error("Failed to fetch config", error);
        return NextResponse.json({ error: "Failed to fetch config" }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const guard = guardSensitiveRequest(request);
    if (guard) return guard;

    try {
        const newConfig = await request.json();
        const updated = updateConfig(newConfig);
        return NextResponse.json({ success: true, config: updated });
    } catch (error) {
        console.error("Failed to update config", error);
        return NextResponse.json({ error: "Failed to update config" }, { status: 500 });
    }
}
