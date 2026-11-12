import { AppError, context, errorResponse, json, preflight, readInput } from "../_shared/context.ts";
import { manageMembers } from "../_shared/members.ts";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  try {
    if (req.method !== "POST") throw new AppError("지원하지 않는 요청입니다.", 405);
    const ctx = await context(req);
    if (!ctx.access.administrator) throw new AppError("관리자만 이용할 수 있습니다.", 403);
    return json(await manageMembers(ctx, await readInput(req, 8192)), 200, req);
  } catch (error) {
    return errorResponse(error, req);
  }
});
