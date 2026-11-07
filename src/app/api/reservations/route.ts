import {
  guarded,
  jsonResponse,
  problemResponse,
  serviceResponse,
  unauthorized,
} from "@/lib/api/http";
import { identify } from "@/lib/api/identity";
import { createBodySchema, readIdempotencyKey } from "@/lib/api/schemas";
import { getDb } from "@/lib/db/server";
import { createReservation, listMyReservations } from "@/lib/reservations/service";

export function GET(request: Request): Promise<Response> {
  return guarded(async () => {
    const actor = identify(request);
    if (actor === undefined) return unauthorized();
    const reservations = await listMyReservations(getDb(), actor.userId, new Date());
    return jsonResponse(200, { reservations });
  });
}

export function POST(request: Request): Promise<Response> {
  return guarded(async () => {
    const actor = identify(request);
    if (actor === undefined) return unauthorized();

    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey === undefined) {
      return problemResponse(
        400,
        "missing_idempotency_key",
        "Send an Idempotency-Key header (8-128 URL-safe characters, for example a UUID).",
      );
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return problemResponse(400, "invalid_request", "The request body must be valid JSON.");
    }
    const body = createBodySchema.safeParse(raw);
    if (!body.success) {
      return problemResponse(400, "invalid_request", "The request body is not valid.", {
        issues: body.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const result = await createReservation(getDb(), {
      actor,
      idempotencyKey,
      resourceId: body.data.resourceId,
      startsAt: body.data.startsAt,
      endsAt: body.data.endsAt,
      now: new Date(),
    });
    return serviceResponse(result);
  });
}
