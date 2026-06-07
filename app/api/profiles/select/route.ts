import { selectProfileFromBody } from "@/lib/profiles/server"

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  return selectProfileFromBody(request, body).response
}
