import { CheckCircle2, Clock3, CircleAlert, LoaderCircle } from "lucide-react";
import { Button } from "../../components/ui";
import { aiFailureText } from "../domain/ai-status";

function responseDetail(value: any) {
  if (!value) return "";
  const issues = (value.schema?.issues ?? [])
    .slice(0, 3)
    .map((i: any) => i.path)
    .filter((s: any) => typeof s === "string");
  return [
    value.finish_reason && `종료: ${value.finish_reason}`,
    issues.length && `형식: ${issues.join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
const modelName = (model: string) =>
  ({
    "gemma-4-26b-a4b-it": "Gemma 4 · 26B",
    "gemma-4-31b-it": "Gemma 4 · 31B",
  })[model] ||
  model ||
  "모델 확인 중";

export default function ApiPreparationStatus({
  job,
  running = false,
  error = "",
  elapsed = 0,
  onStop,
}: {
  job?: any;
  running?: boolean;
  error?: string;
  elapsed?: number;
  onStop?: () => void;
}) {
  if (
    !running &&
    !error &&
    !job?.apiJobs?.length &&
    job?.apiStatus?.state !== "paused"
  )
    return null;
  // An explicit error belongs to the current action. A previously completed
  // job must not hide failure to create or continue a different request.
  const complete = job?.apiStatus?.state === "completed" && !error;
  const failure = !complete && (error || job?.apiStatus?.state === "paused");
  const title = complete
    ? "학습 자료가 준비됐어요"
    : failure
      ? "준비가 멈췄어요"
      : "학습 자료 준비 중";
  const Icon = complete ? CheckCircle2 : failure ? CircleAlert : LoaderCircle;
  const attempts = job?.apiAttempts ?? [];
  const total = Math.max(1, job?.totalParts || 1);
  const completed = job?.apiStatus?.completed || 0;
  return (
    <section
      className={`api-preparation ${complete ? "is-complete" : failure ? "is-paused" : "is-running"}`}
      aria-live="polite"
    >
      <div className="api-preparation-heading">
        <Icon size={19} aria-hidden="true" />
        <h2>{title}</h2>
        {running && !complete && (
          <span className="api-elapsed">
            <Clock3 size={13} />
            {elapsed}초
          </span>
        )}
      </div>
      <p
        role={failure ? "alert" : "status"}
        className="api-preparation-message"
      >
        {complete
          ? "저장한 내용을 바로 학습할 수 있습니다."
          : error ||
            job?.apiStatus?.message ||
            "응답을 기다리고 있습니다. 완료된 결과는 자동으로 저장됩니다."}
      </p>
      <div className="api-preparation-counts">
        <span>
          개념 <strong>{job?.preparedConcepts ?? 0}</strong>
        </span>
        <span>
          문제{" "}
          <strong>
            {job?.preparedQuestions ?? job?.importedQuestions ?? 0}
          </strong>
        </span>
        <span>
          암기 카드 <strong>{job?.preparedFlashcards ?? 0}</strong>
        </span>
      </div>
      {running && !complete && (
        <div className="api-preparation-progress">
          <progress
            aria-label="학습 자료 준비 진행률"
            max={total}
            value={completed}
          />
          <small>
            {completed} / {total} 저장
          </small>
        </div>
      )}
      {running && !complete && onStop && (
        <Button variant="ghost" onClick={onStop}>
          이번 요청까지 마치고 멈추기
        </Button>
      )}
      <details className="api-history">
        <summary>
          API 호출 내역{" "}
          <span>
            {attempts.length ? `최근 ${attempts.length}회` : "대기 중"}
          </span>
        </summary>
        {job?.apiBudget && (
          <p className="api-budget">
            오늘 사용 {job.apiBudget.used} / {job.apiBudget.limit}회
          </p>
        )}
        <ol className="api-attempts">
          {attempts.map((attempt: any, index: number) => (
            <li key={`${attempt.at ?? ""}-${index}`}>
              <div className="api-attempt-heading">
                <span
                  className={`api-attempt-result ${attempt.success ? "succeeded" : "failed"}`}
                >
                  {attempt.success ? "성공" : "미완료"}
                </span>
                <strong title={attempt.model}>
                  {modelName(attempt.model)}
                </strong>
                <time>{Math.round((attempt.duration_ms ?? 0) / 1000)}초</time>
              </div>
              <p>
                {attempt.success
                  ? "유효한 응답을 받았습니다."
                  : aiFailureText(attempt.error)}
              </p>
              {attempt.at && (
                <small>
                  {new Date(attempt.at).toLocaleTimeString("ko-KR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {attempt.http_status ? ` · HTTP ${attempt.http_status}` : ""}
                </small>
              )}
              {attempt.response_metadata &&
                responseDetail(attempt.response_metadata) && (
                  <details className="api-attempt-detail">
                    <summary>기술 정보</summary>
                    <small>{responseDetail(attempt.response_metadata)}</small>
                  </details>
                )}
            </li>
          ))}
        </ol>
        {!attempts.length && (
          <p className="api-budget">첫 응답을 기다리고 있습니다.</p>
        )}
      </details>
      {!!job?.preparedPreview?.length && (
        <details className="api-saved-preview">
          <summary>저장된 문제 미리보기</summary>
          {job.preparedPreview.map((q: any, i: number) => (
            <article key={i}>
              <strong>{q.prompt}</strong>
              {!!q.options?.length && (
                <ol type="A">
                  {q.options.map((option: string, j: number) => (
                    <li key={j}>{option}</li>
                  ))}
                </ol>
              )}
              <p>정답: {q.answer}</p>
              <p>{q.explanation}</p>
              <small>출처 · PDF {(q.source_pages ?? []).join(", ")}쪽</small>
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
