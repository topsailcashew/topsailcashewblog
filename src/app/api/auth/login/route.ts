import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionSecret } from "@/lib/auth";
import { ApiError, handle, readJsonBody } from "@/lib/http";
import {
  SESSION_TTL_SECONDS,
  createSessionToken,
  secretsMatch,
  sessionCookieOptions,
} from "@/lib/session";

export const dynamic = "force-dynamic";

const loginSchema = z.object({ password: z.string().min(1, "Password is required") });

/** Slows down guessing a little without keeping state a Worker cannot hold. */
const FAILED_ATTEMPT_DELAY_MS = 400;

/** POST /api/auth/login — exchanges the admin password for a session cookie. */
export const POST = handle(async (request: NextRequest) => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const secret = getSessionSecret();

  if (!adminPassword || !secret) {
    // Fail closed and say which one is missing — this only ever bites in setup.
    const missing = [
      !adminPassword ? "ADMIN_PASSWORD" : null,
      !secret ? "SESSION_SECRET" : null,
    ].filter(Boolean);
    throw new ApiError(500, `Server is missing ${missing.join(" and ")}`);
  }

  const { password } = loginSchema.parse(await readJsonBody(request));

  if (!(await secretsMatch(password, adminPassword))) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_ATTEMPT_DELAY_MS));
    throw new ApiError(401, "Incorrect password");
  }

  const token = await createSessionToken(secret);
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    ...sessionCookieOptions(request, SESSION_TTL_SECONDS),
    value: token,
  });
  return response;
});
