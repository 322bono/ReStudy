import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Clipboard,
  FileText,
  Layers,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Badge, Button, Empty, Sources } from "../../components/ui";
import { SecureImage } from "../../components/secure-assets";
import { dateLabel, dueLabel } from "../../lib/client";
import type { AppState, Concept, Question } from "../../lib/types";
import {
  formatPages,
  parseRestudy,
  type RestudyPackage,
} from "../domain/restudy";
import { downloadSelectedPdf } from "../services/documents";
import { edgeCall } from "../services/supabase";
import "../styles/wrong-workspace.css";
import ApiPreparationStatus from '../components/ApiPreparationStatus';

type SavedConcept = Concept & {
  formulas?: string[];
  memorize?: string[];
  pitfalls?: string[];
  evidence?: string;
};
type SavedQuestion = Question & {
  imagePaths?: string[];
  memorize?: string[];
  analysis?: { key_point?: string; memorize?: string[]; mistakes?: string[] };
};
export type WrongWorkspaceProps = {
  id: string;
  state: AppState;
  onBack: () => void;
  onBank: (scope: any) => void;
  onSolve: (ids: string[]) => void | Promise<void>;
  onReview: (questionId: string) => void | Promise<void>;
  onViewer: (materialId: string, page?: number) => void;
  onError: (message: string) => void;
  onRefresh: () => void | Promise<void>;
};
type Job = {
  id: string;
  method?:string;
  partSize?:number;
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
const statusLabels: Record<string, string> = {
  draft: "작업 준비됨",
  pending_refs: "참조 대기",
  partial: "일부 분할 보관",
  needs_more: "추가 문항 필요",
  ready: "학습 가능",
  review_needed: "내용 검토 필요",
  completed: "완료",
  paused: "보류",
  waiting: "대기",
  running: "처리 중",
  failed: "확인 필요",
  retry_wait: "재시도 대기",
};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      )
    : [];
const distinct = (values: string[]) => [...new Set(values)];
const standard = <T,>(action: string, body: Record<string, unknown> = {}) =>
  edgeCall("content-jobs", { action, ...body }) as Promise<T>;
const messageOf = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "요청을 처리하지 못했습니다. 다시 시도해 주세요.";

