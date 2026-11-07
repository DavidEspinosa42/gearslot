import { z } from "zod";
import { MAX_AVAILABILITY_MS } from "../reservations/service";

const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/** Body of `POST /api/reservations`. */
export const createBodySchema = z
  .object({
    resourceId: z.uuid(),
    startsAt: instant,
    endsAt: instant,
  })
  .strict();

/** Body of `POST /api/reservations/{id}/reschedule`. */
export const rescheduleBodySchema = z.object({ startsAt: instant, endsAt: instant }).strict();

/** Query of `GET /api/resources/{id}/availability`. */
export const availabilityQuerySchema = z
  .object({ from: instant, to: instant })
  .refine((q) => q.to > q.from, { message: "`to` must be after `from`" })
  .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_AVAILABILITY_MS, {
    message: "The window can span at most 35 days",
  });

export const uuidSchema = z.uuid();

/** Clients generate one key per attempt; a UUID is what the browser client sends. */
const KEY_PATTERN = /^[A-Za-z0-9._~-]{8,128}$/;

export function readIdempotencyKey(request: Request): string | undefined {
  const value = request.headers.get("idempotency-key");
  return value !== null && KEY_PATTERN.test(value) ? value : undefined;
}
