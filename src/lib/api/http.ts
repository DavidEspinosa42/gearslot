import { unstable_rethrow } from "next/navigation";
import { type ProblemCode, problem, type ServiceResult } from "../reservations/result";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const isProblem = status >= 400;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": isProblem ? "application/problem+json" : "application/json",
      ...NO_STORE,
      ...headers,
    },
  });
}

export function problemResponse(
  status: number,
  code: ProblemCode,
  title: string,
  extra: Record<string, unknown> = {},
): Response {
  const built = problem(status, code, title, extra);
  return jsonResponse(built.status, built.body);
}

/** A stored or fresh service outcome as an HTTP response. Replays are flagged in a header. */
export function serviceResponse(result: ServiceResult): Response {
  return jsonResponse(
    result.status,
    result.body,
    result.replayed ? { "Idempotent-Replayed": "true" } : {},
  );
}

export function unauthorized(): Response {
  return problemResponse(401, "unauthorized", "Sign in through the institution's SSO to continue.");
}

/** Runs a handler and turns anything unexpected into a generic 500 that leaks no internals. */
export async function guarded(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    // Next signals "this route is dynamic" (reading headers during prerender) and similar framework
    // control flow by throwing. Swallowing those would turn a request-time route into a static 500.
    unstable_rethrow(error);
    console.error("unhandled api error:", error instanceof Error ? error.message : "unknown");
    return problemResponse(500, "internal", "Something went wrong on our side.");
  }
}
