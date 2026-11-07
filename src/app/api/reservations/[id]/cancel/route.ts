import { guarded, problemResponse, serviceResponse, unauthorized } from "@/lib/api/http";
import { identify } from "@/lib/api/identity";
import { readIdempotencyKey, uuidSchema } from "@/lib/api/schemas";
import { getDb } from "@/lib/db/server";
import { cancelReservation } from "@/lib/reservations/service";

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

    const result = await cancelReservation(getDb(), {
      actor,
      idempotencyKey,
      reservationId: reservationId.data,
      now: new Date(),
    });
    return serviceResponse(result);
  });
}