function ConceptReading({
  concept,
  materials,
  onViewer,
}: {
  concept: SavedConcept;
  materials: AppState["materials"];
  onViewer: WrongWorkspaceProps["onViewer"];
}) {
  const formulas = strings(concept.formulas),
    memorize = strings(concept.memorize);
  const properties =
    formulas.length || memorize.length ? [] : strings(concept.properties);
  const pitfalls = strings(concept.pitfalls);
  const misconceptions = concept.misconceptions || [];
  return (
    <article
      className="ww-concept"
      aria-labelledby={`ww-concept-${concept.id}`}
    >
      <header>
        <h3 id={`ww-concept-${concept.id}`}>{concept.name}</h3>
        {concept.evidence === "toc_only" ? (
          <Badge tone="amber">목차 기준 · 본문 확인 필요</Badge>
        ) : null}
      </header>
      {concept.major || concept.minor ? (
        <p className="ww-concept-location">
          {[concept.major, concept.minor].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      <p className="ww-definition">
        {concept.definition || "저장된 개념 설명이 없습니다."}
      </p>
      {formulas.length ? (
        <div className="ww-reading-group">
          <h4>공식·조건</h4>
          <ul>
            {formulas.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {properties.length ? (
        <div className="ww-reading-group">
          <h4>핵심 성질</h4>
          <ul>
            {properties.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {memorize.length ? (
        <div className="ww-reading-group ww-memorize">
          <h4>암기사항</h4>
          <ul>
            {memorize.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {pitfalls.length || misconceptions.length ? (
        <div className="ww-reading-group ww-pitfalls">
          <h4>주의할 점</h4>
          <ul>
            {pitfalls.length
              ? pitfalls.map((value, index) => <li key={index}>{value}</li>)
              : misconceptions.map((item) => (
                  <li key={item.id}>
                    {item.label}
                    {item.correction ? <p>{item.correction}</p> : null}
                  </li>
                ))}
          </ul>
        </div>
      ) : null}
      {concept.sources?.length ? (
        <Sources
          sources={concept.sources}
          materials={materials}
          onOpen={onViewer}
        />
      ) : null}
    </article>
  );
}

function PackageReview({ data }: { data: RestudyPackage }) {
  return (
    <div className="ww-package-review">
      <p className="ww-help">
        현재 붙여넣은 분할의 개념·분석·문항을 확인하세요. 형식 검사는 내용의
        정확성 검토와 별개입니다.
      </p>
      <div className="ww-review-scroll">
        {data.concepts.map((concept) => (
          <details key={`concept-${concept.id}`}>
            <summary>개념 · {concept.name}</summary>
            <p>{concept.summary}</p>
            {[
              ["공식", concept.formulas],
              ["암기사항", concept.memorize],
              ["주의할 점", concept.pitfalls],
            ].map(([label, values]) =>
              (values as string[]).length ? (
                <div key={label as string}>
                  <strong>{label as string}</strong>
                  <ul>
                    {(values as string[]).map((value, index) => (
                      <li key={index}>{value}</li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
          </details>
        ))}
        {data.problem_analyses.map((analysis, index) => (
          <details key={`analysis-${index}`}>
            <summary>
              원본 {analysis.q_number}번 · PDF {analysis.pdf_page}쪽
            </summary>
            <p>{analysis.key_point}</p>
            {analysis.memorize.length ? (
              <>
                <strong>암기사항</strong>
                <ul>
                  {analysis.memorize.map((value, i) => (
                    <li key={i}>{value}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {analysis.mistakes.length ? (
              <>
                <strong>확인할 조건·예상 실수</strong>
                <ul>
                  {analysis.mistakes.map((value, i) => (
                    <li key={i}>{value}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </details>
        ))}
        {data.questions.map((question, index) => (
          <details key={`question-${question.id}`}>
            <summary>
              {index + 1}.{" "}
              {
                (
                  {
                    concept: "개념 퀴즈",
                    practice: "연습문제",
                    similar: "유사문제",
                  } as const
                )[question.purpose]
              }{" "}
              · {question.prompt}
            </summary>
            <p>{question.prompt}</p>
            {question.options.length ? (
              <ol type="A">
                {question.options.map((option, i) => (
                  <li key={i}>{option}</li>
                ))}
              </ol>
            ) : null}
            <p>
              <strong>정답</strong> {question.answer}
            </p>
            <p>
              <strong>해설</strong> {question.explanation}
            </p>
            {Object.entries(question.option_explanations).map(
              ([option, explanation]) => (
                <p key={option}>
                  <strong>{option}</strong> {explanation}
                </p>
              ),
            )}
            <small>출처 PDF {formatPages(question.source_pages)}쪽</small>
          </details>
        ))}
        {data.flashcards.map((card) => (
          <details key={`card-${card.id}`}>
            <summary>암기카드 · {card.front}</summary>
            <p>{card.back}</p>
          </details>
        ))}
      </div>
    </div>
  );
}

export default function WrongWorkspace({
  id,
  state,
  onBack,
  onBank,
  onSolve,
  onReview,
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
  const conceptIds = distinct(question?.conceptIds || []);
  const concepts = conceptIds
    .map(
      (cid) =>
        state.concepts.find((concept) => concept.id === cid) as
          SavedConcept | undefined,
    )
    .filter((concept): concept is SavedConcept => !!concept);
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
  const [inspection, setInspection] = useState<{
      preview: Preview;
      data: RestudyPackage;
      raw: string;
    }>(),
    [reviewed, setReviewed] = useState(false);
  const locked = useRef(false),
    activeId = useRef(id),
    mounted = useRef(true),
    selectedJob = useRef<string | undefined>(undefined);
  activeId.current = id;
  const stopApi=useRef(false),apiStart=useRef(0);
  const [apiElapsed,setApiElapsed]=useState(0);
  useEffect(()=>{
    if(!busy.includes('API'))return;
    let stopped=false,polling=false;
    const timer=setInterval(async()=>{
      setApiElapsed(Math.floor((Date.now()-apiStart.current)/1000));
      if(polling||!selectedJob.current)return;
      polling=true;
      try{const next=await standard<Job>('get',{jobId:selectedJob.current});if(!stopped&&mounted.current&&activeId.current===id)setJob(next);}catch{/* The final request reports errors without discarding prior progress. */}finally{polling=false;}
    },2000);
    return()=>{stopped=true;clearInterval(timer);};
  },[busy,id]);

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
    setReviewed(false);
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
    if(name.includes('API')){apiStart.current=Date.now();setApiElapsed(0);}
    setBusy(name);
    setError("");
    setMessage("");
    try {
      await work();
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
    setReviewed(false);
    setPrompt("");
    setPart(1);
  }
  async function runApi(current: Job) {
    const forId = id;
    stopApi.current=false;
    if(current.method!=='api'||(current.partSize??20)>5){current=await standard<Job>('api_continuation',{jobId:current.id});setJob(current);selectedJob.current=current.id;}
    let latest = current;
    for (let next = 1; next <= current.totalParts; next++) {
      if(stopApi.current){setMessage('완료된 분할을 보관하고 멈췄습니다. 이어서 준비할 수 있습니다.');return;}
      if (activeId.current !== forId || !mounted.current) return;
      if (latest.parts?.some((item) => item.part === next && item.applied))
        continue;
      const result = await edgeCall("ai-request", {
        action: "run_standard",
        standardJobId: current.id,
        part: next,
      });
      latest = await standard<Job>("get", { jobId: current.id });
      await onRefresh();
      if (activeId.current !== forId || !mounted.current) return;
      setJob(latest);
      selectedJob.current = latest.id;
      if (
        result.result?.status !== "completed" &&
        !latest.parts?.some((item) => item.part === next && item.applied)
      ) {
        setMessage(
          "API 준비를 완료하지 못했습니다. 완료된 결과는 보관했습니다. 자료의 API 준비 결과에서 모델별 오류를 확인하고 이어서 실행할 수 있습니다.",
        );
        await loadJobs(current.id);
        return;
      }
    }
    await loadJobs(current.id);
    if (activeId.current === forId && mounted.current)
      setMessage(
        "저장된 결과를 불러왔습니다. 문항의 내용·정답·해설을 검토한 뒤 학습에 사용하세요.",
      );
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
      questionCount: preparationKind === "similar" ? 5 : preparationKind==='complete'?20:15,
      purposeCounts:
        preparationKind === "similar"
          ? { concept: 0, practice: 0, similar: 5 }
          : { concept: 5, practice: 10, similar: preparationKind==='complete'?5:0 },
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
      submitted = raw,
      data = parseRestudy(submitted);
    const preview = await standard<Preview>("preview", {
      jobId: job.id,
      raw: data,
    });
    if (activeId.current === forId && mounted.current) {
      setInspection({ preview, data, raw: submitted });
      setReviewed(false);
    }
  }
  async function importData() {
    if (!job || !inspection?.preview.valid || inspection.raw !== raw)
      throw new Error("현재 결과를 먼저 검사하고 미리보기를 확인해 주세요.");
    if (
      reviewed &&
      inspection.preview.counts.questions !== inspection.data.questions.length
    )
      throw new Error(
        "이전 분할을 포함한 문항은 검토 대기로 등록한 뒤 문제 은행에서 전체 내용을 검토해 주세요.",
      );
    const forId = id;
    const result = await standard<{
      job: Job;
      receivedParts: number;
      questions: number;
      ready: boolean;
    }>("import", {
      jobId: job.id,
      raw: inspection.data,
      previewHash: inspection.preview.hash,
      reviewed,
    });
    await onRefresh();
    if (activeId.current !== forId || !mounted.current) return;
    setJob(result.job);
    setRaw("");
    setInspection(undefined);
    setReviewed(false);
    setMessage(
      `${result.receivedParts}/${job.totalParts}분할 보관 · ${result.questions}문항 등록${!result.ready ? " · 다른 분할의 참조 대기" : reviewed ? " · 검토 완료" : " · 내용 검토 대기"}`,
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
      originalId: purpose==="similar"?undefined:id,
      questionIds: purpose==="similar"?[id]:[],
      purposes: mode==="memory"?[]:[purpose],
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
  const analysis = question.analysis;
  const memorized = distinct([
    ...strings(question.memorize),
    ...strings(analysis?.memorize),
  ]);
  const ready = concepts.length > 0;
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
            원본 PDF {formatPages(pages)}쪽
            {mistake ? ` · ${dueLabel(mistake.dueAt)} 복습` : ""}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => onViewer(question.materialId, question.page)}
        >
          <FileText size={15} />
          출처 보기
        </Button>
      </header>
      <ApiPreparationStatus job={job} running={busy.includes('API')} elapsed={apiElapsed} error={busy.includes('API')?'':error} onStop={()=>{stopApi.current=true;setMessage('현재 요청이 끝나면 완료된 결과를 보관하고 멈춥니다.');}}/>
      <div className="ww-layout">
        <div className="ww-main">
          <section className="ww-saved" aria-labelledby={`${fieldId}-concepts`}>
            <div className="ww-section-heading">
              <h2 id={`${fieldId}-concepts`}>관련 개념</h2>
              {ready ? (
                <Badge tone="indigo">저장된 개념 {concepts.length}개</Badge>
              ) : null}
            </div>
            {analysis?.key_point ? (
              <div className="ww-key-point">
                <h3>문제 해결의 핵심</h3>
                <p>{analysis.key_point}</p>
              </div>
            ) : null}
            {memorized.length ? (
              <div className="ww-question-memory">
                <h3>이 문제에서 기억할 내용</h3>
                <ul>
                  {memorized.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {ready ? (
              concepts.map((concept) => (
                <ConceptReading
                  key={concept.id}
                  concept={concept}
                  materials={state.materials}
                  onViewer={onViewer}
                />
              ))
            ) : (
              <div className="ww-unprepared">
                <BookOpen size={25} strokeWidth={1.5} />
                <h3>아직 연결된 개념 정리가 없습니다</h3>
                <p>
                  이 원본 문제의 개념과 개념 퀴즈 5개·연습문제 10개를 준비할 수
                  있습니다.
                </p>
                <div className="ww-actions">
                  <Button
                    disabled={!!busy}
                    busy={busy === "API 분석"}
                    onClick={() => act("API 분석", () => create("api"))}
                  >
                    API로 준비
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!!busy}
                    busy={busy === "외부 작업 준비"}
                    onClick={() =>
                      act("외부 작업 준비", () => create("external"))
                    }
                  >
                    외부 AI 결과 가져오기
                  </Button>
                </div>
              </div>
            )}
            {strings(analysis?.mistakes).length ? (
              <div className="ww-reading-group ww-analysis-cautions">
                <h3>확인할 조건·예상 실수</h3>
                <ul>
                  {strings(analysis?.mistakes).map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {conceptIds.length > concepts.length ? (
              <p className="ww-help">
                연결된 일부 개념을 찾을 수 없습니다. 콘텐츠 등록 상태를 확인해
                주세요.
              </p>
            ) : null}
          </section>
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
                  <option value="complete">한 번에 · 개념 5개 · 연습 10개 · 유사 5개</option>
                  <option value="review">개념 퀴즈 5개 · 연습문제 10개</option>
                  <option value="similar">이 원본과 연결된 유사문제 5개</option>
                </select>
              </label>
              <p className="ww-help">
                원본 {question.number}번 · PDF {formatPages(pages)}쪽을 기준으로
                개념 정리, 개념 퀴즈 5개와 연습문제 10개를 준비합니다. API
                분석은 실행 버튼을 누를 때만 요청합니다.
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
                    <h3>3. 결과 붙여넣기·검사</h3>
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
                          setReviewed(false);
                        }}
                      />
                    </label>
                    <Button
                      variant="secondary"
                      disabled={!!busy || !raw.trim()}
                      busy={busy === "JSON 검사"}
                      onClick={() => act("JSON 검사", inspect)}
                    >
                      검사·미리보기
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
                        {preview.valid ? (
                          <>
                            <PackageReview data={inspection.data} />
                            <label
                              className="ww-review-check"
                              htmlFor={`${fieldId}-reviewed`}
                            >
                              <input
                                id={`${fieldId}-reviewed`}
                                type="checkbox"
                                checked={reviewed}
                                disabled={
                                  !!busy ||
                                  !preview.ready ||
                                  preview.counts.questions !==
                                    inspection.data.questions.length
                                }
                                onChange={(event) =>
                                  setReviewed(event.target.checked)
                                }
                              />
                              <span>
                                미리보기에 표시된{" "}
                                {inspection.data.questions.length}문항의
                                내용·정답·해설을 모두 검토했습니다.
                              </span>
                            </label>
                            {preview.counts.questions !==
                            inspection.data.questions.length ? (
                              <p className="ww-help">
                                이전 분할을 포함한 문항은 검토 대기로 등록한 뒤
                                문제 은행에서 전체 내용을 검토하세요.
                              </p>
                            ) : null}
                            <Button
                              disabled={!!busy}
                              busy={busy === "분석 결과 등록"}
                              onClick={() => act("분석 결과 등록", importData)}
                            >
                              {!preview.ready
                                ? "분할 보관 · 참조 대기"
                                : reviewed
                                  ? "검토 완료로 등록·학습에 사용"
                                  : "검토 대기로 등록"}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                  <p className="ww-import-note">
                    붙여넣기·검사·등록은 AI API를 호출하지 않습니다. API 결과도
                    같은 restudy.v1 검증과 검토 절차를 사용합니다.
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
                          showPending: true,
                        })
                      }
                    >
                      등록 문항 검토
                      <ArrowRight size={13} />
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </details>
          {error ? (
            <p className="ww-feedback ww-error" role="alert">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="ww-feedback" role="status">
              <Check size={15} />
              {message}
            </p>
          ) : null}
        </div>
        <aside className="ww-side" aria-label="이 문제의 복습">
          <section className="ww-practice">
            <h2>저장된 문항으로 복습</h2>
            <p>이 문제에 연결된 개념과 문제만 고릅니다.</p>
            <Button
              disabled={!ready}
              onClick={() => onBank(bankScope("concept", 5, "check"))}
            >
              <BookOpen size={15} />
              개념 퀴즈 5문제
              <ArrowRight size={14} />
            </Button>
            <Button
              variant="secondary"
              disabled={!ready}
              onClick={() => onBank(bankScope("practice", 10))}
            >
              관련 연습문제 10문제
              <ArrowRight size={14} />
            </Button>
            <Button
              variant="secondary"
              disabled={!ready}
              onClick={() => onBank(bankScope("similar", 10))}
            >
              저장된 유사문제
              <ArrowRight size={14} />
            </Button>
            <Button
              variant="ghost"
              disabled={!ready}
              onClick={() => onBank(bankScope("concept", 10, "memory"))}
            >
              <Layers size={14} />
              암기하기
            </Button>
            <Button
              variant="ghost"
              disabled={!question.hasContent || !!busy}
              busy={busy === "개념 복습 시작"}
              onClick={() =>
                act("개념 복습 시작", async () => {
                  await onReview(id);
                })
              }
            >
              이해 확인 복습
            </Button>
            <small>
              문항이 부족하면 저장된 개수를 안내합니다. 추가 생성은 직접 선택할
              수 있습니다.
            </small>
          </section>
          <section className="ww-original">
            <h2>원본 문제</h2>
            <p>저장된 깨끗한 원본으로 다시 풉니다.</p>
            <Button
              variant="secondary"
              disabled={
                !question.regions.length || !question.imagePaths?.length || !!busy
              }
              busy={busy === "원본 다시 풀기"}
              onClick={() =>
                act("원본 다시 풀기", async () => {
                  await onSolve([id]);
                })
              }
            >
              <RotateCcw size={15} />
              원본 다시 풀기
            </Button>
            {!question.regions.length || !question.imagePaths?.length ? (
              <p className="ww-help">저장된 원본 크롭이 없습니다. 문항 영역을 저장해 주세요.</p>
            ) : null}
            <details>
              <summary>저장된 원본 보기</summary>
              <div className="ww-original-images">
                {question.regions.map((_, index) => (
                  <SecureImage
                    key={index}
                    path={`questions/${id}/image/${index}`}
                    alt={`${question.number}번 원본 문제${question.regions.length > 1 ? ` · 영역 ${index + 1}` : ""}`}
                    loading="lazy"
                  />
                ))}
              </div>
            </details>
          </section>
          {mistake ? (
            <section className="ww-history">
              <h2>이 문제의 기록</h2>
              <dl>
                <div>
                  <dt>원본 재풀이</dt>
                  <dd>{mistake.reviewCount || 0}회</dd>
                </div>
                <div>
                  <dt>원본 맞힘</dt>
                  <dd>{mistake.correctCount || 0}회</dd>
                </div>
                <div>
                  <dt>개념 이해</dt>
                  <dd>
                    {mistake.conceptState === "understood"
                      ? "확인됨"
                      : mistake.conceptState === "unregistered"
                        ? "개념 미등록"
                        : "복습 중"}
                  </dd>
                </div>
                <div>
                  <dt>다음 복습</dt>
                  <dd>{dueLabel(mistake.dueAt)}</dd>
                </div>
              </dl>
              {mistake.cause ? (
                <p className="ww-user-note">
                  <strong>내가 기록한 메모</strong>
                  {mistake.cause}
                </p>
              ) : null}
              <small>{dateLabel(mistake.createdAt)} 오답 등록</small>
            </section>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
