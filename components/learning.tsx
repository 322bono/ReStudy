import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Layers,
  ListChecks,
  Lightbulb,
  RotateCcw,
} from "lucide-react";
import { api } from "../lib/client";
import { studyInventory } from '../src/domain/study-inventory';
import { selectPages } from '../src/domain/pages';
import type { AppState, StudyItem, StudyMode, StudySession } from "../lib/types";
import { Badge, Button, Empty, IconButton, Sources } from "./ui";
const modes = [
  {
    key: "quiz",
    title: "문제 풀기",
    description: "등록된 문제를 풀고 해설을 확인해요.",
    icon: ListChecks,
  },
  {
    key: "memory",
    title: "개념 암기",
    description: "카드와 문장 가리기로 기억을 확인해요.",
    icon: Layers,
  },
  {
    key: "check",
    title: "개념 확인",
    description: "준비된 질문으로 이해를 점검해요.",
    icon: Lightbulb,
  },
] as const;
export function StudySetup({
  state,
  initialIds,
  onStart,
  onOpen,
  onBank,
  onMaterial,
  onError,
}: {
  state: AppState;
  initialIds: string[];
  onStart: (id: string) => void;
  onOpen: (id: string, page?: number) => void;
  onBank:(scope:any)=>void;
  onMaterial:(id:string)=>void;
  onError: (s: string) => void;
}) {
  const firstSubject =
    state.materials.find((m) => initialIds.includes(m.id))?.subject ||
    state.materials[0]?.subject ||
    "";
  const [subject, setSubject] = useState(firstSubject),
    [selected, setSelected] = useState(
      (initialIds.length?initialIds:state.materials.map(m=>m.id)).filter(
        (id) =>
          state.materials.find((m) => m.id === id)?.subject === firstSubject,
      ),
    ),
    [ranges, setRanges] = useState<Record<string, string>>({}),
    [mode, setMode] = useState<StudyMode>("quiz"),
    [type, setType] = useState("전체"),
    [count, setCount] = useState(5),
    [difficulty, setDifficulty] = useState("전체"),
    [inventory,setInventory]=useState<any[]|null>(null),
    [showAllConcepts,setShowAllConcepts]=useState(false),
    [busy, setBusy] = useState(false),
    [weak, setWeak] = useState(0);
  useEffect(() => {
    let alive = true;
    setInventory(null);
    api('bank/list','POST')
      .then((result) => {
        if (!alive) return;
        const attempted = new Set(result.results?.map((item: { bankItemId: string }) => item.bankItemId));
        setInventory(result.items.map((item: { id: string }) => ({ ...item, attempted: attempted.has(item.id) })));
      })
      .catch(e=>{ if (alive) onError(e.message); });
    api("study/weak")
      .then((r) => { if (alive) setWeak(r.count); })
      .catch(() => {});
    return () => { alive = false; };
  }, [state]);
  useEffect(() => {
    if (state.materials.some(m => m.subject === subject)) return;
    const nextSubject = state.materials[0]?.subject || "";
    setSubject(nextSubject);
    setSelected(state.materials.filter(m => m.subject === nextSubject).map(m => m.id));
  }, [state.materials, subject]);
  const start = async (repeat = false) => {
    setBusy(true);
    try {
      const s = await api<StudySession>(
        repeat ? "study/repeat" : "study",
        "POST",
        repeat
          ? undefined
          : {
              materials: selected.map((id) => ({
                id,
                pages: ranges[id] || "",
              })),
              mode,
              type: mode === "memory" ? "전체" : type,
              count,
              difficulty,
            },
      );
      onStart(s.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const subjects = [...new Set(state.materials.map((m) => m.subject))];
  const materials = state.materials.filter((m) => m.subject === subject);
  let scopeError='';
  const scopes=selected.map(id=>{try{return{id,pages:selectPages(ranges[id]||'',state.materials.find(m=>m.id===id)!.pageCount)}}catch(e){scopeError=(e as Error).message;return{id,pages:[]}}});
  const counts=studyInventory(inventory||[],{materials:scopes,mode,type,difficulty}),available=counts.available;
  const concepts=state.concepts.filter(c=>c.subject===subject&&c.sources?.some(s=>selected.includes(s.materialId)));
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">자료 기반 학습</div>
          <h1>학습하기</h1>
          <p>저장된 개념을 읽거나 문제·암기 카드로 복습하세요.</p>
        </div>
        {weak > 0 && (
          <Button variant="secondary" onClick={() => start(true)} busy={busy}>
            <RotateCcw size={15} />
            다시 볼 개념 {weak}개
          </Button>
        )}
      </div>
      <div className="study-layout">
        <section>
          <div className="section-heading">
            <h2>
              <span className="section-number">1</span>학습 범위
            </h2>
            <select
              aria-label="학습 과목"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setSelected(state.materials.filter(m=>m.subject===e.target.value).map(m=>m.id));
              }}
            >
              {!subjects.length && <option value="">자료 없음</option>}
              {subjects.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="panel study-materials">
            {materials.length ? (
              materials.map((m) => (
                <div
                  className={`study-material ${selected.includes(m.id) ? "selected" : ""}`}
                  key={m.id}
                >
                  <label className="study-material-label">
                    <input
                      type="checkbox"
                      checked={selected.includes(m.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, m.id]
                            : selected.filter((id) => id !== m.id),
                        )
                      }
                    />
                    <span className="study-file-icon">
                      <BookOpen size={19} />
                    </span>
                    <span>
                      <strong>{m.title}</strong>
                      <small>
                        {m.subject} · {m.pageCount}쪽
                      </small>
                    </span>
                  </label>
                  {selected.includes(m.id) && (
                    <div className="range-field">
                      <input
                        aria-label={`${m.title} 페이지 범위`}
                        placeholder="전체 페이지 · 예: 1-5, 8"
                        value={ranges[m.id] || ""}
                        onChange={(e) =>
                          setRanges({ ...ranges, [m.id]: e.target.value })
                        }
                      />
                      <button
                        className="text-button"
                        onClick={() => onOpen(m.id)}
                      >
                        원본 확인
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <Empty
                title="학습 자료가 없습니다"
                description="내 자료에서 교과서나 학습지를 추가해 주세요."
              />
            )}
          </div>
          <p className="field-help">
            선택한 자료·페이지를 출처로 가진 문항만 출제합니다. 정답·해설
            페이지는 제외합니다.
          </p>
          <div className="notice">
            <BookOpen size={18} />
            <p>
              {mode === "memory" ? "선택 범위 · 학습 가능" : "선택 범위 · 아직 풀지 않은 문제"}{" "}
              <strong>{available}개</strong>
              <br />
              <small>
                {inventory===null?'저장된 콘텐츠를 확인하고 있습니다.':'현재 선택한 자료·방식·유형·난이도 기준입니다.'}
              </small>
            </p>
          </div>
          <section className="panel study-saved-concepts"><div className="section-heading"><h2>개념 정리 {concepts.length}개</h2></div>{concepts.length?concepts.slice(0,showAllConcepts?concepts.length:6).map(c=><details key={c.id}><summary>{c.name}</summary><p>{c.definition}</p>{c.properties?.length>0&&<ul>{c.properties.map((v,i)=><li key={i}>{v}</li>)}</ul>}</details>):<p className="field-help">선택한 자료의 개념 정리를 준비하면 여기에 표시됩니다.</p>}{concepts.length>6&&<Button variant="ghost" onClick={()=>setShowAllConcepts(!showAllConcepts)}>{showAllConcepts?"간단히 보기":`개념 ${concepts.length}개 모두 보기`}</Button>}<div className="row">{materials.filter(m=>selected.includes(m.id)).map(m=><Button key={m.id} variant="ghost" onClick={()=>onMaterial(m.id)}>{m.title} · 콘텐츠 준비</Button>)}</div></section>
        </section>
        <section>
          <div className="section-heading">
            <h2>
              <span className="section-number">2</span>학습 방식
            </h2>
          </div>
          <div className="mode-list">
            {modes.map((m) => (
              <button
                key={m.key}
                className={`mode-card ${mode === m.key ? "selected" : ""}`}
                aria-pressed={mode === m.key}
                onClick={() => setMode(m.key)}
              >
                <span className="mode-icon">
                  <m.icon size={21} />
                </span>
                <span>
                  <strong>{m.title}</strong>
                  <small>{m.description}</small>
                </span>
                <span className="radio-mark">{mode === m.key && <span />}</span>
              </button>
            ))}
          </div>
          <details className="study-options"><summary>문제 수·유형·난이도</summary>
            {mode !== "memory" && (
              <label>
                문제 유형
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  {["전체", "객관식", "OX", "단답형", "빈칸", "서술형"].map(
                    (t) => (
                      <option key={t}>{t}</option>
                    ),
                  )}
                </select>
              </label>
            )}
            <div className="form-grid">
              <label>
                {mode === "memory" ? "카드 수" : "문제 수"}
                <select
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                >
                  {[3, 5, 10, 15, 20].map((c) => (
                    <option key={c} value={c}>
                      {c}개
                    </option>
                  ))}
                </select>
              </label>
              <label>
                난이도
                <select
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value)}
                >
                  {["전체", "기본", "보통", "심화"].map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
            </div>
          </details>
          {scopeError&&<p className="error" role="alert">{scopeError}</p>}
          {inventory!==null&&available === 0 && (
            <div className="notice">
              <p>
                {counts.completed > 0
                  ? "선택한 범위의 문제를 모두 풀었습니다. 다른 범위를 선택하거나 문제 은행에서 다시 풀 수 있어요."
                  : "현재 조건에 맞는 문항이 없습니다. 자료의 콘텐츠 준비에서 문제를 추가할 수 있어요."}
              </p>
            </div>
          )}
          <Button
            className="full-width"
            disabled={!selected.length || available === 0||!!scopeError||inventory===null}
            busy={busy}
            onClick={() => start()}
          >
            학습 시작
            <ArrowRight size={16} />
          </Button>
          <p className="field-help center">
            {selected.length}개 자료 선택 · 출처와 함께 기록해요.
          </p>
        </section>
      </div>
    </>
  );
}
const isDone = (item: StudyItem, mode: StudyMode) =>
  mode === "memory" ? !!item.memory : !!item.result;
export function StudyPlayer({
  id,
  state,
  onBack,
  onRefresh,
  onOpen,
  onError,
  onSolve,
}: {
  id: string;
  state: AppState;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onOpen: (id: string, page?: number) => void;
  onError: (s: string) => void;
  onSolve: (ids: string[]) => void;
}) {
  const [session, setSession] = useState<StudySession>(),
    [index, setIndex] = useState(0),
    [response, setResponse] = useState(""),
    [reveal, setReveal] = useState<{ answer: string; explanation?: string }>(),
    [busy, setBusy] = useState(false),
    [finished, setFinished] = useState(false),
    [failure, setFailure] = useState("");
  useEffect(() => {
    let alive = true;
    api<StudySession>(`study/${id}`)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        const idx = s.items.findIndex((i) => !isDone(i, s.mode));
        setIndex(Math.max(0, idx));
        setResponse(s.items[Math.max(0, idx)]?.response || "");
        setFinished(s.status === "complete");
      })
      .catch((e) => {
        if (alive) setFailure(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  if (failure)
    return (
      <Empty
        title="학습을 열 수 없습니다"
        description={failure}
        action={<Button onClick={onBack}>학습하기로</Button>}
      />
    );
  if (!session)
    return <div className="loading">등록된 학습 내용을 여는 중…</div>;
  const item = session.items[index],
    mode = session.mode;
  const next = (s = session) => {
    if (s.status === "complete") {
      setFinished(true);
      return;
    }
    const idx = s.items.findIndex((i, n) => n > index && !isDone(i, mode));
    const fallback = s.items.findIndex((i) => !isDone(i, mode));
    const n = idx >= 0 ? idx : fallback;
    if (n < 0) {
      setFinished(true);
      return;
    }
    setIndex(n);
    setResponse(s.items[n]?.response || "");
    setReveal(undefined);
  };
  const send = async (
    memory?: "known" | "unsure" | "unknown",
    selfGrade?: "correct" | "wrong",
  ) => {
    if (!item) return;
    setBusy(true);
    try {
      const s = await api<StudySession>(`study/${id}/answer`, "POST", {
        itemId: item.id,
        response,
        memory,
        selfGrade,
      });
      setSession(s);
      if (mode === "memory") next(s);
      void onRefresh().catch((e) => onError((e as Error).message));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const show = () => {
    if (item.answer === undefined) {
      onError("저장된 답을 불러오지 못했습니다. 학습을 다시 열어 주세요.");
      return;
    }
    setReveal({ answer: item.answer, explanation: item.explanation });
  };
  const pendingGrade =
    item &&
    !item.result &&
    (!!item.response || item.requiresSelfGrade) &&
    (item.answer !== undefined || !!reveal);
  const choices = item?.choices?.length
    ? item.choices
    : item?.type === "OX"
      ? ["O", "X"]
      : [];
  const chosenFeedback = item?.choiceFeedback?.[item.response || response];
  return (
    <div className="learning-workspace">
      <div className="workspace-header">
        <IconButton label="학습하기로" onClick={onBack}>
          <ArrowLeft size={20} />
        </IconButton>
        <div className="workspace-title">
          <strong>
            {session.label || modes.find((m) => m.key === mode)?.title}
          </strong>
          <span>자료 {session.materialIds.length}개 · 준비된 콘텐츠</span>
        </div>
        <Badge tone="indigo">{mode === "memory" ? "암기" : "이해 확인"}</Badge>
        {!finished && (
          <span className="session-counter">
            {index + 1} / {session.items.length}
          </span>
        )}
      </div>
      {finished ? (
        <div className="session-summary">
          <div className="success-icon">
            <CheckCircle2 size={34} />
          </div>
          <div className="eyebrow">학습 기록</div>
          <h1>학습을 마쳤어요</h1>
          <p>
            {mode === "memory"
              ? `알고 있음 ${session.items.filter((i) => i.memory === "known").length}개 · 다시 볼 카드 ${session.items.filter((i) => i.memory && i.memory !== "known").length}개`
              : `맞힘 ${session.items.filter((i) => i.result === "correct").length}개 · 다시 확인 ${session.items.filter((i) => i.result === "wrong").length}개`}
          </p>
          {mode !== "memory" && session.conceptIds?.length > 0 && (
            <p>
              이해 확인 {session.understoodConceptIds?.length || 0} /{" "}
              {session.conceptIds.length}개 개념
            </p>
          )}
          {session.feedback && (
            <p className="feedback-text">{session.feedback}</p>
          )}
          {session.notice && <p className="notice">{session.notice}</p>}
          <div className="row">
            {session.originQuestionIds?.length > 0 && (
              <Button onClick={() => onSolve(session.originQuestionIds)}>
                <RotateCcw size={16} />
                원본 다시 풀기
              </Button>
            )}
            <Button variant="secondary" onClick={onBack}>
              학습하기로
              <ArrowRight size={16} />
            </Button>
          </div>
        </div>
      ) : !item ? (
        <Empty
          title="등록된 문항이 없습니다"
          action={<Button onClick={onBack}>돌아가기</Button>}
        />
      ) : (
        <div className="study-player-content">
          {session.notice && (
            <div className="notice" role="status">
              {session.notice}
            </div>
          )}
          <div className="study-progress">
            <div
              style={{
                width: `${(session.items.filter((i) => isDone(i, mode)).length / session.items.length) * 100}%`,
              }}
            />
          </div>
          <div className="eyebrow">
            {item.concept} · {item.type}
          </div>
          {mode === "check" && (
            <details className="concept-reference">
              <summary>개념 정의와 성질 보기</summary>
              {item.conceptDefinition !== undefined ||
              item.conceptProperties !== undefined ? (
                <div>
                  <h3>{item.concept}</h3>
                  <p>{item.conceptDefinition || ""}</p>
                  {!!item.conceptProperties?.length && (
                    <ul>
                      {item.conceptProperties.map((property, i) => (
                        <li key={i}>{property}</li>
                      ))}
                    </ul>
                  )}
                  <Sources
                    sources={item.sources}
                    materials={state.materials}
                    onOpen={onOpen}
                  />
                </div>
              ) : (
                state.concepts
                  .filter((c) => c.id === item.conceptId)
                  .map((c) => (
                    <div key={c.id}>
                      <h3>{c.name}</h3>
                      <p>{c.definition}</p>
                      {c.properties.length > 0 && (
                        <ul>
                          {c.properties.map((property, i) => (
                            <li key={i}>{property}</li>
                          ))}
                        </ul>
                      )}
                      <Sources
                        sources={c.sources}
                        materials={state.materials}
                        onOpen={onOpen}
                      />
                    </div>
                  ))
              )}
            </details>
          )}
          <div className="lesson-card study-question">
            <Badge>{item.type}</Badge>
            <h2>{item.prompt}</h2>
            <Sources
              sources={item.sources}
              materials={state.materials}
              onOpen={onOpen}
            />
            {mode === "memory" ? (
              <>
                {reveal || item.memory ? (
                  <>
                    <div className="flash-answer">
                      {reveal?.answer || item.answer}
                    </div>
                    {(reveal?.explanation || item.explanation) && (reveal?.explanation || item.explanation)?.trim()!==(reveal?.answer || item.answer)?.trim() && (
                      <p className="feedback-text">{reveal?.explanation || item.explanation}</p>
                    )}
                    <div className="memory-controls">
                      <Button
                        variant="secondary"
                        busy={busy}
                        onClick={() => send("unknown")}
                      >
                        모름
                      </Button>
                      <Button
                        variant="secondary"
                        busy={busy}
                        onClick={() => send("unsure")}
                      >
                        헷갈림
                      </Button>
                      <Button busy={busy} onClick={() => send("known")}>
                        알고 있음
                        <Check size={15} />
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button variant="secondary" busy={busy} onClick={show}>
                    {item.type === "문장 가리기" ? "가린 문장 보기" : "답 보기"}
                  </Button>
                )}
              </>
            ) : (
              <>
                {choices.length ? (
                  <div className="choices">
                    {choices.map((choice, i) => (
                      <button
                        key={i}
                        disabled={!!item.result || pendingGrade || busy}
                        aria-pressed={response === choice}
                        className={`${(item.response || response) === choice ? "selected" : ""} ${item.result && choice === item.answer ? "correct" : ""}`}
                        onClick={() => setResponse(choice)}
                      >
                        <span>
                          {item.type === "OX"
                            ? choice
                            : String.fromCharCode(65 + i)}
                        </span>
                        {item.type !== "OX" && choice}
                      </button>
                    ))}
                  </div>
                ) : (
                  <label className="answer-input">
                    <span className="sr-only">내 답변</span>
                    <textarea
                      value={item.response || response}
                      disabled={!!item.result || pendingGrade || busy}
                      onChange={(e) => setResponse(e.target.value)}
                      placeholder="답을 적어 주세요."
                      rows={4}
                      maxLength={10000}
                    />
                  </label>
                )}
                <div className="study-question-footer">
                  {item.result || pendingGrade ? (
                    <>
                      <div className="answer-feedback">
                        <Badge
                          tone={item.result === "correct" ? "green" : "amber"}
                        >
                          {pendingGrade
                            ? "준비된 답을 보고 직접 채점하세요"
                            : item.result === "correct"
                              ? "맞았어요"
                              : "다시 확인해 보세요"}
                        </Badge>
                        <p>
                          <strong>정답</strong> {item.answer || reveal?.answer}
                        </p>
                        {(item.feedback ||
                          chosenFeedback?.explanation ||
                          item.explanation ||
                          reveal?.explanation) && (
                          <p className="feedback-text">
                            {item.feedback ||
                              chosenFeedback?.explanation ||
                              item.explanation ||
                              reveal?.explanation}
                          </p>
                        )}
                        {(item.misconceptionLabel ||
                          item.misconceptionLabels?.[
                            item.misconceptionTag || ""
                          ]) && (
                          <p className="misconception-tag">
                            연결된 오개념:{" "}
                            {item.misconceptionLabel ||
                              item.misconceptionLabels?.[
                                item.misconceptionTag || ""
                              ]}
                          </p>
                        )}
                        {item.result === "wrong" && item.correction && (
                          <div className="correction">
                            <strong>개념 교정</strong>
                            <p>{item.correction}</p>
                          </div>
                        )}
                      </div>
                      {pendingGrade ? (
                        <div className="row">
                          <Button
                            variant="secondary"
                            busy={busy}
                            onClick={() => send(undefined, "wrong")}
                          >
                            다시 확인 필요
                          </Button>
                          <Button
                            busy={busy}
                            onClick={() => send(undefined, "correct")}
                          >
                            이해했어요
                          </Button>
                        </div>
                      ) : (
                        <Button onClick={() => next()}>
                          {session.status === "complete"
                            ? "학습 완료"
                            : "다음 문제"}
                          <ArrowRight size={16} />
                        </Button>
                      )}
                    </>
                  ) : (
                    <Button
                      disabled={!response.trim()}
                      busy={busy}
                      onClick={() => send()}
                    >
                      답변 제출
                      <ArrowRight size={16} />
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
