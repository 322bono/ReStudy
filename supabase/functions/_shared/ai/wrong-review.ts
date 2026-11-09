import { row, rows, type Ctx } from "../app/repository.ts";
import { AiError, checked, readProfile } from "./credentials.ts";
import { encode64 } from "./crypto.ts";
import { cacheKey, edgeBackgroundTask, processJob, validId } from "./jobs.ts";
import { providerContext, storeFor } from "./service.ts";
import { sanitizeSettings } from "./settings.ts";
import type { TaskInput } from "./router.ts";
import { wrongReviewPrompt } from "./schemas.ts";
import { wrongReviewIssues } from '../../../../src/domain/answer-quality.ts';

export async function startWrongReview(ctx: Ctx, problemId: unknown, master: string) {
  if (!validId(problemId)) throw new AiError("invalid_request");
  const problem = await row(ctx, "problems", problemId);
  const document = await row(ctx, "documents", problem.document_id);
  if (document.data.archived || problem.data.mergedInto || problem.data.autoRetired)
    throw new AiError("source_not_found", 404);
  const needsRepair = wrongReviewIssues(problem.data.wrongReview).length > 0;
  if (!needsRepair && (problem.data.wrongReview || problem.data.analysis || problem.data.answer || problem.data.explanation))
    return { status: "completed", cached: true };

  const key = await cacheKey({ kind: "wrong_review.v2-crosscheck", problemId, version: problem.updated_at });
  const findJob = () => ctx.admin.from("ai_jobs").select("*").eq("user_id", ctx.user.id).eq("cache_key", key);
  let job = checked(await findJob().maybeSingle());
  const settings = sanitizeSettings((await readProfile(ctx)).ai_settings);
  if (!job) {
    const parts = (await rows(ctx, "problem_regions", { problem_id: problemId })).sort((a, b) => a.part - b.part);
    if (!parts.length || (problem.data.regions?.length && parts.length !== problem.data.regions.length))
      throw new AiError("saved_crop_missing");
    if (parts.length > 6) throw new AiError("saved_crop_too_large");
    const images = [];
    let bytes = 0;
    for (const part of parts) {
      const path = part.image_path;
      if (typeof path !== "string" || !path.startsWith(`${ctx.user.id}/${document.id}/`) || path.includes(".."))
        throw new AiError("invalid_saved_crop");
      const { data, error } = await ctx.db.storage.from("study-files").download(path);
      if (error || !data) throw new AiError("saved_crop_missing");
      bytes += data.size;
      if (bytes > 3_000_000) throw new AiError("saved_crop_too_large");
      images.push({ mimeType: "image/png", data: encode64(new Uint8Array(await data.arrayBuffer())) });
    }
    const input: TaskInput = {
      kind: "wrong_review", sourceIds: [problemId], images,
      prompt: wrongReviewPrompt,
    };
    const inserted = await ctx.admin.from("ai_jobs").insert({
      user_id: ctx.user.id, document_id: document.id, problem_id: problemId,
      kind: input.kind, status: "waiting", cache_key: key,
      data: { input, settings, problemVersion: problem.updated_at, ...(needsRepair ? { previousReview: problem.data.wrongReview } : {}) },
    }).select("*").single();
    job = inserted.error?.code === "23505" ? checked(await findJob().single()) : checked(inserted);
  }
  if (job.status === "completed") return { id: job.id, status: job.status };
  if (job.status === "running" && Date.parse(job.lease_until ?? "") > Date.now()) return { id: job.id, status: job.status };
  if (["paused", "failed", "retry_wait"].includes(job.status) && Date.parse(job.available_at) <= Date.now()) {
    job = checked(await ctx.admin.from("ai_jobs").update({ status: "waiting", attempts: 0, data: { ...job.data, settings } })
      .eq("id", job.id).eq("user_id", ctx.user.id).eq("updated_at", job.updated_at).in("status", ["paused", "failed", "retry_wait"])
      .select("*").maybeSingle()) ?? checked(await findJob().single());
  }
  if (["paused", "failed", "retry_wait"].includes(job.status))
    return { id: job.id, status: job.status, available_at: job.available_at, last_error: job.data.last_provider_error ?? job.data.last_error };
  const routing = await providerContext(ctx, job.id, settings, master, job.data.input);
  return processJob(job, storeFor(ctx), routing, undefined, edgeBackgroundTask());
}
