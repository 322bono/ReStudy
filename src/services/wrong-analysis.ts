import { aiFailureText } from "../domain/ai-status";
import { edgeCall } from "./supabase";

export async function prepareWrongAnalysis(
  problemId: string,
  shouldStop: () => boolean,
  canRetry: () => boolean = () => true,
) {
  const call = (body: Record<string, unknown>) => edgeCall("analyze-problem", body);
  const start = () => call({ action: "wrong_review", problemId });
  let job = await start();
  let retries = 0;
  let checks = 0;
  while (!shouldStop() && job.status !== "completed") {
    if (job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (shouldStop()) return false;
      job = await call({ action: "status", jobId: job.id });
      if (job.status === "running" && Date.parse(job.lease_until) <= Date.now())
        throw new Error("분석 실행이 중단됐습니다. 이 문제 분석하기를 눌러 다시 시도해 주세요.");
      continue;
    }
    const code = job.provider_error ?? job.last_error;
    const wait = Date.parse(job.available_at ?? "") - Date.now();
    if (job.status === 'waiting' && code === 'quality_check_pending' && checks < 2) {
      checks++;
      job = await start();
      continue;
    }
    if (retries < 1 && canRetry() && ["invalid_response", "answer_inconsistent", "timeout", "provider_error", "network_error", "all_providers_failed"].includes(code) && wait <= 15000) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1000, wait)));
      if (shouldStop()) return false;
      if (canRetry()) {
        retries++;
        job = await start();
        continue;
      }
    }
    if (job.status === "waiting")
      throw new Error("일일 분석 한도 또는 대기 상태를 확인한 뒤 이 문제 분석하기를 눌러 주세요.");
    if (code === "source_changed")
      throw new Error("분석 중 원본 영역이 바뀌었습니다. 수정된 영역으로 다시 분석해 주세요.");
    const retryAt = wait > 0 ? ` ${new Date(job.available_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 이후에 다시 시도해 주세요.` : "";
    throw new Error(aiFailureText(code) + retryAt);
  }
  return job.status === "completed";
}

type WrongAnalysisResult =
  | { id: string; status: "completed" }
  | { id: string; status: "failed"; message: string };

export type WrongAnalysisProgress = {
  currentId: string | null;
  pendingIds: string[];
  results: WrongAnalysisResult[];
  stopped: number;
};

export function createWrongAnalysisQueue(onProgress: (progress: WrongAnalysisProgress) => void) {
  let currentId: string | null = null;
  let pendingIds: string[] = [];
  let results: WrongAnalysisResult[] = [];
  let stopped = 0;
  let retryCurrent = true;
  let disposed = false;

  function publish() {
    if (!disposed) onProgress({ currentId, pendingIds: [...pendingIds], results: [...results], stopped });
  }

  async function run() {
    while (!disposed && pendingIds.length) {
      const id = pendingIds.shift()!;
      currentId = id;
      retryCurrent = true;
      publish();
      try {
        if (await prepareWrongAnalysis(id, () => disposed, () => retryCurrent)) {
          results.push({ id, status: "completed" });
        }
      } catch (cause) {
        results.push({
          id,
          status: "failed",
          message: cause instanceof Error ? cause.message : "분석 요청을 처리하지 못했습니다.",
        });
      }
      currentId = null;
    }
    publish();
  }

  return {
    enqueue(ids: string[]) {
      if (disposed || !ids.length) return;
      if (!currentId) {
        results = [];
        stopped = 0;
      }
      const known = new Set([
        currentId,
        ...pendingIds,
        ...results.filter((result) => result.status === "completed").map(({ id }) => id),
      ]);
      const added = new Set(ids.filter((id) => !known.has(id)));
      if (!added.size) return;
      results = results.filter(({ id }) => !added.has(id));
      pendingIds.push(...added);
      if (currentId) publish();
      else void run();
    },
    stop() {
      if (disposed || !pendingIds.length) return;
      retryCurrent = false;
      stopped += pendingIds.length;
      pendingIds = [];
      publish();
    },
    remove(ids: string[]) {
      if (disposed || !pendingIds.length) return;
      const removed = new Set(ids);
      pendingIds = pendingIds.filter((id) => !removed.has(id));
      publish();
    },
    dispose() {
      disposed = true;
    },
  };
}
