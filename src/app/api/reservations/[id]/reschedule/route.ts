import { guarded, problemResponse, serviceResponse, unauthorized } from "@/lib/api/http";
import { identify } from "@/lib/api/identity";
import { readIdempotencyKey, rescheduleBodySchema, uuidSchema } from "@/lib/api/schemas";
import { getDb } from "@/lib/db/server";
import { rescheduleReservation } from "@/lib/reservations/service";

export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
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

    const { id } = await context.params;
    const reservationId = uuidSchema.safeParse(id);
    if (!reservationId.success) {
      return problemResponse(404, "reservation_not_found", "No such reservation.");
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return problemResponse(400, "invalid_request", "The request body must be valid JSON.");
    }
    const body = rescheduleBodySchema.safeParse(raw);
    if (!body.success) {
      return problemResponse(400, "invalid_request", "The request body is not valid.", {
        issues: body.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const result = await rescheduleReservation(getDb(), {
      actor,
      idempotencyKey,
      reservationId: reservationId.data,
      startsAt: body.data.startsAt,
      endsAt: body.data.endsAt,
      now: new Date(),
    });
    return serviceResponse(result);
  });
}
