import { api } from "../../lib/client";
import type { Material, Question } from "../../lib/types";
import { edgeCall } from "./supabase";
import { runPreparedJob } from "./content-runner";

const standard = (action: string, body: Record<string, unknown>) =>
  edgeCall("content-jobs", { action, ...body });

/** Registration initiates generation once; revisits read the saved result. */
export async function prepareWrongAnalysis(
  question: Question,
  material: Material,
  options: {
    onUpdate: (job: any) => void;
    shouldStop: () => boolean;
  },
) {
  const saved = await api(`questions/${question.id}/review`);
  if (saved.hasSavedAnalysis) return { saved, reused: true };
  if (
    !question.regions.length ||
    !(question as Question & { imagePaths?: string[] }).imagePaths?.length
  )
    throw new Error(
      `${question.number}번의 저장된 원본 크롭이 없습니다. 문항 영역을 먼저 저장해 주세요.`,
    );
  const result = await standard("list", { documentId: question.materialId });
  const existing = (result.jobs || []).find(
    (job: any) =>
      job.taskType === "problem" &&
      job.method === "api" &&
      job.targetQuestions?.length === 1 &&
      job.targetQuestions[0].id === question.id,
  );
  if (options.shouldStop()) return { stopped: true };
  let job = existing
    ? await standard("get", { jobId: existing.id })
    : await standard("create", {
        documentId: question.materialId,
        taskType: "problem",
        method: "api",
        questionIds: [question.id],
        selectedPages: [
          ...new Set(question.regions.map((region) => region.page)),
        ],
        tocPages: material.tocPages || [],
        questionCount: 5,
        purposeCounts: { concept: 3, practice: 2, similar: 0 },
        questionTypes: ["mcq", "ox", "short", "blank"],
        difficultyDistribution: { easy: 20, medium: 60, hard: 20 },
      });
  options.onUpdate(job);
  job = await runPreparedJob(job, options);
  const analysis = await api(`questions/${question.id}/review`);
  if (!analysis.hasSavedAnalysis && !options.shouldStop())
    throw new Error(
      "분석을 완료하지 못했습니다. 완료된 결과는 보관했으며 준비 도구에서 오류를 확인하고 이어서 실행할 수 있습니다.",
    );
  return { job, saved: analysis };
}
