"use client";
import { useEffect, useMemo, useRef, useState } from "react";
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
  Eraser,
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
import { createDrawingSaver } from "../src/services/solve-drawings";
import { eraseInk } from "../src/domain/ink";
import "../src/styles/original-analysis.css";
import "../src/styles/original-solve.css";

function Drawing({
  question,
  sessionId,
  snapshotIndex,
  region,
  zoom,
  pen,
  tool,
  color,
  width,
  disabled,
  strokes,
  onChange,
}: {
  question: Question;
  sessionId: string;
  snapshotIndex: number;
  region: number;
  zoom: number;
  pen: boolean;
  tool: "pen" | "eraser";
  color: string;
  width: number;
  disabled: boolean;
  strokes: Stroke[];
  onChange: (s: Stroke[]) => void;
}) {
  const paper = useRef<HTMLDivElement>(null),
    current = useRef<{
      pointerId: number;
      stroke: Stroke;
      erased?: Stroke[];
    } | null>(null),
    [draft, setDraft] = useState<Stroke | null>(null);
  const active = pen && !disabled;
  useEffect(() => {
    if (!active) {
      current.current = null;
      setDraft(null);
      return;
    }
    const surface = paper.current;
    if (!surface) return;
    // Block panning here even when the browser bypasses touch-action.
    const preventPan = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    surface.addEventListener("touchmove", preventPan, { passive: false });
    return () => surface.removeEventListener("touchmove", preventPan);
  }, [active, tool]);
  const pos = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };
  const cancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (current.current?.pointerId !== e.pointerId) return;
    current.current = null;
    setDraft(null);
  };
  const erase = (e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = current.current;
    if (!gesture) return;
    const point = pos(e),
      rect = e.currentTarget.getBoundingClientRect();
    const previous = gesture.erased ?? strokes;
    const next = eraseInk(
      previous,
      region,
      gesture.stroke.points[gesture.stroke.points.length - 1],
      point,
      rect.width,
      rect.height,
    );
    gesture.stroke.points = [point];
    gesture.erased = next;
    if (next !== previous) onChange(next);
  };
  return (
    <div
      ref={paper}
      className={
        active
          ? `drawing-paper pen-active ${tool === "eraser" ? "eraser-active" : ""}`
          : "drawing-paper"
      }
      style={{ width: `${zoom * 100}%` }}
      onPointerDown={(e) => {
        if (!active || !e.isPrimary || e.button !== 0 || current.current)
          return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const stroke = {
          color,
          width,
          region,
          points: [pos(e)],
        };
        current.current = { pointerId: e.pointerId, stroke };
        if (tool === "eraser") erase(e);
        else setDraft(stroke);
      }}
      onPointerMove={(e) => {
        if (!active || current.current?.pointerId !== e.pointerId) return;
        if (tool === "eraser") {
          erase(e);
          return;
        }
        const { stroke } = current.current;
        stroke.points.push(pos(e));
        setDraft({ ...stroke });
      }}
      onPointerUp={(e) => {
        if (!active || current.current?.pointerId !== e.pointerId) return;
        if (tool === "eraser") {
          erase(e);
          cancel(e);
          return;
        }
        const { stroke } = current.current;
        stroke.points.push(pos(e));
        cancel(e);
        onChange([...strokes, stroke]);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
    >
      <SecureImage
        alt={`${question.number}번 원본 문제${question.regions.length > 1 ? ` · 영역 ${region + 1}` : ""}`}
        draggable={false}
        path={`questions/${question.id}/image/${region}?session=${sessionId}&snapshot=${snapshotIndex}`}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
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
    [tool, setTool] = useState<"pen" | "eraser">("pen"),
    [penColor, setPenColor] = useState("#111827"),
    [penWidth, setPenWidth] = useState(0.0025),
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
  const progressDirty = useRef(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const refreshProgress = () => {
    if (!progressDirty.current) return;
    progressDirty.current = false;
    void refreshRef.current().catch((e) => {
      progressDirty.current = true;
      onError(e.message);
    });
  };
  const drawingSaver = useMemo(
    () =>
      createDrawingSaver((questionId, strokes) =>
        api(`solve/${id}/drawing`, "POST", {
          questionId,
          strokes,
          minimal: true,
        }),
      ),
    [id],
  );
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
    const nextIds = [
      ...session.questionIds.slice(index + 1, index + 4),
      ...session.questionIds.slice(Math.max(0, index - 1), index),
    ];
    const paths = nextIds.flatMap((questionId) => {
      const next =
        session.questions?.find((question) => question.id === questionId) ||
        state.questions.find((question) => question.id === questionId);
      return (
        next?.regions.map(
          (_, region) =>
            `questions/${questionId}/image/${region}?session=${id}&snapshot=${session.questionIds.indexOf(questionId)}`,
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
      void drawingSaver.flush().catch((e) => onError(e.message));
      refreshProgress();
    },
    [drawingSaver],
  );
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (drawingSaver.dirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [drawingSaver]);
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
    drawingSaver.change(q.id, next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void drawingSaver.flush().catch((e) => onError(e.message));
    }, 500);
  };
  const move = (next: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setIndex(next);
    void drawingSaver.flush().catch((e) => onError(e.message));
  };
  const answer = async (result: Result) => {
    setBusy(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      await drawingSaver.flush();
      const progress = await api<Pick<SolveSession, "answers" | "status">>(
        `solve/${id}/answer`,
        "POST",
        {
          questionId: q.id,
          result,
          strokes,
          answerText,
          minimal: true,
        },
      );
      const s = { ...session, ...progress };
      setSession(s);
      progressDirty.current = true;
      if (s.status === "complete") {
        setSummary(true);
        refreshProgress();
      } else setIndex(s.questionIds.findIndex((q) => !s.answers[q]));
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
            if (saveTimer.current) clearTimeout(saveTimer.current);
            setBusy(true);
            try {
              await drawingSaver.flush();
              refreshProgress();
              onBack();
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setBusy(false);
            }
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
      {pen && !answered && (
        <div className="solve-pen-strip">
          <div
            className="solve-pen-tools"
            role="toolbar"
            aria-label="필기 도구"
          >
            <button
              type="button"
              title="펜"
              aria-label="펜 선택"
              aria-pressed={tool === "pen"}
              disabled={busy}
              onClick={() => setTool("pen")}
            >
              <PenLine size={18} />
            </button>
            <div className="pen-palette" role="group" aria-label="펜 색상">
              {[
                ["빨간색", "#dc2626"],
                ["검은색", "#111827"],
                ["파란색", "#2563eb"],
              ].map(([label, color]) => (
                <button
                  key={color}
                  type="button"
                  className="pen-color"
                  title={label}
                  aria-label={`${label} 펜`}
                  aria-pressed={penColor === color && tool === "pen"}
                  disabled={busy}
                  onClick={() => {
                    setPenColor(color);
                    setTool("pen");
                  }}
                >
                  <span style={{ backgroundColor: color }} />
                </button>
              ))}
            </div>
            <select
              title="펜 굵기"
              aria-label="펜 굵기"
              value={penWidth}
              disabled={busy}
              onChange={(e) => setPenWidth(Number(e.target.value))}
            >
              <option value={0.0013}>가는선</option>
              <option value={0.0025}>보통</option>
              <option value={0.0045}>굵은선</option>
            </select>
            <button
              type="button"
              title="획 지우개 · 닿은 획 지우기"
              aria-label="획 지우개"
              aria-pressed={tool === "eraser"}
              disabled={busy}
              onClick={() => setTool("eraser")}
            >
              <Eraser size={18} />
            </button>
          </div>
        </div>
      )}
      <div className="solve-scroll">
        <div className={`solve-content ${review ? "has-analysis" : ""}`}>
          <div className="solve-source-images">
            {q.regions.map((_, i) => (
              <Drawing
                key={q.id + "-" + i}
                question={q}
                sessionId={id}
                snapshotIndex={index}
                region={i}
                zoom={zoom}
                pen={pen}
                tool={tool}
                color={penColor}
                width={penWidth}
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
