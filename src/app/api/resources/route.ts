import { guarded, jsonResponse, unauthorized } from "@/lib/api/http";
import { identify } from "@/lib/api/identity";
import { getDb } from "@/lib/db/server";
import { getLab, listResources } from "@/lib/reservations/service";

export function GET(request: Request): Promise<Response> {
  return guarded(async () => {
    if (identify(request) === undefined) return unauthorized();
    const db = getDb();
    const [lab, resources] = await Promise.all([getLab(db), listResources(db)]);
    return jsonResponse(200, { lab, resources });
  });
}
