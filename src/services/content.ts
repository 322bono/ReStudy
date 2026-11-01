import { edgeCall, currentUser } from "./supabase";
const active = new Set<string>();
/** Initial upload analysis reads the outline first, then each chapter; never all original questions. */
export async function prepareInitialContent(material: any) {
  const owner = (await currentUser()).id,
    key = `${owner}:${material.id}`;
  if (
    active.has(key) ||
    material.initialContentJobId ||
    material.analysisMethod !== "auto" ||
    !["ready", "needs_review"].includes(material.status)
  )
    return;
  active.add(key);
  const request = (action: string, body: any) =>
    edgeCall("content-jobs", { action, ...body });
  async function run(job: any) {
    for (let part = 1; part <= job.totalParts; part++) {
      if ((await currentUser()).id !== owner) return false;
      const result = await edgeCall("ai-request", {
        action: "run_standard",
        standardJobId: job.id,
        part,
      });
      if (result.result && result.result.status !== "completed") return false;
    }
    return true;
  }
  try {
    const outline = await request("create", {
      documentId: material.id,
      auto: true,
      method: "api",
      taskType: material.tocPages?.length ? "toc" : "initial",
      conceptQuestionCount: 5,
      practiceQuestionCount: 5,
    });
    if (!(await run(outline)) || outline.taskType !== "toc") return;
    const state = await edgeCall("app", { path: "state" });
    for (const chapter of (state.chapters || []).filter(
      (c: any) => c.materialId === material.id,
    )) {
      const selectedPages = (
        material.selectedPages ||
        Array.from({ length: material.pageCount }, (_, i) => i + 1)
      ).filter((p: number) => p >= chapter.startPage && p <= chapter.endPage);
      if (!selectedPages.length) continue;
      const job = await request("create", {
        documentId: material.id,
        auto: true,
        method: "api",
        taskType: "initial",
        chapterIds: [chapter.id],
        selectedPages,
        conceptQuestionCount: 5,
        practiceQuestionCount: 5,
      });
      if (!(await run(job))) return;
    }
  } finally {
    active.delete(key);
  }
}
