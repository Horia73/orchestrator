import { NextResponse } from "next/server"

import { getVapidPublicKey } from "@/lib/push-notifications"

export const runtime = "nodejs"

export async function GET() {
  try {
    return NextResponse.json(
      { publicKey: getVapidPublicKey() },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    console.error("Failed to read VAPID public key", error)
    return NextResponse.json(
      { error: "Failed to read push configuration" },
      { status: 500 }
    )
  }
}
