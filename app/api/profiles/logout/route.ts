import { logoutProfileFromRequest } from "@/lib/profiles/server"

export async function POST(request: Request) {
  return logoutProfileFromRequest(request)
}
