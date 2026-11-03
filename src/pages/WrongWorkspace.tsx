import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clipboard,
  FileText,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Badge, Button, Empty } from "../../components/ui";
import { SecureImage } from "../../components/secure-assets";
import { api, dateLabel, dueLabel } from "../../lib/client";
import type { AppState, Question } from "../../lib/types";
import {
  formatPages,
  parseRestudy,
  type RestudyPackage,
} from "../domain/restudy";
import { downloadSelectedPdf } from "../services/documents";
import { edgeCall } from "../services/supabase";
import "../styles/wrong-workspace.css";
import ApiPreparationStatus from "../components/ApiPreparationStatus";
import OriginalAnalysis from "../components/OriginalAnalysis";
import { prepareWrongAnalysis } from "../services/wrong-analysis";
import { runPreparedJob } from "../services/content-runner";
import "../styles/original-analysis.css";

type SavedQuestion = Question & {
  imagePaths?: string[];
  memorize?: string[];
  analysis?: { key_point?: string; memorize?: string[]; mistakes?: string[] };
};
export type WrongWorkspaceProps = {
  id: string;
  autoAnalyzeIds?: string[];
  onAutoAnalysisComplete?: () => void;
  state: AppState;
  onBack: () => void;
  onBank: (scope: any) => void;
  onSolve: (ids: string[]) => void | Promise<void>;
  onViewer: (materialId: string, page?: number) => void;
  onError: (message: string) => void;
  onRefresh: () => void | Promise<void>;
};
type Job = {
  id: string;
  method?: string;
  partSize?: number;
  taskType: string;
  status?: string;
  targetQuestions?: { id: string }[];
  selectedPages?: number[];
  totalParts: number;
  receivedParts?: number;
  importedQuestions?: number;
  parts?: { part: number; applied: boolean }[];
};
type Preview = {
  valid: boolean;
  ready: boolean;
  hash: string;
  errors?: string[];
  warnings?: string[];
  unresolved?: string[];
  counts: {
    questions: number;
    concepts: number;
    parts: number;
    totalParts: number;
  };
};
type Inspection = {
  preview: Preview;
  data: RestudyPackage;
  raw: string;
  jobId: string;
};
const statusLabels: Record<string, string> = {
  draft: "작업 준비됨",
  pending_refs: "참조 대기",
  partial: "일부 분할 보관",
  needs_more: "추가 문항 필요",
  ready: "학습 가능",
  review_needed: "학습 가능",
  completed: "완료",
  paused: "보류",
  waiting: "대기",
  running: "처리 중",
  failed: "확인 필요",
  retry_wait: "재시도 대기",
};
const standard = <T,>(action: string, body: Record<string, unknown> = {}) =>
  edgeCall("content-jobs", { action, ...body }) as Promise<T>;
const messageOf = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "요청을 처리하지 못했습니다. 다시 시도해 주세요.";

