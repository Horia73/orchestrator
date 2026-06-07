import { NextResponse } from 'next/server';
import { guardSensitiveRequest } from '@/lib/api/request-guard';
import { getRuntimeConfig, updateConfig } from '@/lib/config';
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request);
        if (guard) return guard;

        try {
            const config = getRuntimeConfig();
            return NextResponse.json(config);
        } catch (error) {
            console.error("Failed to fetch config", error);
            return NextResponse.json({ error: "Failed to fetch config" }, { status: 500 });
        }
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
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
  })
}
