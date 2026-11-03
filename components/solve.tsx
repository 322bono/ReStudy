"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  PenLine,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  BookOpen,
  CheckCircle2,
  Lightbulb,
} from "lucide-react";
import { api } from "@/lib/client";
import type {
  AppState,
  Question,
  Result,
  SolveSession,
  Stroke,
} from "@/lib/types";
import { Badge, Button, Empty, IconButton } from "./ui";
import { prefetchSecureImages, SecureImage } from "./secure-assets";
import OriginalAnalysis from "../src/components/OriginalAnalysis";
import "../src/styles/original-analysis.css";
import "../src/styles/original-solve.css";

function Drawing({
  question,
  sessionId,
  region,
  zoom,
  pen,
  disabled,
  strokes,
  onChange,
}: {
  question: Question;
  sessionId: string;
  region: number;
  zoom: number;
  pen: boolean;
  disabled: boolean;
  strokes: Stroke[];
  onChange: (s: Stroke[]) => void;
}) {
  const current = useRef<Stroke | null>(null),
    [draft, setDraft] = useState<Stroke | null>(null);
  useEffect(() => {
    if (disabled || !pen) {
      current.current = null;
      setDraft(null);
    }
  }, [disabled, pen]);
  const pos = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };
  const end = () => {
    if (current.current && !disabled) {
      onChange([...strokes, current.current]);
      current.current = null;
      setDraft(null);
    }
  };
  return (
    <div className="drawing-paper" style={{ width: `${zoom * 100}%` }}>
      <SecureImage
        alt={`${question.number}번 원본 문제${question.regions.length > 1 ? ` · 영역 ${region + 1}` : ""}`}
        draggable={false}
        path={`questions/${question.id}/image/${region}?session=${sessionId}`}
      />
      <svg
        className={pen && !disabled ? "pen-active" : ""}
        aria-disabled={disabled}
        style={disabled ? { pointerEvents: "none" } : undefined}
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          if (!pen || disabled) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          current.current = {
            color: "#3730a3",
            width: 0.0025,
            region,
            points: [pos(e)],
          };
          setDraft({ ...current.current });
        }}
        onPointerMove={(e) => {
          if (!current.current || disabled) return;
          current.current.points.push(pos(e));
          setDraft({ ...current.current });
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {[...strokes, ...(draft ? [draft] : [])]
          .filter((s) => s.region === region)
          .map((s, i) => (
            <polyline
              key={i}
              points={s.points
                .map((p) => `${p.x * 1000},${p.y * 1000}`)
                .join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width * 1000}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
      </svg>
    </div>
  );
}
export function Solve({
  id,
  state,
  onBack,
  onRefresh,
  onError,
  onConcept,
  onBank,
  onSolve,
  onDetails,
}: {
  id: string;
  state: AppState;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onError: (s: string) => void;
  onConcept: (id: string) => void;
  onBank: (scope: any) => void;
  onSolve: (ids: string[]) => void;
  onDetails: (id: string) => void;
}) {
  const [session, setSession] = useState<SolveSession>(),
    [index, setIndex] = useState(0),
    [pen, setPen] = useState(false),
    [zoom, setZoom] = useState(1),
    [strokes, setStrokes] = useState<Stroke[]>([]),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [summary, setSummary] = useState(false),
    [failure, setFailure] = useState(""),
    [review, setReview] = useState<any>(),
    [helpText, setHelpText] = useState(""),
    [answerText, setAnswerText] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const answerKeysRef = useRef<{
    id: string;
    promise: Promise<Record<string, any> | null>;
  } | null>(null);
  const prepareAnswerKeys = () => {
    if (answerKeysRef.current?.id !== id) {
      answerKeysRef.current = {
        id,
        promise: api<{ answerKeys: Record<string, any> }>(
          `solve/${id}/answer-keys`,
        )
          .then((result) => result.answerKeys)
          .catch(() => null),
      };
    }
    return answerKeysRef.current.promise;
  };
  useEffect(() => {
    if (review && window.matchMedia("(max-width: 900px)").matches)
      reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [review]);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setFailure("");
    // Warm only this session's immutable snapshots. Nothing is revealed until
    // the learner presses the answer button.
    void prepareAnswerKeys();
    api<SolveSession>(`solve/${id}`)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        const i = s.questionIds.findIndex((q) => !s.answers[q]);
        setIndex(Math.max(0, i));
        setSummary(s.status === "complete");
        setLoaded(true);
      })
      .catch((e) => {
        if (!alive) return;
        setFailure(e.message);
        onError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id, onError]);
  const qid = session?.questionIds[index],
    q =
      session?.questions?.find((q) => q.id === qid) ||
      state.questions.find((q) => q.id === qid);
  useEffect(() => {
    if (!session || summary) return;
    const nextIds = session.questionIds.slice(index + 1, index + 3);
    const paths = nextIds.flatMap((questionId) => {
      const next =
        session.questions?.find((question) => question.id === questionId) ||
        state.questions.find((question) => question.id === questionId);
      return (
        next?.regions.map(
          (_, region) =>
            `questions/${questionId}/image/${region}?session=${id}`,
        ) || []
      );
    });
    void prefetchSecureImages(paths);
  }, [id, session, index, state.questions, summary]);
  useEffect(() => {
    setStrokes(qid ? session?.drawings[qid] || [] : []);
    setZoom(1);
    setHelpText("");
    setReview(undefined);
    setAnswerText(qid ? session?.answers[qid]?.answerText || "" : "");
  }, [qid]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );
  if (failure)
    return (
      <Empty
        title="풀이를 열 수 없습니다"
        description={failure}
        action={<Button onClick={onBack}>오답 노트로</Button>}
      />
    );
  if (!session || !loaded)
    return <div className="loading">풀이를 준비하는 중…</div>;
  if (!q)
    return (
      <Empty
        title="문제 원본을 찾을 수 없습니다"
        action={<Button onClick={onBack}>오답 노트로</Button>}
      />
    );
  const material = state.materials.find((m) => m.id === q.materialId),
    answered = session.answers[q.id];
  const changeDrawing = (next: Stroke[]) => {
    if (answered || busy) return;
    setStrokes(next);
    session.drawings[q.id] = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api(`solve/${id}/drawing`, "POST", {
        questionId: q.id,
        strokes: next,
      }).catch((e) => onError(e.message));
    }, 500);
  };
  const move = async (next: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setBusy(true);
    try {
      await api(`solve/${id}/drawing`, "POST", { questionId: q.id, strokes });
      setIndex(next);
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const answer = async (result: Result) => {
    setBusy(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      const s = await api<SolveSession>(`solve/${id}/answer`, "POST", {
        questionId: q.id,
        result,
        strokes,
        answerText,
      });
      setSession(s);
      await onRefresh();
      if (s.status === "complete") setSummary(true);
      else setIndex(s.questionIds.findIndex((q) => !s.answers[q]));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const help = async () => {
    setBusy(true);
    setHelpText("");
    try {
      const keys = await prepareAnswerKeys();
      const key =
        keys === null
          ? await api(`solve/${id}/answer-key/${q.id}`)
          : keys[q.id] || { available: false };
      setReview(key.review);
      setHelpText(
        key.available
          ? ""
          : "저장된 정답이 없습니다. 원본 정답을 확인하고 직접 채점해 주세요.",
      );
    } catch (e) {
      setHelpText((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (summary)
    return (
      <div className="session-summary">
        <div className="success-icon">
          <CheckCircle2 size={34} />
        </div>
        <div className="eyebrow">복습 기록</div>
        <h1>오늘의 풀이를 저장했어요</h1>
        <p>
          {
            Object.values(session.answers).filter((a) => a.result === "correct")
              .length
          }
          개 맞힘 ·{" "}
          {
            Object.values(session.answers).filter((a) => a.result === "wrong")
              .length
          }
          개 틀림 ·{" "}
          {
            Object.values(session.answers).filter((a) => a.result === "skip")
              .length
          }
          개 다음에 풀기
        </p>
        <div className="summary-results">
          {session.questionIds.map((qid) => {
            const question = state.questions.find((q) => q.id === qid),
              a = session.answers[qid];
            return (
              <div key={qid}>
                <span>{question?.number}번</span>
                <Badge
                  tone={
                    a?.result === "correct"
                      ? "green"
                      : a?.result === "wrong"
                        ? "amber"
                        : "neutral"
                  }
                >
                  {a?.result === "correct"
                    ? "맞힘"
                    : a?.result === "wrong"
                      ? "틀림"
                      : "다음에 풀기"}
                </Badge>
                <button className="text-button" onClick={() => onDetails(qid)}>
                  저장된 분석
                  <ArrowRight size={12} />
                </button>
                {a?.result === "wrong" && (
                  <button
                    className="text-button"
                    disabled={!question?.hasContent}
                    onClick={() => onConcept(qid)}
                  >
                    개념 복습
                    <ArrowRight size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="muted">
          맞힌 문제는 시험 전 복습에 보관하고, 틀린 문제는 다시 풀 목록에
          남깁니다.
        </p>
        <Button onClick={onBack}>
          오답 노트로
          <ArrowRight size={16} />
        </Button>
      </div>
    );
  return (
    <div className="solve-workspace">
      <div className="workspace-header">
        <IconButton
          label="오답 노트로"
          onClick={async () => {
            if (await move(index)) onBack();
          }}
        >
          <ArrowLeft size={20} />
        </IconButton>
        <div className="workspace-title">
          <strong>다시 풀기</strong>
          <span>{material?.title}</span>
        </div>
        <Badge>원본 문제</Badge>
        <span className="session-counter">
          {index + 1} / {session.questionIds.length}
        </span>
      </div>
      <div className="solve-toolbar">
        <div className="row">
          <IconButton label="정답 확인" disabled={busy} onClick={help}>
            <Lightbulb size={17} />
          </IconButton>
          <IconButton
            label="이전 문제"
            disabled={index === 0 || busy}
            onClick={() => move(index - 1)}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <strong>{q.number}번</strong>
          <IconButton
            label="다음 문제"
            disabled={index === session.questionIds.length - 1 || busy}
            onClick={() => move(index + 1)}
          >
            <ChevronRight size={18} />
          </IconButton>
        </div>
        <div className="row">
          <IconButton
            label="축소"
            disabled={zoom <= 0.75}
            onClick={() => setZoom(zoom - 0.25)}
          >
            <ZoomOut size={17} />
          </IconButton>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <IconButton
            label="확대"
            disabled={zoom >= 2.5}
            onClick={() => setZoom(zoom + 0.25)}
          >
            <ZoomIn size={17} />
          </IconButton>
          <div className="toolbar-divider" />
          <Button
            variant={pen && !answered ? "primary" : "secondary"}
            disabled={!!answered || busy}
            aria-pressed={pen && !answered}
            onClick={() => setPen(!pen)}
          >
            <PenLine size={15} />
            필기
          </Button>
          <IconButton
            label="마지막 획 지우기"
            disabled={!strokes.length || !!answered || busy}
            onClick={() => changeDrawing(strokes.slice(0, -1))}
          >
            <Undo2 size={16} />
          </IconButton>
        </div>
      </div>
      <div className="solve-scroll">
        <div className={`solve-content ${review ? "has-analysis" : ""}`}>
          <div className="solve-source-images">
            {q.regions.map((_, i) => (
              <Drawing
                key={q.id + "-" + i}
                question={q}
                sessionId={id}
                region={i}
                zoom={zoom}
                pen={pen}
                disabled={!!answered || busy}
                strokes={strokes}
                onChange={changeDrawing}
              />
            ))}
          </div>
          {(review || helpText) && (
            <section
              ref={reviewRef}
              className="solve-saved-review"
              aria-label="정답 확인 후 저장된 분석"
            >
              {helpText && (
                <p className="notice" role="status">
                  {helpText}
                </p>
              )}
              <OriginalAnalysis review={review} onBank={onBank} />
              <div className="analysis-actions">
                <Button variant="ghost" onClick={() => onDetails(q.id)}>
                  이 문제의 분석·기록 보기
                </Button>
              </div>
              {!!review?.similar?.length && (
                <details className="solve-related-originals">
                  <summary>함께 복습할 원본 {review.similar.length}개</summary>
                  {review.similar.map((similar: any) => (
                    <div className="row" key={similar.id}>
                      <span>
                        {similar.number}번 · PDF {similar.page}쪽
                      </span>
                      <Button
                        variant="secondary"
                        disabled={!similar.canSolve}
                        onClick={() => onSolve([similar.id])}
                      >
                        원본 풀기
                      </Button>
                    </div>
                  ))}
                </details>
              )}
            </section>
          )}
        </div>
      </div>
      <div className="solve-answer">
        <label htmlFor="original-answer">
          내 답안 <small>선택</small>
        </label>
        <input
          id="original-answer"
          value={answerText}
          disabled={!!answered || busy}
          onChange={(e) => setAnswerText(e.target.value)}
          placeholder="풀이한 답을 기록할 수 있어요."
          maxLength={10000}
        />
      </div>
      <div className="solve-footer">
        {answered ? (
          <>
            <Badge tone={answered.result === "correct" ? "green" : "amber"}>
              기록됨 ·{" "}
              {answered.result === "correct"
                ? "맞힘"
                : answered.result === "wrong"
                  ? "틀림"
                  : "다음에 풀기"}
            </Badge>
            <Button
              variant="secondary"
              disabled={!q.hasContent}
              onClick={() => onConcept(q.id)}
            >
              <BookOpen size={15} />
              개념 복습
            </Button>
          </>
        ) : !review ? (
          <Button busy={busy} onClick={help}>
            정답 확인
          </Button>
        ) : (
          <>
            <span className="muted">직접 채점해 주세요.</span>
            <div className="row">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => answer("skip")}
              >
                다음에 풀기
              </Button>
              <Button
                variant="secondary"
                busy={busy}
                onClick={() => answer("wrong")}
              >
                <X size={16} />
                틀림
              </Button>
              <Button busy={busy} onClick={() => answer("correct")}>
                <Check size={16} />
                맞힘
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
