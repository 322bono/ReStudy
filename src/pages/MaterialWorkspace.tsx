import ContentReview from "../components/ContentReview";
import{aiFailureText}from"../domain/ai-status";
import LocalOutlineEditor from'../components/LocalOutlineEditor';
import { useEffect, useState, useRef } from "react";
import { api } from "../../lib/client";
import { Button, Empty } from "../../components/ui";
import { edgeCall } from "../services/supabase";
import {
  downloadSelectedPdf,
  updateMaterialRange,
} from "../services/documents";
import {
  createExternalPrompt,
  formatPages,
  parseRestudy,
} from "../domain/restudy";
import type { AppState, Material } from "../../lib/types";
const labels: Record<string, string> = {
  draft: "작업 준비됨",
  pending_refs: "다른 분할의 참조 대기",
  partial: "일부 분할 등록",
  needs_more: "추가 문항 필요",
  ready: "학습 가능",
  review_needed: "내용 검토 필요",
  completed: "완료",
  paused: "보류 · 직접 재개",
  waiting: "대기",
  running: "처리 중",
  failed: "확인 필요",
  retry_wait: "재시도 대기",
};
const standard = (action: string, body: any = {}) =>
  edgeCall("content-jobs", { action, ...body });
export default function MaterialWorkspace({
  id,
  state,
  onBack,
  onViewer,
  onBank,
  onError,
  onRefresh,
}: {
  id: string;
  state: AppState;
  onBack: () => void;
  onViewer: (page?: number, manage?: boolean) => void;
  onBank: (scope: any) => void;
  onError: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"concepts" | "external" | "scope">("concepts"),
    [doc, setDoc] = useState<Material>(),
    [jobs, setJobs] = useState<any[]>([]),
    [job, setJob] = useState<any>(),
    [busy, setBusy] = useState(""),
    [raw, setRaw] = useState(""),
    [preview, setPreview] = useState<any>(),
    [reviewed, setReviewed] = useState(false),
    [prompt, setPrompt] = useState(""),
    [part, setPart] = useState(1),
    [message, setMessage] = useState(""),
    [apiRunning,setApiRunning]=useState(false),
    [apiStartedAt,setApiStartedAt]=useState(0),
    [apiElapsed,setApiElapsed]=useState(0),
    [apiError,setApiError]=useState(''),
    [task, setTask] = useState("complete"),
    [questionCount, setQuestionCount] = useState(100),
    [conceptCount, setConceptCount] = useState(5),
    [practiceCount, setPracticeCount] = useState(5),
    [similarCount, setSimilarCount] = useState(0),
    [originalScope, setOriginalScope] = useState<"all" | "picked">("all"),
    [originalIds, setOriginalIds] = useState<string[]>([]),
    [chapter, setChapter] = useState(""),
    [types, setTypes] = useState(["mcq", "ox", "short", "blank"]),
    [typeCounts, setTypeCounts] = useState<Record<string, string>>({}),
    [ratio, setRatio] = useState({ easy: 20, medium: 50, hard: 30 }),
    [ranges, setRanges] = useState({
      analysisRange: "",
      excludedPages: "",
      tocRange: "",
      analysisMethod: "auto",
      printedPageOffset: "",
    });
  const currentJob = useRef<string | undefined>(undefined);
  const stopApi=useRef(false);
  useEffect(()=>()=>{stopApi.current=true;},[]);
  useEffect(()=>{if(!apiRunning)return;let stopped=false;const timer=setInterval(()=>{setApiElapsed(Math.floor((Date.now()-apiStartedAt)/1000));if(currentJob.current)void standard('get',{jobId:currentJob.current}).then(value=>{if(!stopped&&currentJob.current===value.id)setJob(value);}).catch(()=>{});},2000);return()=>{stopped=true;clearInterval(timer);};},[apiRunning,apiStartedAt]);
  const chapters = (state.chapters || []).filter((c) => c.materialId === id),
    concepts = state.concepts.filter(
      (c: any) =>
        c.sources?.some((s: any) => s.materialId === id) ||
        c.chapterIds?.some((cid: string) =>
          chapters.some((ch) => ch.id === cid),
        ),
    );
  const selectedChapter = chapters.find((c) => c.id === chapter),
    selectedPages = (
      doc?.selectedPages ||
      Array.from({ length: doc?.pageCount || 0 }, (_, i) => i + 1)
    ).filter(
      (p) =>
        !selectedChapter ||
        (p >= selectedChapter.startPage && p <= selectedChapter.endPage),
    ),
    scopedOriginals = state.questions
      .filter((q) => q.materialId === id && !q.mergedInto && selectedPages.includes(q.page))
      .sort((a, b) => a.page - b.page || a.number - b.number),
    targetOriginals =
      originalScope === "picked"
        ? scopedOriginals.filter((q) => originalIds.includes(q.id))
        : scopedOriginals,
    hasSavedImages = (q: (typeof state.questions)[number]) =>
      q.confirmed &&
      Array.isArray((q as any).imagePaths) &&
      (q as any).imagePaths.length > 0,
    apiProblemReady =
      targetOriginals.length > 0 &&
      targetOriginals.length <= 100 &&
      targetOriginals.every(hasSavedImages),
    resumeProblemReady =
      job?.taskType !== "problem" ||
      (job.targetQuestions?.length > 0 &&
        job.targetQuestions.every((t: any) =>
          state.questions.some((q) => q.id === t.id && hasSavedImages(q)),
        ));
  async function load(selectedId?: string) {
    const [d, list] = await Promise.all([
      api(`materials/${id}`),
      standard("list", { documentId: id }),
    ]);
    setDoc(d.material);
    setJobs(list.jobs);
    const found = selectedId || currentJob.current;
    if (found) setJob(await standard("get", { jobId: found }));
    else if (list.jobs[0])
      setJob(await standard("get", { jobId: list.jobs[0].id }));
    return d.material as Material;
  }
  useEffect(() => {
    let alive = true;
    load()
      .then((d) => {
        if (!alive) return;
        setRanges({
          analysisRange: d.analysisRange || "",
          excludedPages: d.excludedPages || "",
          tocRange: d.tocRange || "",
          analysisMethod: d.analysisMethod || "auto",
          printedPageOffset:
            d.printedPageOffset === undefined || d.printedPageOffset === null
              ? ""
              : String(d.printedPageOffset),
        });
        setTab(d.analysisMethod === "external" ? "external" : "concepts");
        setTask("complete");
        setSimilarCount(d.kind === "문제집" ? 5 : 0);
      })
      .catch((e) => onError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);
  useEffect(() => {
    if (!job) return;
    if (part > job.totalParts) {
      setPart(1);
      return;
    }
    try {
      setPrompt(createExternalPrompt(job, part));
    } catch (error) {
      setPrompt("");
      onError((error as Error).message);
    }
  }, [job, part]);
  const act = async (name: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setMessage("");
    if(name.includes('API')){setApiError('');setApiRunning(true);setApiStartedAt(Date.now());setApiElapsed(0);}
    try {
      await fn();
      await load();
      await onRefresh();
    } catch (e) {
      onError((e as Error).message);
      if(name.includes("API"))setApiError((e as Error).message);
    } finally {
      setBusy("");
      if(name.includes('API'))setApiRunning(false);
    }
  };
  async function create(method: "external" | "api") {
    if (!doc) return;
    if (
      task === "problem" &&
      originalScope === "picked" &&
      !targetOriginals.length
    )
      throw new Error(
        "분석할 원본 문제를 선택하세요. 인덱스 없이 분석하려면 선택 범위 전체를 이용하세요.",
      );
    if (task === "problem" && method === "api" && !apiProblemReady)
      throw new Error(
        "API 분석에는 확인된 원본 이미지가 있는 문제를 1~100개 선택하세요. 인덱스가 없으면 원본 PDF를 외부 AI에 첨부하세요.",
      );
    const totalQuestions =
      (task === "problem" || task === "complete")
        ? conceptCount + practiceCount + similarCount
        : questionCount;
    const created = await standard("create", {
      documentId: id,
      method,
      taskType: task,
      selectedPages,
      tocPages: doc.tocPages || [],
      questionCount: totalQuestions,
      conceptQuestionCount: conceptCount,
      practiceQuestionCount: practiceCount,
      ...(["problem","complete"].includes(task)
        ? {
            purposeCounts: {
              concept: conceptCount,
              practice: practiceCount,
              similar: similarCount,
            },
            ...(task === "problem" && (originalScope === "picked" || method === "api")
              ? { questionIds: targetOriginals.map((q) => q.id) }
              : {}),
          }
        : {}),
      questionTypes: types,
      ...(task !== "toc" && Object.values(typeCounts).some((v) => v !== "")
        ? {
            questionTypeCounts: Object.fromEntries(
              types.map((kind) => [kind, Number(typeCounts[kind] || 0)]),
            ),
          }
        : {}),
      difficultyDistribution: ratio,
      ...(chapter ? { chapterIds: [chapter] } : {}),
    });
    currentJob.current = created.id;
    setJob(created);
    setJobs((current) => [created, ...current]);
    setPart(1);
    setRaw("");
    setPreview(undefined);
    setPrompt("");
    setTab("external");
    setMessage(`${created.totalParts}개 분할 작업을 준비했습니다.`);
    if(method==="external"){const issued=createExternalPrompt(created,1);setPrompt(issued);try{await navigator.clipboard.writeText(issued);setMessage("통합 프롬프트를 복사했습니다. PDF와 함께 외부 AI에 입력하고, 결과 JSON을 아래에 붙여넣으세요.");}catch{setMessage("통합 프롬프트를 준비했습니다. 아래 프롬프트 복사를 눌러 주세요.");}}
    if (method === "api") await run(created);
  }
  async function run(current = job) {
    if (!current) return;
    setApiError('');setApiRunning(true);setApiStartedAt(Date.now());setApiElapsed(0);
    stopApi.current=false;
    try{
    if(current.method!=='api'||current.partSize>5){current=await standard('api_continuation',{jobId:current.id});currentJob.current=current.id;setJob(current);setJobs(all=>[current,...all.filter(j=>j.id!==current.id)]);}
    let requested = false;
    for (let next = 1; next <= current.totalParts; next++) {
      if(stopApi.current){setMessage('완료된 분할을 보관하고 API 준비를 멈췄습니다. 이어서 준비하면 남은 분할부터 진행합니다.');return;}
      if (current.parts?.some((p: any) => p.part === next && p.applied))
        continue;
      const result = await edgeCall("ai-request", {
        action: "run_standard",
        standardJobId: current.id,
        part: next,
      });
      requested = true;
      await load(current.id);
      await onRefresh();
      if (result.result?.status !== "completed") {
        setMessage(
          result.result?.provider_error||result.result?.last_error ? aiFailureText(result.result.provider_error??result.result.last_error) : result.result?.message || '작업이 대기 중입니다. 저장된 진행 상황을 확인하세요.',
        );
        return;
      }
    }
    setMessage(
      requested
        ? "API 결과를 저장했습니다. 내용을 검토한 뒤 학습에 사용하세요."
        : "등록된 결과를 재사용합니다.",
    );
    }catch(error){setApiError(error instanceof Error?error.message:'API 준비를 완료하지 못했습니다.');if(current?.id)await load(current.id);throw error;}finally{setApiRunning(false);if(current?.id)await load(current.id);}
  }
  async function inspect() {
    if (!job) return;
    const parsed = parseRestudy(raw);
    const result = await standard("preview", { jobId: job.id, raw: parsed });
    setPreview(result);
    setReviewed(false);
  }
  async function importData() {
    if (!job || !preview?.valid) return;
    const result = await standard("import", {
      jobId: job.id,
      raw: parseRestudy(raw),
      previewHash: preview.hash,
      reviewed,
    });
    setJob(result.job);
    setMessage(
      `${result.receivedParts}/${job.totalParts} 분할 보관 · ${result.questions}문항 등록${result.ready ? "" : " · 참조 대기"}`,
    );
    setRaw("");
    setPreview(undefined);
    setReviewed(false);
    await load(job.id);
    await onRefresh();
  }
  if (!doc) return <div className="loading">자료를 여는 중…</div>;
  return (
    <>
      <div className="page-heading">
        <div>
          <button className="text-button" onClick={onBack}>
            내 자료로
          </button>
          <h1>{doc.title}</h1>
          <p>
            {doc.subject} · 원본 PDF {doc.pageCount}쪽 · 분석 범위{" "}
            {formatPages(doc.selectedPages || []) || "전체"}
          </p>
        </div>
        <div className="row">
          <Button variant="secondary" onClick={() => onViewer(doc.selectedPages?.[0]??1)}>
            PDF 열기
          </Button>
          <Button onClick={() => onBank({ materialIds: [id] })}>
            문제 은행
          </Button>
        </div>
      </div>
      <details className="panel" style={{padding:16,marginBottom:16}}>
        <summary>PDF 인식 · {state.questions.filter(q=>q.materialId===id&&!q.mergedInto).length}문항 · 검토 {state.questions.filter(q=>q.materialId===id&&!q.mergedInto&&!q.confirmed).length}개</summary>
        <p className="field-help">{doc.message || '저장된 원본과 인식 결과를 사용합니다.'}</p>
        {['uploaded','processing'].includes(doc.status)&&<progress aria-label="PDF 분석 진행률" value={doc.progress||0} max={100}/>}
        {doc.error&&<p className="error" role="alert">{doc.error}</p>}
        <div className="row"><Button variant="secondary" busy={!!busy} onClick={()=>act('문항 다시 인식',async()=>{await api(`materials/${id}/reindex`,'POST');setMessage('저장된 본문을 재사용해 문항을 다시 인식합니다.');})}>문항 다시 인식</Button><Button variant="ghost" onClick={()=>onViewer(doc.selectedPages?.[0]??1,true)}>크롭 검토·수정</Button>{doc.failedPage&&<Button variant="secondary" busy={!!busy} onClick={()=>act('실패 페이지 재시도',async()=>{await api(`materials/${id}/retry`,'POST',{page:doc.failedPage});})}>PDF {doc.failedPage}쪽만 재시도</Button>}</div>
      </details>
      <div className="tabs content-tabs">
        <button
          className={tab === "concepts" ? "active" : ""}
          onClick={() => setTab("concepts")}
        >
          목차·개념
        </button>
        <button
          className={tab === "external" ? "active" : ""}
          onClick={() => setTab("external")}
        >
          콘텐츠 준비·가져오기
        </button>
        <button
          className={tab === "scope" ? "active" : ""}
          onClick={() => setTab("scope")}
        >
          처리 범위
        </button>
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {(apiRunning||apiError||job?.apiJobs?.length||job?.apiStatus?.state==='paused')&&<section className="panel" aria-live="polite" style={{padding:16,marginBottom:16}}><h2>API 준비 결과</h2><p role={apiError?'alert':'status'} className={apiError?'error':''}>{apiError||(apiRunning&&job?.apiStatus?.state!=='running'?'API 요청을 준비하고 있습니다. 완료된 결과는 보관됩니다.':job?.apiStatus?.message)||'API 요청을 시작하고 있습니다.'}</p><p>저장된 결과 {job?.apiStatus?.completed??0}/{job?.totalParts??0}분할 · 응답 보관 {job?.preparedQuestions??0}문항 · 은행 등록 {job?.importedQuestions??0}문항{apiRunning?` · 경과 ${apiElapsed}초`:''}</p>{apiRunning&&<progress aria-label="API 분할 진행률" max={job?.totalParts||1} value={job?.apiStatus?.completed||0}/>}{apiRunning&&<Button variant="secondary" onClick={()=>{stopApi.current=true;setMessage("현재 요청이 끝나면 완료된 결과를 보관하고 멈춥니다.");}}>현재 분할 후 멈추기</Button>}<details><summary>최근 시도와 오류</summary>{(job?.apiAttempts??[]).map((a:any,i:number)=><p key={i}>{a.provider} · {a.model} · {Math.round((a.duration_ms??0)/1000)}초 · {a.success?'유효한 응답 수신':aiFailureText(a.error)}</p>)}{!job?.apiAttempts?.length&&<p>아직 모델 호출 이력이 없습니다. 원본·요청 범위를 확인하거나 첫 응답을 기다리는 단계입니다.</p>}</details>{job?.preparedPreview?.length>0&&<details><summary>최근 보관한 결과 보기 · 검토 전</summary>{job.preparedPreview.map((q:any,i:number)=><article key={i} style={{marginTop:16}}><strong>{q.part}분할 · {q.prompt}</strong><p>정답: {q.answer}</p><p>{q.explanation}</p></article>)}</details>}</section>}
      {tab === "concepts" && (
        <>
          <LocalOutlineEditor outline={doc.localOutline} pageCount={doc.pageCount} sourcePage={doc.tocPages?.[0]??doc.selectedPages?.[0]??1} busy={!!busy} onSave={outline=>act('자체 목차 저장',async()=>{await api(`materials/${id}/outline`,'POST',{outline,manual:true});})}/>
          <div className="section-heading">
            <h2>
              단원 {chapters.length}개 · 개념 {concepts.length}개
            </h2>
            <Button
              variant="secondary"
              onClick={() => {
                setTask(chapters.length ? "initial" : "toc");
                setTab("external");
              }}
            >
              {chapters.length ? "기본 퀴즈·연습문제 준비" : "목차부터 준비"}
            </Button>
          </div>
          {!chapters.length && (
            <Empty
              title="아직 준비된 단원이 없습니다"
              description="처리 범위에서 목차 페이지를 지정하고 문항 다시 인식을 실행하거나, 목차를 직접 입력하세요."
            />
          )}
          {chapters.map((ch) => (
            <details className="panel chapter-panel" key={ch.id} open>
              <summary>
                {ch.title}{" "}
                <small>
                  PDF {ch.startPage}–{ch.endPage}쪽
                </small>
              </summary>
              <div className="row">
                <button
                  className="text-button"
                  onClick={() => onViewer(ch.startPage)}
                >
                  출처 보기
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    onBank({ materialIds: [id], chapterIds: [ch.id] })
                  }
                >
                  이 단원 문제 은행
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    setChapter(ch.id);
                    setTask("initial");
                    setTab("external");
                  }}
                >
                  기본 콘텐츠 추가
                </button>
              </div>
              {concepts
                .filter(
                  (c: any) =>
                    c.chapterIds?.includes(ch.id) || c.chapterId === ch.id,
                )
                .map((c: any) => (
                  <article className="concept-reading" key={c.id}>
                    <h3>{c.name}</h3>
                    {c.evidence === "toc_only" && (
                      <small className="review-label">
                        목차 기준 · 본문 추가 확인 필요
                      </small>
                    )}
                    <p>{c.definition}</p>
                    {!!c.formulas?.length && (
                      <>
                        <strong>공식·조건</strong>
                        <ul>
                          {c.formulas.map((v: string, i: number) => (
                            <li key={i}>{v}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {!!c.memorize?.length && (
                      <>
                        <strong>암기사항</strong>
                        <ul>
                          {c.memorize.map((v: string, i: number) => (
                            <li key={i}>{v}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {!!c.pitfalls?.length && (
                      <details>
                        <summary>주의할 점</summary>
                        <ul>
                          {c.pitfalls.map((v: string, i: number) => (
                            <li key={i}>{v}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <div className="row">
                      <button
                        className="text-button"
                        onClick={() =>
                          onBank({
                            materialIds: [id],
                            conceptIds: [c.id],
                            purposes: ["concept"],
                          })
                        }
                      >
                        개념 퀴즈
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          onBank({
                            materialIds: [id],
                            conceptIds: [c.id],
                            mode: "memory",
                          })
                        }
                      >
                        암기하기
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          onBank({ materialIds: [id], conceptIds: [c.id] })
                        }
                      >
                        연습문제
                      </button>
                    </div>
                  </article>
                ))}
              <details>
                <summary>목차 이름·범위 수정</summary>
                <ChapterEditor
                  chapter={ch}
                  busy={!!busy}
                  onSave={(b) =>
                    act("목차 저장", async () => {
                      await api(`chapters/${ch.id}`, "PATCH", b);
                    })
                  }
                />
              </details>
            </details>
          ))}
        </>
      )}
      {tab === "external" && (
        <>
          <p className="notice">
            개념 정리·원본 문제 분석·퀴즈·문제 은행을 한 작업으로 준비합니다. API로 실행하거나, 통합 프롬프트를 외부 AI에 입력한 뒤 결과 JSON을 한 번에 가져오세요.
          </p>
          <section className="panel content-job-setup">
            <h2>준비할 콘텐츠</h2>
            <div className="form-grid">
              <label>
                작업
                <select value={task} onChange={(e) => setTask(e.target.value)}>
                  <option value="complete">통합 준비 · 개념·문제 분석·퀴즈·은행</option>
                  <option value="toc">목차·단원 구조만</option>
                  <option value="initial">단원 기본 개념·퀴즈·연습문제</option>
                  <option value="bank">추가 문제 은행</option>
                  <option value="problem">문제별 개념 연결·퀴즈·은행</option>
                </select>
              </label>
              <label>
                단원
                <select
                  value={chapter}
                  onChange={(e) => {
                    setChapter(e.target.value);
                    setOriginalIds([]);
                  }}
                >
                  <option value="">선택 범위 전체</option>
                  {chapters.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              {["initial","problem","complete"].includes(task) ? (
                <>
                  <label>
                    개념 퀴즈 수
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={conceptCount}
                      onChange={(e) => setConceptCount(+e.target.value)}
                    />
                  </label>
                  <label>
                    기본 연습문제 수
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={practiceCount}
                      onChange={(e) => setPracticeCount(+e.target.value)}
                    />
                  </label>
                  {["problem","complete"].includes(task) && (
                    <label>
                      유사문제 수
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        value={similarCount}
                        onChange={(e) => setSimilarCount(+e.target.value)}
                      />
                    </label>
                  )}
                </>
              ) : task === "bank" ? (
                <label>
                  전체 문제 수
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={questionCount}
                    onChange={(e) => setQuestionCount(+e.target.value)}
                  />
                </label>
              ) : null}
            </div>
            {task === "problem" && (
              <fieldset className="editor-fieldset">
                <legend>개념을 연결할 원본 문제</legend>
                <label className="cloud-check">
                  <input
                    type="radio"
                    name="original-scope"
                    checked={originalScope === "all"}
                    onChange={() => setOriginalScope("all")}
                  />
                  선택 PDF 범위의 원본 전체 · 인식된 문제{" "}
                  {scopedOriginals.length}개
                </label>
                <label className="cloud-check">
                  <input
                    type="radio"
                    name="original-scope"
                    checked={originalScope === "picked"}
                    onChange={() => setOriginalScope("picked")}
                  />
                  인식된 번호에서 직접 선택 ·{" "}
                  {
                    scopedOriginals.filter((q) => originalIds.includes(q.id))
                      .length
                  }
                  개
                </label>
                {originalScope === "picked" &&
                  scopedOriginals.map((q) => (
                    <label className="cloud-check" key={q.id}>
                      <input
                        type="checkbox"
                        checked={originalIds.includes(q.id)}
                        disabled={
                          !originalIds.includes(q.id) &&
                          originalIds.length >= 100
                        }
                        onChange={(e) =>
                          setOriginalIds((current) =>
                            e.target.checked
                              ? [...current, q.id]
                              : current.filter((v) => v !== q.id),
                          )
                        }
                      />
                      {q.number}번 · PDF {q.page}쪽{" "}
                      {hasSavedImages(q)
                        ? "· 원본 이미지 준비됨"
                        : "· 영역 확인 필요"}
                    </label>
                  ))}
                <p className="field-help">
                  전체 범위의 외부 분석은 아직 인식되지 않은 문제도 PDF의 실제
                  번호·쪽수로 가져올 수 있습니다. 원본 영역이 없는 연결은
                  보관하며, 인덱스 확인 후 원본과 연결합니다. 직접 선택과 API
                  분석은 한 작업당 100개까지입니다.
                </p>
                {originalScope === "picked" && !scopedOriginals.length && (
                  <p>
                    인식된 번호가 없습니다. 선택 범위 전체로 외부 분석하거나
                    원본 영역을 먼저 확인하세요.
                  </p>
                )}
                <p>
                  생성할 은행 문항 합계{" "}
                  {conceptCount + practiceCount + similarCount}개 · 원본 분석
                  개수와 별도로 계산합니다.
                </p>
                {!apiProblemReady && (
                  <p className="field-help">
                    API 분석은 선택한 모든 문제의 깨끗한 원본 이미지가 저장된 뒤
                    사용할 수 있습니다. 현재는 PDF를 첨부하는 외부 분석을 이용할
                    수 있습니다.
                  </p>
                )}
              </fieldset>
            )}
            {task !== "toc" && (
              <details><summary>문제 유형·난이도 설정</summary>
                <fieldset className="inline-options">
                  <legend>문제 형식</legend>
                  {Object.entries({
                    mcq: "객관식",
                    ox: "OX",
                    short: "단답형",
                    blank: "빈칸",
                  }).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={types.includes(key)}
                        onChange={() =>
                          setTypes((current) =>
                            current.includes(key)
                              ? current.filter((v) => v !== key)
                              : [...current, key],
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <details>
                  <summary>형식별 개수 지정</summary>
                  <div className="form-grid">
                    {types.map((kind) => (
                      <label key={kind}>
                        {
                          {
                            mcq: "객관식",
                            ox: "OX",
                            short: "단답형",
                            blank: "빈칸",
                          }[kind]
                        }{" "}
                        개수
                        <input
                          type="number"
                          min={0}
                          placeholder="자동"
                          value={typeCounts[kind] || ""}
                          onChange={(e) =>
                            setTypeCounts((current) => ({
                              ...current,
                              [kind]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <p className="field-help">
                    지정할 때는 전체 문제 수와 합을 맞추세요.
                  </p>
                </details>
                <div className="form-grid">
                  {Object.entries({ easy: "하", medium: "중", hard: "상" }).map(
                    ([key, label]) => (
                      <label key={key}>
                        {label} 비율 (%)
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={ratio[key as keyof typeof ratio]}
                          onChange={(e) =>
                            setRatio((current) => ({
                              ...current,
                              [key]: +e.target.value,
                            }))
                          }
                        />
                      </label>
                    ),
                  )}
                </div>
              </details>
            )}
            <p className="field-help">
              통합 준비는 개념·원본 분석·퀴즈·문제 은행을 한 JSON에 함께 담습니다. API는 최대 5문항, 외부 AI는 최대 20문항씩 저장하며 완료된 분할은 재사용합니다.
            </p>
            <div className="row">
              <Button
                variant="secondary"
                busy={!!busy}
                disabled={
                  task === "problem" &&
                  originalScope === "picked" &&
                  !targetOriginals.length
                }
                onClick={() => act("외부 작업 준비", () => create("external"))}
              >
                외부 AI로 한 번에 준비
              </Button>
              <Button
                busy={!!busy}
                disabled={task === "problem" && !apiProblemReady}
                onClick={() => act("API 분석", () => create("api"))}
              >
                API로 준비
              </Button>
            </div>
          </section>
          {!!jobs.length && (
            <label className="cloud-field">
              이어갈 작업
              <select
                value={job?.id || ""}
                onChange={(e) =>
                  act("작업 열기", async () => {
                    currentJob.current = e.target.value;
                    setJob(await standard("get", { jobId: e.target.value }));
                    setPrompt("");
                    setRaw("");
                    setPreview(undefined);
                    setPart(1);
                  })
                }
              >
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.taskType === "toc"
                      ? "목차"
                      : j.taskType === "initial"
                        ? "기본 콘텐츠"
                        : j.taskType === "problem"
                          ? "문제별 개념 연결·퀴즈·은행"
                          : "문제 은행"}{" "}
                    · {j.questionCount}문제 · {labels[j.status] || j.status}
                  </option>
                ))}
              </select>
            </label>
          )}
          {job && (
            <section className="panel external-import">
              <div className="section-heading">
                <h2>외부 결과 가져오기</h2>
                <small>
                  {job.receivedParts || 0}/{job.totalParts} 분할 · 등록{" "}
                  {job.importedQuestions || 0}문항 ·{" "}
                  {labels[job.status] || job.status}
                </small>
              </div>
              <div className="external-step">
                <h3>1. 현재 작업의 프롬프트를 복사하세요.</h3>
                <p>
                  실제 문서·작업 ID, 선택 범위와 전체 JSON 형식이 포함되어
                  있습니다. 분할마다 해당 프롬프트를 사용하세요.
                </p>
                <div className="row">
                  <label>
                    현재 분할
                    <select
                      value={part}
                      onChange={(e) => {
                        setPart(+e.target.value);
                        setPrompt("");
                      }}
                    >
                      {Array.from({ length: job.totalParts }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {i + 1} / {job.totalParts}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    busy={!!busy}
                    onClick={() =>
                      act("프롬프트 복사", async () => {
                        if (!prompt)
                          throw new Error(
                            "프롬프트를 준비하지 못했습니다. 작업을 다시 열어 주세요.",
                          );
                        await navigator.clipboard.writeText(prompt);
                        setMessage("프롬프트를 복사했습니다.");
                      })
                    }
                  >
                    프롬프트 복사
                  </Button>
                  <Button
                    variant="ghost"
                    busy={!!busy}
                    disabled={!resumeProblemReady}
                    onClick={() => act("API 작업 재개", () => run(job))}
                  >
                    API로 이어서 준비
                  </Button>
                </div>
                <label>
                  외부 AI에 전달할 프롬프트
                  <textarea
                    aria-label="외부 AI 프롬프트"
                    className="json-preview"
                    readOnly
                    value={prompt}
                    rows={12}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
                {!resumeProblemReady && (
                  <p className="field-help">
                    이 작업은 저장된 원본 이미지 대상이 없어 API로 이어갈 수
                    없습니다. PDF와 프롬프트를 외부 AI에 함께 입력하세요.
                  </p>
                )}
              </div>
              <div className="external-step">
                <h3>2. 원본 PDF와 프롬프트를 외부 AI에 함께 입력하세요.</h3>
                <p>
                  처음 등록한 원본 PDF 전체를 첨부하는 방법을 권장합니다. 선택
                  범위만 첨부하면 프롬프트의 첨부본→원본 PDF 쪽수 대응표를 함께
                  전달하세요. 책에 인쇄된 쪽수와 PDF 실제 쪽수는 구별합니다.
                </p>
                <div className="row">
                  <Button
                    variant="secondary"
                    busy={!!busy}
                    onClick={() =>
                      act("원본 PDF 내보내기", async () => {
                        await downloadSelectedPdf(
                          id,
                          Array.from(
                            { length: job.pageCount },
                            (_, i) => i + 1,
                          ),
                        );
                        setMessage(
                          "원본 전체 PDF를 저장했습니다. 외부 AI에 프롬프트와 함께 첨부하세요.",
                        );
                      })
                    }
                  >
                    원본 전체 PDF 내보내기
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      act("범위 PDF 내보내기", async () => {
                        await downloadSelectedPdf(id, job.selectedPages);
                        setMessage("선택 범위 PDF를 저장했습니다.");
                      })
                    }
                  >
                    분석 범위 PDF 내보내기
                  </Button>
                  {job.tocPages.length > 0 && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        act("목차 PDF 내보내기", async () => {
                          await downloadSelectedPdf(id, job.tocPages);
                        })
                      }
                    >
                      목차 PDF 내보내기
                    </Button>
                  )}
                </div>
              </div>
              <div className="external-step">
                <h3>3. 결과 JSON을 붙여넣고 검사·검토·등록하세요.</h3>
                <p>
                  JSON 전체 또는 바깥쪽 JSON 코드 블록을 그대로 입력하세요.
                  분할을 하나씩 등록하면 원본별 연결, 개념 퀴즈, 연습·유사문제를
                  같은 형식으로 병합합니다.
                </p>
                <textarea
                  aria-label="분석 결과 붙여넣기"
                  placeholder="restudy.v1 JSON 또는 JSON 코드 블록"
                  rows={10}
                  value={raw}
                  onChange={(e) => {
                    setRaw(e.target.value);
                    setPreview(undefined);
                    setReviewed(false);
                  }}
                />
                <div className="row">
                  <Button
                    variant="secondary"
                    disabled={!raw.trim()}
                    busy={!!busy}
                    onClick={() => act("JSON 검사", inspect)}
                  >
                    검사·미리보기
                  </Button>
                </div>
                {preview && (
                  <div className="json-import-preview">
                    <p>
                      {preview.counts.questions}문항 · 개념{" "}
                      {preview.counts.concepts}개 · {preview.counts.parts}/
                      {preview.counts.totalParts}분할
                    </p>
                    {preview.errors.map((v: string, i: number) => (
                      <p className="error" role="alert" key={i}>
                        {v}
                      </p>
                    ))}
                    {preview.warnings.map((v: string, i: number) => (
                      <p className="notice" key={i}>
                        {v}
                      </p>
                    ))}
                    {preview.valid && (
                      <>
                        <ContentReview content={preview.review} />
                        <label className="cloud-check">
                          <input
                            type="checkbox"
                            checked={reviewed}
                            disabled={!preview.ready}
                            onChange={(e) => setReviewed(e.target.checked)}
                          />
                          현재 병합된 {preview.counts.questions}문항의
                          내용·정답·해설을 모두 검토했습니다.
                        </label>
                        <Button
                          busy={!!busy}
                          onClick={() => act("분할 등록", importData)}
                        >
                          {!preview.ready
                            ? "분할 보관 · 참조 대기"
                            : reviewed
                              ? "검토 완료로 등록·학습에 사용"
                              : "검토 대기로 등록"}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <p className="field-help">
                붙여넣기·검사·등록 과정은 AI API를 호출하지 않습니다. 등록한
                데이터는 일반 학습과 오답 복습에서 함께 사용합니다.
              </p>
            </section>
          )}
        </>
      )}
      {tab === "scope" && (
        <section className="panel scope-editor">
          <h2>분석할 페이지</h2>
          <p className="field-help">
            원본 전체는 보존됩니다. 범위를 바꾸면 저장된 페이지와 문항을
            유지하고 추가 페이지부터 처리합니다.
          </p>
          <div className="form-grid">
            {[
              ["analysisRange", "분석 범위"],
              ["excludedPages", "제외할 페이지"],
              ["tocRange", "목차 페이지"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  placeholder={
                    key === "analysisRange"
                      ? "전체 · 예: 15-48, 62-90"
                      : "예: 3-6"
                  }
                  value={(ranges as any)[key]}
                  onChange={(e) =>
                    setRanges((current) => ({
                      ...current,
                      [key]: e.target.value,
                    }))
                  }
                />
              </label>
            ))}
            <label>
              PDF 쪽수와 책 쪽수 차이
              <input
                type="number"
                placeholder="미지정"
                value={ranges.printedPageOffset}
                onChange={(e) =>
                  setRanges((current) => ({
                    ...current,
                    printedPageOffset: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          <p>
            PDF {doc.pageCount}쪽 · {doc.message}
          </p>
          <div className="row">
            <Button
              busy={!!busy}
              onClick={() =>
                act("범위 저장", async () => {
                  await updateMaterialRange(id, {
                    ...ranges,
                    printedPageOffset:
                      ranges.printedPageOffset === ""
                        ? null
                        : Number(ranges.printedPageOffset),
                  });
                  setMessage(
                    "새 범위를 저장했습니다. 추가 페이지부터 처리합니다.",
                  );
                })
              }
            >
              범위 저장·추가 페이지 처리
            </Button>
            <Button variant="secondary" onClick={() => onViewer(1, true)}>
              원본 영역 관리
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
function ChapterEditor({
  chapter,
  busy,
  onSave,
}: {
  chapter: any;
  busy: boolean;
  onSave: (body: any) => void;
}) {
  const [title, setTitle] = useState(chapter.title),
    [start, setStart] = useState(chapter.startPage),
    [end, setEnd] = useState(chapter.endPage);
  return (
    <div className="form-grid chapter-editor">
      <label>
        단원 이름
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        시작 PDF 페이지
        <input
          type="number"
          min={1}
          value={start}
          onChange={(e) => setStart(+e.target.value)}
        />
      </label>
      <label>
        끝 PDF 페이지
        <input
          type="number"
          min={start}
          value={end}
          onChange={(e) => setEnd(+e.target.value)}
        />
      </label>
      <Button
        busy={busy}
        onClick={() => onSave({ title, startPage: start, endPage: end })}
      >
        목차 저장
      </Button>
    </div>
  );
}
