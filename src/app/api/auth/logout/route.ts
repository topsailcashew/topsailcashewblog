import { NextResponse, type NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

/** POST /api/auth/logout — clears the session cookie. Safe to call signed out. */
export const POST = handle(async (request: NextRequest) => {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ ...sessionCookieOptions(request, 0), value: "" });
  return response;
});
