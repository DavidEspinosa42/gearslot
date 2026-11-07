import { guarded, jsonResponse, unauthorized } from "@/lib/api/http";
import { identify } from "@/lib/api/identity";

export function GET(request: Request): Promise<Response> {
  return guarded(async () => {
    const actor = identify(request);
    if (actor === undefined) return unauthorized();
    return jsonResponse(200, { userId: actor.userId, displayName: actor.displayName });
  });
}
