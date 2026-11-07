import { guarded, jsonResponse, problemResponse, unauthorized } from "@/lib/api/http";
import { identify } from "@/lib/api/identity";
import { availabilityQuerySchema, uuidSchema } from "@/lib/api/schemas";
import { getDb } from "@/lib/db/server";
import { getAvailability } from "@/lib/reservations/service";

export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return guarded(async () => {
    const actor = identify(request);
    if (actor === undefined) return unauthorized();

    const { id } = await context.params;
    const resourceId = uuidSchema.safeParse(id);
    if (!resourceId.success) {
      return problemResponse(404, "resource_not_found", "No such item.");
    }

    const params = new URL(request.url).searchParams;
    const query = availabilityQuerySchema.safeParse({
      from: params.get("from"),
      to: params.get("to"),
    });
    if (!query.success) {
      return problemResponse(
        422,
        "invalid_window",
        "Give a valid from/to window of at most 35 days.",
        {
          issues: query.error.issues.map((issue) => issue.message),
        },
      );
    }

    const blocks = await getAvailability(getDb(), resourceId.data, query.data, actor.userId);
    if (blocks === undefined) return problemResponse(404, "resource_not_found", "No such item.");
    return jsonResponse(200, { blocks });
  });
}
