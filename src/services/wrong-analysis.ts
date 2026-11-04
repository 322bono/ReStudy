import { aiFailureText } from "../domain/ai-status";
import { edgeCall } from "./supabase";

export async function prepareWrongAnalysis(problemId: string, shouldStop: () => boolean) {
  const call = (body: Record<string, unknown>) => edgeCall("analyze-problem", body);
  const start = () => call({ action: "wrong_review", problemId });
  let job = await start();
  let retries = 0;
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
    if (retries < 1 && ["invalid_response", "timeout", "provider_error", "network_error", "all_providers_failed"].includes(code) && wait <= 15000) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1000, wait)));
      if (shouldStop()) return false;
      retries++;
      job = await start();
      continue;
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