export default function WrongWorkspace({
  id,
  autoAnalyzeIds = [],
  onAutoAnalysisComplete,
  state,
  onBack,
  onBank,
  onSolve,
  onViewer,
  onError,
  onRefresh,
}: WrongWorkspaceProps) {
  const fieldId = useId();
  const question = state.questions.find((item) => item.id === id) as
    SavedQuestion | undefined;
  const material = state.materials.find(
    (item) => item.id === question?.materialId,
  );
  const mistake = state.mistakes.find((item) => item.questionId === id);
  const pages = [
    ...new Set(
      (question?.regions.length
        ? question.regions.map((region) => region.page)
        : [question?.page]
      ).filter(
        (page): page is number => Number.isInteger(page) && Number(page) > 0,
      ),
    ),
  ].sort((a, b) => a - b);
  const [jobs, setJobs] = useState<Job[]>([]),
    [job, setJob] = useState<Job>();
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [preparationKind, setPreparationKind] = useState("complete");
  const [preparationOpen, setPreparationOpen] = useState(false),
    [loadingJobs, setLoadingJobs] = useState(false);
  const [part, setPart] = useState(1),
    [prompt, setPrompt] = useState(""),
    [raw, setRaw] = useState("");
  const [inspection, setInspection] = useState<Inspection>();
  const incomingRaw = useRef(raw);
  incomingRaw.current = raw;
  const locked = useRef(false),
    activeId = useRef(id),
    mounted = useRef(true),
    selectedJob = useRef<string | undefined>(undefined);
  activeId.current = id;
  const stopApi = useRef(false),
    apiStart = useRef(0);
  const [apiElapsed, setApiElapsed] = useState(0);
  const [savedReview, setSavedReview] = useState<any>(),
    [loadingReview, setLoadingReview] = useState(true);
  const automaticStarted = useRef("");
  async function loadReview() {
    const forId = id;
    const result = await api(`questions/${forId}/review`);
    if (mounted.current && activeId.current === forId) setSavedReview(result);
    return result;
  }
  useEffect(() => {
    let alive = true;
    setLoadingReview(true);
    setSavedReview(undefined);
    loadReview()
      .catch((cause) => {
        if (alive) setError(messageOf(cause));
      })
      .finally(() => {
        if (alive) setLoadingReview(false);
      });
    return () => {
      alive = false;
    };
  }, [id, state.questions, state.concepts]);
  useEffect(() => {
    const request = autoAnalyzeIds.join(",");
    if (
      !request ||
      loadingJobs ||
      loadingReview ||
      automaticStarted.current === request ||
      locked.current
    )
      return;
    automaticStarted.current = request;
    void act("API 자동 분석", () => startAutomatic(autoAnalyzeIds));
  }, [autoAnalyzeIds, loadingJobs, loadingReview]);
  useEffect(() => {
    if (!busy.includes("API")) return;
    // The durable runner already polls this job. Keep the display clock local.
    const timer = setInterval(() => {
      setApiElapsed(Math.floor((Date.now() - apiStart.current) / 1000));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [busy, id]);

  async function loadJobs(preferred?: string): Promise<Job | undefined> {
    if (!question) return;
    const forId = id;
    const result = await standard<{ jobs: Job[] }>("list", {
      documentId: question.materialId,
    });
    const related = (result.jobs || []).filter(
      (item) =>
        item.taskType === "problem" &&
        item.targetQuestions?.length === 1 &&
        item.targetQuestions[0].id === forId,
    );
    const selected =
      related.find((item) => item.id === (preferred || selectedJob.current)) ||
      related.find(
        (item) => !["ready", "completed"].includes(item.status || ""),
      ) ||
      related[0];
    const full = selected
      ? await standard<Job>("get", { jobId: selected.id })
      : undefined;
    if (mounted.current && activeId.current === forId) {
      setJobs(related);
      setJob(full);
      selectedJob.current = full?.id;
    }
    return full;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    setJobs([]);
    setJob(undefined);
    selectedJob.current = undefined;
    setPrompt("");
    setRaw("");
    setInspection(undefined);
    setPart(1);
    setMessage("");
    setError("");
    setPreparationOpen(false);
    if (question) {
      setLoadingJobs(true);
      loadJobs()
        .catch((cause) => {
          if (alive && activeId.current === id) setError(messageOf(cause));
        })
        .finally(() => {
          if (alive && activeId.current === id) setLoadingJobs(false);
        });
    }
    return () => {
      alive = false;
    };
  }, [id, question?.materialId]);

  async function act(name: string, work: () => Promise<void>) {
    if (locked.current) return;
    const forId = id;
    locked.current = true;
    if (name.includes("API")) {
      apiStart.current = Date.now();
      setApiElapsed(0);
    }
    setBusy(name);
    setError("");
    setMessage("");
    try {
      await work();
      if (mounted.current && activeId.current === forId) await loadReview();
    } catch (cause) {
      if (mounted.current && activeId.current === forId) {
        const value = messageOf(cause);
        setError(value);
        onError(value);
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy("");
    }
  }
  function resetIncoming() {
    setRaw("");
    setInspection(undefined);
    setPrompt("");
    setPart(1);
  }
  async function runApi(current: Job) {
    const forId = id;
    stopApi.current = false;
    if (current.method !== "api" || (current.partSize ?? 20) > 5) {
      current = await standard<Job>("api_continuation", { jobId: current.id });
      setJob(current);
      selectedJob.current = current.id;
    }
    const completed = await runPreparedJob(current, {
      shouldStop: () =>
        stopApi.current || activeId.current !== forId || !mounted.current,
      onUpdate: (latest: Job) => {
        if (mounted.current && activeId.current === forId) {
          setJob(latest);
          selectedJob.current = latest.id;
        }
      },
    });
    await onRefresh();
    await loadJobs(current.id);
    if (activeId.current === forId && mounted.current)
      setMessage(
        completed.parts?.filter((part) => part.applied).length ===
          completed.totalParts
          ? "저장된 결과를 불러왔습니다. 준비된 문항을 바로 학습할 수 있습니다."
          : "완료된 결과는 보관했습니다. 준비 도구에서 남은 분할과 오류를 확인하고 이어서 실행할 수 있습니다.",
      );
  }
  async function startAutomatic(ids: string[]) {
    stopApi.current = false;
    const failures: string[] = [];
    try {
      for (let index = 0; index < ids.length; index++) {
        if (stopApi.current || !mounted.current) break;
        const target = state.questions.find((item) => item.id === ids[index]);
        const source = state.materials.find(
          (item) => item.id === target?.materialId,
        );
        if (!target || !source) continue;
        setMessage(
          `${index + 1}/${ids.length} · ${target.number}번 원본을 분석하고 저장합니다.`,
        );
        try {
          await prepareWrongAnalysis(target, source, {
            shouldStop: () => stopApi.current || !mounted.current,
            onUpdate: (next) => {
              if (mounted.current) {
                setJob(next);
                selectedJob.current = next.id;
              }
            },
          });
          await onRefresh();
          if (mounted.current) await loadReview();
        } catch (cause) {
          failures.push(`${target.number}번: ${messageOf(cause)}`);
        }
      }
      if (mounted.current) {
        await loadJobs();
        if (failures.length) setError(failures.join("\n"));
        setMessage(
          stopApi.current
            ? "완료된 분석은 저장했습니다. 준비 도구에서 이어서 실행할 수 있습니다."
            : failures.length
              ? "완료된 분석은 저장했습니다. 실패한 문제는 다시 분석할 수 있습니다."
              : "저장된 분석을 불러왔습니다. 준비된 추가 문항을 바로 풀 수 있습니다.",
        );
      }
    } finally {
      onAutoAnalysisComplete?.();
    }
  }
  async function create(method: "api" | "external") {
    if (!question || !material)
      throw new Error("원본 자료를 찾을 수 없습니다.");
    const forId = id;
    const created = await standard<Job>("create", {
      documentId: question.materialId,
      taskType: "problem",
      method,
      questionIds: [id],
      selectedPages: pages,
      tocPages: material.tocPages || [],
      questionCount:
        preparationKind === "similar"
          ? 5
          : preparationKind === "complete"
            ? 20
            : 15,
      purposeCounts:
        preparationKind === "similar"
          ? { concept: 0, practice: 0, similar: 5 }
          : {
              concept: 5,
              practice: 10,
              similar: preparationKind === "complete" ? 5 : 0,
            },
      questionTypes: ["mcq", "ox", "short", "blank"],
      difficultyDistribution: { easy: 20, medium: 50, hard: 30 },
    });
    if (activeId.current !== forId || !mounted.current) return;
    setJob(created);
    selectedJob.current = created.id;
    setJobs((current) => [created, ...current]);
    resetIncoming();
    setPreparationOpen(true);
    if (method === "api") await runApi(created);
    else
      setMessage(
        "외부 분석 작업을 준비했습니다. 프롬프트와 원본 PDF를 함께 사용해 주세요.",
      );
  }
  async function inspect() {
    if (!job) throw new Error("먼저 이 문제의 분석 작업을 준비해 주세요.");
    const forId = id,
      jobId = job.id,
      submitted = raw,
      data = parseRestudy(submitted);
    const preview = await standard<Preview>("preview", {
      jobId,
      raw: data,
    });
    if (
      activeId.current !== forId || !mounted.current ||
      selectedJob.current !== jobId || incomingRaw.current !== submitted
    ) return;
    const result = { preview, data, raw: submitted, jobId };
    setInspection(result);
    if (preview.valid) await importData(result);
  }
  async function importData(resultInspection: Inspection) {
    if (
      !job || !resultInspection.preview.valid ||
      resultInspection.raw !== incomingRaw.current ||
      resultInspection.jobId !== job.id || selectedJob.current !== job.id ||
      activeId.current !== id || !mounted.current
    )
      throw new Error("현재 결과가 변경되었습니다. 다시 등록해 주세요.");
    const forId = id;
    const result = await standard<{
      job: Job;
      receivedParts: number;
      questions: number;
      ready: boolean;
    }>("import", {
      jobId: job.id,
      raw: resultInspection.data,
      previewHash: resultInspection.preview.hash,
    });
    await onRefresh();
    if (
      activeId.current !== forId || !mounted.current ||
      selectedJob.current !== resultInspection.jobId ||
      incomingRaw.current !== resultInspection.raw
    ) return;
    setJob(result.job);
    setRaw("");
    setInspection(undefined);
    setMessage(
      `${result.receivedParts}/${job.totalParts}분할 보관 · ${result.questions}문항 등록${!result.ready ? " · 다른 분할의 참조 대기" : " · 학습 가능"}`,
    );
    await loadJobs(job.id);
  }
  function bankScope(
    purpose: "concept" | "practice" | "similar",
    count: number,
    mode = "quiz",
  ) {
    return {
      materialIds: question ? [question.materialId] : [],
      originalId: purpose === "similar" ? undefined : id,
      questionIds: purpose === "similar" ? [id] : [],
      purposes: mode === "memory" ? [] : [purpose],
      count,
      mode,
    };
  }

  if (!question || !material)
    return (
      <section className="wrong-workspace">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={15} />
          오답 노트로
        </Button>
        <Empty
          title="이 원본 문제를 찾을 수 없습니다"
          description="자료와 문항이 현재 계정에 등록되어 있는지 확인해 주세요."
        />
      </section>
    );
  const preview = inspection?.preview;
  return (
    <section className="wrong-workspace" aria-labelledby={`${fieldId}-title`}>
      <header className="ww-head">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="ww-back"
            onClick={onBack}
          >
            <ArrowLeft size={14} />
            오답 노트로
          </Button>
          <div className="ww-eyebrow">
            {material.subject} · {material.title}
          </div>
          <h1 id={`${fieldId}-title`}>
            {question.number}번 <span>{question.unit}</span>
          </h1>
          <p>
            원본 PDF {formatPages(pages)}쪽 ·{" "}
            {mistake?.resolved ? "맞힌 문제 · 기록 보관 중" : "오답 복습"}
          </p>
        </div>
        <Button variant="secondary" onClick={() => onSolve([id])}>
          <RotateCcw size={15} />
          다시 풀기
        </Button>
      </header>
      <ApiPreparationStatus
        job={job}
        running={busy.includes("API")}
        elapsed={apiElapsed}
        error={busy.includes("API") ? "" : error}
        onStop={() => {
          stopApi.current = true;
          setMessage("현재 요청이 끝나면 완료된 결과를 보관하고 멈춥니다.");
        }}
      />
      <div className="ww-study-layout">
        <aside className="ww-source" aria-label="저장된 원본 문제">
          <div className="ww-source-heading">
            <h2>원본 문제</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onViewer(question.materialId, question.page)}
            >
              출처 보기
            </Button>
          </div>
          {question.regions.length && question.imagePaths?.length ? (
            <div className="ww-source-images">
              {question.regions.map((_, index) => (
                <SecureImage
                  key={index}
                  path={`questions/${id}/image/${index}`}
                  alt={`${question.number}번 원본 문제${question.regions.length > 1 ? ` · 영역 ${index + 1}` : ""}`}
                />
              ))}
            </div>
          ) : (
            <p className="ww-help">
              저장된 원본 크롭이 없습니다. 문항 영역을 먼저 저장해 주세요.
            </p>
          )}
          <p className="ww-help">
            다시 풀기에서는 깨끗한 원본을 먼저 보고, 정답 확인 후 저장된 분석을
            읽습니다.
          </p>
          {mistake && (
            <details className="ww-source-history">
              <summary>복습 기록 · {mistake.reviewCount || 0}회</summary>
              <p>
                맞힘 {mistake.correctCount || 0}회 ·{" "}
                {mistake.resolved
                  ? "보관함에 저장됨"
                  : `${dueLabel(mistake.dueAt)} 복습`}
              </p>
              {mistake.cause && <p>내 메모 · {mistake.cause}</p>}
              <small>{dateLabel(mistake.createdAt)} 등록</small>
            </details>
          )}
        </aside>
        <div className="ww-main">
          <OriginalAnalysis
            review={savedReview}
            loading={loadingReview}
            onBank={onBank}
          />
          {!savedReview?.hasSavedAnalysis &&
            !busy &&
            !autoAnalyzeIds.length && (
              <div className="ww-analysis-start">
                <Button
                  busy={busy === "API 분석"}
                  disabled={!!busy}
                  onClick={() => act("API 분석", () => startAutomatic([id]))}
                >
                  이 문제 분석하기
                </Button>
              </div>
            )}
          <details
            className="ww-preparation"
            open={preparationOpen}
            onToggle={(event) => setPreparationOpen(event.currentTarget.open)}
          >
            <summary>
              콘텐츠 준비·가져오기{" "}
              {loadingJobs ? (
                <small>작업 확인 중…</small>
              ) : job ? (
                <small>{statusLabels[job.status || ""] || "작업 보관됨"}</small>
              ) : null}
            </summary>
            <div className="ww-preparation-body">
              <label className="ww-field">
                준비할 문항
                <select
                  value={preparationKind}
                  disabled={!!busy}
                  onChange={(e) => setPreparationKind(e.target.value)}
                >
                  <option value="complete">
                    한 번에 · 개념 5개 · 연습 10개 · 유사 5개
                  </option>
                  <option value="review">개념 퀴즈 5개 · 연습문제 10개</option>
                  <option value="similar">이 원본과 연결된 유사문제 5개</option>
                </select>
              </label>
              <p className="ww-help">
                원본 {question.number}번 · PDF {formatPages(pages)}쪽을 기준으로
                개념 정리, 개념 퀴즈 5개와 연습문제 10개를 준비합니다. 오답 등록
                시 저장된 분석이 없으면 자동으로 분석합니다.
              </p>
              <div className="ww-actions">
                <Button
                  disabled={!!busy || loadingJobs}
                  busy={busy === "API 분석"}
                  onClick={() => act("API 분석", () => create("api"))}
                >
                  새 API 작업 시작
                </Button>
                <Button
                  variant="secondary"
                  disabled={!!busy || loadingJobs}
                  busy={busy === "외부 작업 준비"}
                  onClick={() =>
                    act("외부 작업 준비", () => create("external"))
                  }
                >
                  새 외부 분석 작업 준비
                </Button>
              </div>
              {jobs.length ? (
                <label className="ww-field" htmlFor={`${fieldId}-jobs`}>
                  <span>이 문제의 저장된 작업</span>
                  <select
                    id={`${fieldId}-jobs`}
                    value={job?.id || ""}
                    disabled={!!busy}
                    onChange={(event) => {
                      const selected = event.target.value;
                      void act("작업 열기", async () => {
                        const current = await standard<Job>("get", {
                          jobId: selected,
                        });
                        if (activeId.current === id) {
                          setJob(current);
                          selectedJob.current = current.id;
                          resetIncoming();
                        }
                      });
                    }}
                  >
                    {jobs.map((item, index) => (
                      <option key={item.id} value={item.id}>
                        작업 {index + 1} ·{" "}
                        {statusLabels[item.status || ""] || "보관됨"} ·{" "}
                        {item.receivedParts || 0}/{item.totalParts}분할
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {job ? (
                <div className="ww-import">
                  <div className="ww-job-progress">
                    <span>
                      {job.receivedParts || 0}/{job.totalParts}분할 · 등록{" "}
                      {job.importedQuestions || 0}문항
                      {" · PDF "}
                      {formatPages(job.selectedPages || pages)}쪽
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!busy}
                      busy={busy === "작업 갱신"}
                      onClick={() =>
                        act("작업 갱신", async () => {
                          await loadJobs(job.id);
                          await onRefresh();
                        })
                      }
                    >
                      <RefreshCw size={13} />
                      상태 갱신
                    </Button>
                  </div>
                  <section className="ww-import-step">
                    <h3>1. 프롬프트 복사</h3>
                    <div className="ww-actions">
                      <label className="ww-part" htmlFor={`${fieldId}-part`}>
                        <span>분할</span>
                        <select
                          id={`${fieldId}-part`}
                          value={part}
                          disabled={!!busy}
                          onChange={(event) => {
                            setPart(Number(event.target.value));
                            setPrompt("");
                          }}
                        >
                          {Array.from(
                            { length: job.totalParts },
                            (_, index) => (
                              <option key={index} value={index + 1}>
                                {index + 1} / {job.totalParts}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <Button
                        variant="secondary"
                        disabled={!!busy}
                        busy={busy === "프롬프트 복사"}
                        onClick={() =>
                          act("프롬프트 복사", async () => {
                            const result = await standard<{ prompt: string }>(
                              "prompt",
                              { jobId: job.id, part },
                            );
                            if (activeId.current !== id) return;
                            setPrompt(result.prompt);
                            try {
                              await navigator.clipboard.writeText(
                                result.prompt,
                              );
                              if (mounted.current && activeId.current === id)
                                setMessage("프롬프트를 복사했습니다.");
                            } catch {
                              if (mounted.current && activeId.current === id)
                                setMessage(
                                  "프롬프트를 준비했습니다. 아래 내용을 직접 선택해 복사해 주세요.",
                                );
                            }
                          })
                        }
                      >
                        <Clipboard size={14} />
                        프롬프트 복사
                      </Button>
                    </div>
                    {prompt ? (
                      <details className="ww-prompt">
                        <summary>프롬프트 직접 복사</summary>
                        <textarea
                          aria-label="외부 AI용 프롬프트"
                          value={prompt}
                          readOnly
                          rows={8}
                        />
                      </details>
                    ) : null}
                  </section>
                  <section className="ww-import-step">
                    <h3>2. 원본 PDF와 함께 외부 AI에 입력</h3>
                    <p className="ww-help">
                      같은 문제집 PDF를 ChatGPT 등에 첨부하고 복사한 프롬프트를
                      입력하세요.
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!!busy}
                      busy={busy === "원본 범위 내보내기"}
                      onClick={() =>
                        act("원본 범위 내보내기", async () => {
                          await downloadSelectedPdf(
                            question.materialId,
                            job.selectedPages || pages,
                          );
                        })
                      }
                    >
                      <FileText size={14} />이 문제의 PDF 페이지 내보내기
                    </Button>
                  </section>
                  <section className="ww-import-step">
                    <h3>3. 결과 붙여넣기·등록</h3>
                    <label className="ww-field" htmlFor={`${fieldId}-json`}>
                      <span>출력된 값을 그대로 복사해 붙여넣으세요.</span>
                      <textarea
                        id={`${fieldId}-json`}
                        rows={9}
                        maxLength={12000000}
                        placeholder="restudy.v1 JSON 또는 JSON 코드 블록"
                        value={raw}
                        disabled={!!busy}
                        onChange={(event) => {
                          setRaw(event.target.value);
                          setInspection(undefined);
                        }}
                      />
                    </label>
                    <Button
                      variant="secondary"
                      disabled={!!busy || !raw.trim()}
                      busy={busy === "분석 결과 등록"}
                      onClick={() => act("분석 결과 등록", inspect)}
                    >
                      분석 결과 등록
                    </Button>
                    {preview && inspection ? (
                      <div className="ww-import-preview">
                        <p>
                          <strong>
                            {preview.counts.questions}문항 · 개념{" "}
                            {preview.counts.concepts}개
                          </strong>
                          <span>
                            {preview.counts.parts}/{preview.counts.totalParts}
                            분할
                          </span>
                        </p>
                        {preview.errors?.map((value, index) => (
                          <p
                            className="ww-error"
                            role="alert"
                            key={`error-${index}`}
                          >
                            {value}
                          </p>
                        ))}
                        {preview.warnings?.map((value, index) => (
                          <p className="ww-help" key={`warning-${index}`}>
                            {value}
                          </p>
                        ))}
                        {preview.unresolved?.length ? (
                          <p className="ww-help">
                            다른 분할의 단원·개념 참조를 기다리고 있습니다.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                  <p className="ww-import-note">
                    붙여넣기·검사·등록은 AI API를 호출하지 않습니다. API 결과도
                    같은 restudy.v1 형식 검사를 거쳐 바로 학습에 사용합니다.
                  </p>
                  <div className="ww-actions">
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      busy={busy === "API 작업 실행"}
                      onClick={() => act("API 작업 실행", () => runApi(job))}
                    >
                      현재 작업을 API로 실행·재개
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        onBank({
                          ...bankScope("concept", 15, "quiz"),
                          purposes: ["concept", "practice", "similar"],
                        })
                      }
                    >
                      등록 문항 보기·수정
                      <ArrowRight size={13} />
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </details>
          {error && (
            <p className="ww-feedback ww-error" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="ww-feedback" role="status">
              <Check size={15} />
              {message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
