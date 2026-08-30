import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isUniqueViolation } from "./slug";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what = "Resource") =>
  new ApiError(404, `${what} not found`);

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
}

/**
 * Wraps a route handler so every failure leaves through one place with a
 * consistent `{ error, details? }` shape instead of a stack trace.
 */
export function handle<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: error.message, ...(error.details ? { details: error.details } : {}) },
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Validation failed", details: formatZodError(error) },
      { status: 422 },
    );
  }

  if (isUniqueViolation(error)) {
    return NextResponse.json(
      { error: "That slug is already taken" },
      { status: 409 },
    );
  }

  console.error("Unhandled API error:", error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

function formatZodError(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (details[key] ??= []).push(issue.message);
  }
  return details;
}
