"use client";
import { useState } from "react";
import {
  Plus,
  ArrowRight,
  Check,
  RotateCcw,
  FileText,
  Trash2,
  BookOpen,
  Search,
} from "lucide-react";
import { api, dueLabel, isDue, dateLabel } from "@/lib/client";
import type { AppState, Question } from "@/lib/types";
import { Badge, Button, Dialog, Empty, IconButton } from "./ui";
import { SecureImage } from "./secure-assets";

export function AddMistakes({
  state,
  onClose,
  onDone,
  onReview,
}: {
  state: AppState;
  onClose: () => void;
  onDone: () => Promise<void>;
  onReview: (id: string) => void;
}) {
  const [materialId, setMaterialId] = useState(state.materials[0]?.id || ""),
    [numbers, setNumbers] = useState(""),
    [cause, setCause] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [result, setResult] = useState<{
      added: number;
      ambiguous: number[];
      missing: number[];
    }>(),
    [chosen, setChosen] = useState<string[]>([]);
  const add = async (explicit = false) => {
    setBusy(true);
    setMessage("");
    try {
      const r = await api(
        "mistakes",
        "POST",
        explicit
          ? { questionIds: chosen, cause }
          : { materialId, numbers, cause },
      );
      await onDone();
      if (r.reviewSessionId) {
        onReview(r.reviewSessionId);
        return;
      }
      setResult(r);
      setMessage(
        `${r.added}개 문제를 저장했습니다.${r.added === 0 ? " 이미 등록한 문제는 중복 저장하지 않습니다." : ""}`,
      );
      if (r.unregistered)
        setMessage(
          (prev) =>
            prev +
            ` 학습 콘텐츠 미등록 ${r.unregistered}개는 원본 다시 풀기를 이용해 주세요.`,
        );
      if (explicit) setChosen([]);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="오답 등록" onClose={onClose}>
      <div className="form-stack">
        <label>
          문제집
          <select
            value={materialId}
            onChange={(e) => {
              setMaterialId(e.target.value);
              setResult(undefined);
              setChosen([]);
            }}
          >
            <option value="" disabled>
              자료를 선택하세요
            </option>
            {state.materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.subject} · {m.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          문제 번호
          <input
            autoFocus
            placeholder="17, 24, 36 또는 17-20"
            value={numbers}
            onChange={(e) => setNumbers(e.target.value)}
          />
          <small>여러 번호를 한 번에 입력할 수 있어요.</small>
        </label>
        <label>
          오답 원인 <small>선택</small>
          <select value={cause} onChange={(e) => setCause(e.target.value)}>
            {[
              "",
              "개념 부족",
              "계산 실수",
              "조건 해석",
              "시간 부족",
              "기타",
            ].map((c) => (
              <option key={c} value={c}>
                {c || "선택하지 않음"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {result?.missing.length ? (
        <p className="error">
          찾지 못한 번호: {result.missing.join(", ")}. 콘텐츠 관리에서 문항
          번호와 영역을 확인해 주세요.
        </p>
      ) : null}
      {result?.ambiguous.length ? (
        <div className="ambiguous">
          <p>같은 번호가 여러 개 있어요. 페이지로 선택해 주세요.</p>
          {state.questions
            .filter(
              (q) =>
                q.materialId === materialId &&
                result.ambiguous.includes(q.number),
            )
            .map((q) => (
              <label key={q.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(q.id)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked
                        ? [...chosen, q.id]
                        : chosen.filter((id) => id !== q.id),
                    )
                  }
                />
                {q.number}번 · {q.regions[0].page}쪽 {q.unit && `· ${q.unit}`}
              </label>
            ))}
          <Button
            variant="secondary"
            disabled={!chosen.length}
            busy={busy}
            onClick={() => add(true)}
          >
            선택한 문제 추가
          </Button>
        </div>
      ) : null}
      <div className="dialog-footer">
        <Button variant="secondary" onClick={onClose}>
          닫기
        </Button>
        <Button
          disabled={!materialId || !numbers}
          busy={busy}
          onClick={() => add()}
        >
          추가
        </Button>
      </div>
    </Dialog>
  );
}
export function Mistakes({
  state,
  onAdd,
  onSolve,
  onConcept,
  onOpen,
  onRefresh,
  onError,
}: {
  state: AppState;
  onAdd: () => void;
  onSolve: (ids: string[]) => void;
  onConcept: (id: string) => void;
  onOpen: (id: string, page?: number) => void;
  onRefresh: () => Promise<void>;
  onError: (s: string) => void;
}) {
  const [subject, setSubject] = useState("전체"),
    [material, setMaterial] = useState("전체"),
    [unit, setUnit] = useState("전체"),
    [status, setStatus] = useState("전체"),
    [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [detail, setDetail] = useState<any>();
  const subjects = [...new Set(state.materials.map((m) => m.subject))];
  const units = [
    ...new Set(state.questions.map((q) => q.unit).filter(Boolean)),
  ];
  const rows = state.mistakes
    .flatMap((m) => {
      const q = state.questions.find((q) => q.id === m.questionId),
        d = state.materials.find((d) => d.id === q?.materialId);
      return q && d ? [{ m, q, d }] : [];
    })
    .filter(
      ({ m, q, d }) =>
        (subject === "전체" || d.subject === subject) &&
        (material === "전체" || d.id === material) &&
        (unit === "전체" || q.unit === unit) &&
        (status === "전체" ||
          (status === "오늘 복습" && isDue(m.dueAt)) ||
          (status === "확인 필요" && !q.confirmed) ||
          (status === "개념 복습" && m.conceptState !== "understood")) &&
        (!search ||
          String(q.number).includes(search) ||
          d.title.includes(search)),
    );
  const remove = async (id: string) => {
    try {
      await api(`mistakes/${id}`, "DELETE");
      await onRefresh();
      setDetail(undefined);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">다시, 내 것으로</div>
          <h1>
            오답 노트{" "}
            <span className="title-count">{state.mistakes.length}</span>
          </h1>
          <p>틀린 문제를 다시 풀고, 내 개념으로 만드세요.</p>
        </div>
        <Button onClick={onAdd}>
          <Plus size={17} />
          오답 등록
        </Button>
      </div>
      <div className="toolbar">
        <div className="tabs">
          {["전체", "오늘 복습", "개념 복습", "확인 필요"].map((s) => (
            <button
              key={s}
              className={status === s ? "active" : ""}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={16} />
          <input
            placeholder="문제 번호, 자료 검색"
            aria-label="오답 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="filters">
        <select
          aria-label="과목 필터"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        >
          <option value="전체">모든 과목</option>
          {subjects.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          aria-label="문제집 필터"
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
        >
          <option value="전체">모든 문제집</option>
          {state.materials.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
        {units.length > 0 && (
          <select
            aria-label="단원 필터"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          >
            <option value="전체">모든 단원</option>
            {units.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        )}
        <Button
          variant="ghost"
          onClick={() => setSelected(rows.map((r) => r.q.id))}
        >
          전체 선택
        </Button>
      </div>
      {selected.length > 0 && (
        <div className="selection-bar">
          <span>{selected.length}개 선택</span>
          <Button variant="ghost" onClick={() => setSelected([])}>
            선택 해제
          </Button>
          <Button onClick={() => onSolve(selected)}>
            <RotateCcw size={15} />
            다시 풀기
          </Button>
        </div>
      )}
      <div className="mistake-list">
        {rows.length ? (
          rows.map(({ m, q, d }) => (
            <article className="mistake-card" key={m.id}>
              <input
                type="checkbox"
                aria-label={`${q.number}번 선택`}
                checked={selected.includes(q.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, q.id]
                      : selected.filter((id) => id !== q.id),
                  )
                }
              />
              <button
                className="question-thumb"
                onClick={() => onOpen(d.id, q.regions[0].page)}
                aria-label={`${q.number}번 원본 열기`}
              >
                <SecureImage
                  alt={`${q.number}번 문제`}
                  loading="lazy"
                  path={`questions/${q.id}/image/0`}
                />
              </button>
              <div className="mistake-info">
                <div>
                  <Badge>{d.subject}</Badge>
                  {!q.hasContent && (
                    <Badge tone="amber">
                      {q.conceptIds?.length
                        ? "학습 콘텐츠 준비"
                        : "개념 연결하기"}
                    </Badge>
                  )}
                  {q.hasContent && (
                    <Badge
                      tone={
                        m.conceptState === "understood" ? "green" : "indigo"
                      }
                    >
                      {m.conceptState === "understood"
                        ? "이해 확인됨"
                        : "개념 복습 중"}
                    </Badge>
                  )}
                  <span className="due-small">{dueLabel(m.dueAt)} 복습</span>
                </div>
                <h3>
                  {q.number}번 <span>{q.unit}</span>
                </h3>
                <p>
                  {d.title} · {q.regions[0].page}쪽
                </p>
                <p className="concept-labels">
                  {q.conceptIds
                    ?.map((id) => state.concepts.find((c) => c.id === id)?.name)
                    .filter(Boolean)
                    .join(" · ") || "연결된 개념이 없습니다"}
                </p>
                <p className="mistake-metrics">
                  재풀이 {m.reviewCount}회 · 정답률{" "}
                  {m.reviewCount
                    ? Math.round(((m.correctCount || 0) / m.reviewCount) * 100)
                    : 0}
                  % · 이해도{" "}
                  {m.conceptState === "understood"
                    ? "확인됨"
                    : m.conceptState === "unregistered"
                      ? "미등록"
                      : "확인 중"}
                </p>
                <button
                  className="text-button history-link"
                  onClick={async () => {
                    try {
                      setDetail(await api(`mistakes/${m.id}`));
                    } catch (e) {
                      onError((e as Error).message);
                    }
                  }}
                >
                  {m.reviewCount ? `${m.reviewCount}회 복습` : "아직 복습 전"}{" "}
                  {m.lastResult === "correct"
                    ? "· 최근 맞힘"
                    : m.lastResult === "wrong"
                      ? "· 최근 틀림"
                      : ""}{" "}
                  <Chevron />
                </button>
              </div>
              <div className="mistake-actions">
                <Button variant="secondary" onClick={() => onConcept(q.id)}>
                  <BookOpen size={14} />
                  {q.hasContent
                    ? "개념·문제 은행"
                    : q.conceptIds?.length
                      ? "학습 콘텐츠 준비"
                      : "개념 연결하기"}
                </Button>
                <Button variant="ghost" onClick={() => onSolve([q.id])}>
                  다시 풀기
                  <ArrowRight size={14} />
                </Button>
              </div>
            </article>
          ))
        ) : (
          <div className="panel">
            <Empty
              title={
                state.mistakes.length
                  ? "조건에 맞는 오답이 없습니다"
                  : "다시 볼 문제를 모아 보세요"
              }
              description="자료의 문제를 누르거나, 번호를 입력해 오답을 등록할 수 있어요."
              icon={<BookOpen size={27} />}
              action={
                <Button variant="secondary" onClick={onAdd}>
                  <Plus size={16} />
                  오답 등록
                </Button>
              }
            />
          </div>
        )}
      </div>
      {detail && (
        <Dialog title="복습 기록" onClose={() => setDetail(undefined)}>
          <div className="detail-summary">
            <Badge>{detail.mistake.cause || "원인 미선택"}</Badge>
            <p>
              문제 풀이 {detail.mistake.reviewCount}회 · 개념{" "}
              {detail.mistake.conceptState === "understood"
                ? "이해 확인됨"
                : detail.mistake.conceptState === "unregistered"
                  ? "미등록"
                  : "복습 중"}
            </p>
            <p>다음 복습: {dateLabel(detail.mistake.dueAt)}</p>
          </div>
          <div className="history-list">
            {detail.attempts.length ? (
              detail.attempts.map((a: any, i: number) => (
                <div key={i}>
                  <span>{dateLabel(a.at)}</span>
                  <Badge
                    tone={
                      a.result === "correct"
                        ? "green"
                        : a.result === "wrong"
                          ? "amber"
                          : "neutral"
                    }
                  >
                    {a.result === "correct"
                      ? "맞힘"
                      : a.result === "wrong"
                        ? "틀림"
                        : "다음에 풀기"}
                  </Badge>
                </div>
              ))
            ) : (
              <p className="muted">풀이 기록이 아직 없습니다.</p>
            )}
          </div>
          <div className="dialog-footer">
            <Button variant="ghost" onClick={() => remove(detail.mistake.id)}>
              <Trash2 size={14} />
              오답에서 제거
            </Button>
            <Button onClick={() => setDetail(undefined)}>닫기</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
function Chevron() {
  return <ArrowRight size={11} />;
}
