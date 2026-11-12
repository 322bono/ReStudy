"use client";
import { useRef, useState } from "react";
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
import type { AppState } from "@/lib/types";
import { Badge, Button, Dialog, Empty } from "./ui";
import { SecureImage } from "./secure-assets";
import { resolveMistakeNumbers } from "../src/domain/mistake-selection";

export type MistakeFilters = {
  subject: string;
  material: string;
  unit: string;
  status: string;
  search: string;
};

export function AddMistakes({
  state,
  preferredMaterial,
  subject,
  selectedQuestionIds,
  onClose,
  onDone,
  onRegistered,
}: {
  state: Pick<AppState, "materials" | "questions">;
  preferredMaterial: string;
  subject: string;
  selectedQuestionIds?: string[];
  onClose: () => void;
  onDone: () => Promise<void>;
  onRegistered: (ids: string[], autoAnalyzeIds: string[]) => void;
}) {
  const materials = state.materials.filter((m) => state.questions.some((q) => q.materialId === m.id && !q.mergedInto));
  const [materialId, setMaterialId] = useState(() =>
    (materials.find((m) => m.id === preferredMaterial) || materials.find((m) => m.subject === subject) || materials[0])?.id || "",
  );
  const [numbers, setNumbers] = useState("");
  const [cause, setCause] = useState("");
  const [scope, setScope] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [choices, setChoices] = useState<Record<string, { analyze?: boolean; answer?: string }>>({});
  const registering = useRef(false);
  const source = state.questions.filter((q) => q.materialId === materialId && !q.mergedInto);
  const groups = [...new Set(source.map((q) => q.unit).filter(Boolean))];
  const filtered = source.filter((q) => !scope || q.unit === scope);
  const input = resolveMistakeNumbers(numbers, filtered);
  const questionIds = selectedQuestionIds ?? [...new Set([...input.matches, ...chosen])];
  const questionById = new Map(source.map((question) => [question.id, question]));
  const confirmed = input.ambiguous.every((group) => group.some((q) => chosen.includes(q.id)));

  async function add() {
    if (registering.current || !questionIds.length || questionIds.length > 200) return;
    registering.current = true;
    setBusy(true);
    setMessage("");
    try {
      const reviewOptions = questionIds.map((questionId) => ({
        questionId,
        analyze: choices[questionId]?.analyze === true,
        answer: choices[questionId]?.answer?.trim() || undefined,
      }));
      const result = await api("mistakes", "POST", { questionIds, cause, reviewOptions });
      await onDone();
      onRegistered(result.questionIds, result.autoAnalyzeQuestionIds || []);
    } catch (cause) {
      setMessage((cause as Error).message);
    } finally {
      registering.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog title={selectedQuestionIds?.length === 1 ? "오답 등록" : "오답 한꺼번에 등록"} onClose={() => { if (!registering.current) onClose(); }}>
      {!selectedQuestionIds && <div className="form-stack">
        <label>
          문제집
          <select value={materialId} disabled={busy} onChange={(event) => {
            setMaterialId(event.target.value);
            setScope("");
            setChosen([]);
          }}>
            <option value="" disabled>자료를 선택하세요</option>
            {materials.map((m) => <option key={m.id} value={m.id}>{m.subject} · {m.title}</option>)}
          </select>
        </label>
        <details>
          <summary>오답 원인 기록 · 선택</summary>
          <label>
            오답 원인
            <select value={cause} disabled={busy} onChange={(event) => setCause(event.target.value)}>
              {["", "개념 부족", "계산 실수", "조건 해석", "시간 부족", "기타"].map((value) => (
                <option key={value} value={value}>{value || "선택하지 않음"}</option>
              ))}
            </select>
          </label>
        </details>
        {groups.length > 0 && (
          <label>
            단원
            <select value={scope} disabled={busy} onChange={(event) => {
              setScope(event.target.value);
              setChosen([]);
            }}>
              <option value="">모든 단원</option>
              {groups.map((unit) => <option key={unit}>{unit}</option>)}
            </select>
          </label>
        )}
        <label>
          문제 번호
          <input
            autoFocus
            placeholder="예: 3, 7, 12–15"
            value={numbers}
            disabled={busy}
            onChange={(event) => {
              setNumbers(event.target.value);
              setChosen([]);
            }}
          />
          <small>번호와 범위를 섞어 입력할 수 있어요.</small>
        </label>
      </div>}
      {input.error && <p className="error">{input.error}</p>}
      {input.missing.length > 0 && <p className="error">찾지 못한 번호 {input.missing.join(", ")}번 · 단원이나 번호를 확인해 주세요.</p>}
      {questionIds.length > 200 && <p className="error">한 번에 200문제까지 등록할 수 있습니다.</p>}
      {input.ambiguous.map((group) => (
        <fieldset className="ambiguous" key={group[0].number}>
          <legend>{group[0].number}번 · 등록할 원본 선택</legend>
          {group.map((q) => (
            <label key={q.id}>
              <input
                type="checkbox"
                checked={chosen.includes(q.id)}
                disabled={busy}
                onChange={(event) => setChosen(event.target.checked
                  ? [...chosen, q.id]
                  : chosen.filter((id) => id !== q.id))}
              />
              PDF {q.page}쪽{q.unit ? ` · ${q.unit}` : ""}
              {group.some((other) => other.id !== q.id && other.page === q.page) && (
                <SecureImage loading="lazy" path={`questions/${q.id}/image/0`} alt={`${q.number}번 원본`} />
              )}
            </label>
          ))}
        </fieldset>
      ))}
      {questionIds.length > 0 && questionIds.length <= 200 && (
        <div className="mistake-review-options">
          {questionIds.length > 1 && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={questionIds.every((id) => choices[id]?.analyze)}
                disabled={busy}
                onChange={(event) => {
                  const analyze = event.target.checked;
                  setChoices((current) => ({
                    ...current,
                    ...Object.fromEntries(questionIds.map((id) => [id, { ...current[id], analyze }])),
                  }));
                }}
              />
              선택한 문제 모두 AI 분석
            </label>
          )}
          <div className="mistake-review-questions">
            {questionIds.map((id) => {
              const question = questionById.get(id);
              if (!question) return null;
              const label = `${question.number}번 · PDF ${question.page}쪽`;
              return (
                <fieldset key={id}>
                  <legend>{label}</legend>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={choices[id]?.analyze === true}
                      disabled={busy}
                      onChange={(event) => {
                        const analyze = event.target.checked;
                        setChoices((current) => ({ ...current, [id]: { ...current[id], analyze } }));
                      }}
                    />
                    원본 이미지를 AI로 보내 분석
                  </label>
                  <label>
                    정답 (선택)
                    <input
                      aria-label={`${label} 정답 (선택)`}
                      placeholder="예: ③ 또는 2x + 1"
                      value={choices[id]?.answer ?? ""}
                      maxLength={1000}
                      disabled={busy}
                      onChange={(event) => {
                        const answer = event.target.value;
                        setChoices((current) => ({ ...current, [id]: { ...current[id], answer } }));
                      }}
                    />
                  </label>
                </fieldset>
              );
            })}
          </div>
        </div>
      )}
      {message && <p className="error" role="alert">{message}</p>}
      <div className="dialog-footer">
        <Button variant="secondary" disabled={busy} onClick={onClose}>닫기</Button>
        <Button disabled={!questionIds.length || !confirmed || !!input.error || questionIds.length > 200} busy={busy} onClick={add}>
          {questionIds.length ? `${questionIds.length}문제 등록` : "등록"}
        </Button>
      </div>
    </Dialog>
  );
}
export function Mistakes({
  state,
  filters,
  onFilters,
  onAdd,
  onSolve,
  onConcept,
  onOpen,
  onRemoved,
  onError,
}: {
  state: AppState;
  filters: MistakeFilters;
  onFilters: (filters: MistakeFilters) => void;
  onAdd: () => void;
  onSolve: (ids: string[]) => void;
  onConcept: (id: string) => void;
  onOpen: (id: string, page?: number) => void;
  onRemoved: (ids: string[]) => void;
  onError: (s: string) => void;
}) {
  const { subject, material, unit, status, search } = filters;
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<any>();
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [removeNotice, setRemoveNotice] = useState("");
  function change(patch: Partial<MistakeFilters>) {
    onFilters({ ...filters, ...patch });
    setSelected([]);
  }
  const subjects = [...new Set(state.materials.map((m) => m.subject))];
  const availableMaterials = state.materials.filter((d) => subject === "전체" || d.subject === subject);
  const units = [
    ...new Set(state.questions.filter((q) => availableMaterials.some((d) => d.id === q.materialId) && (material === "전체" || q.materialId === material)).map((q) => q.unit).filter(Boolean)),
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
        (status === "시험 전 복습" ||
          (status === "다시 풀 문제" && !m.resolved) ||
          (status === "오늘 복습" && !m.resolved && isDue(m.dueAt))) &&
        (!search ||
          String(q.number).includes(search) ||
          d.title.includes(search)),
    );
  function confirmRemoval(ids: string[]) {
    setDetail(undefined);
    setRemoveError("");
    setRemoveNotice("");
    setRemoveIds(ids);
  }
  async function remove() {
    setRemoving(true);
    setRemoveError("");
    try {
      const { archivedIds } = await api<{ archivedIds: string[] }>(
        "mistakes/archive",
        "POST",
        { ids: removeIds },
      );
      const archived = new Set(archivedIds);
      const questionIds = new Set(
        state.mistakes.filter((m) => archived.has(m.id)).map((m) => m.questionId),
      );
      onRemoved(archivedIds);
      setSelected((ids) => ids.filter((id) => !questionIds.has(id)));
      setRemoveNotice(archived.size
        ? `오답 ${archived.size}개를 목록에서 뺐습니다.`
        : "제외할 오답이 없습니다.");
      setRemoveIds([]);
    } catch (e) {
      setRemoveError((e as Error).message);
    } finally {
      setRemoving(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            오답 노트{" "}
            <span className="title-count">
              {state.mistakes.filter((m) => !m.resolved).length}
            </span>
          </h1>
        </div>
        <Button onClick={onAdd}>
          <Plus size={17} />
          오답 등록
        </Button>
      </div>
      <div className="toolbar">
        <div className="tabs">
          {["다시 풀 문제", "오늘 복습", "시험 전 복습"].map((s) => (
            <button
              key={s}
              className={status === s ? "active" : ""}
              aria-pressed={status === s}
              onClick={() => change({ status: s })}
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
            onChange={(e) => change({ search: e.target.value })}
          />
        </label>
      </div>
      <div className="filters">
        <select
          aria-label="과목 필터"
          value={subject}
          onChange={(e) => change({ subject: e.target.value, material: "전체", unit: "전체" })}
        >
          <option value="전체">모든 과목</option>
          {subjects.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          aria-label="문제집 필터"
          value={material}
          onChange={(e) => change({ material: e.target.value, unit: "전체" })}
        >
          <option value="전체">모든 문제집</option>
          {availableMaterials.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
        {units.length > 0 && (
          <select
            aria-label="단원 필터"
            value={unit}
            onChange={(e) => change({ unit: e.target.value })}
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
      {removeNotice && <p className="muted" role="status">{removeNotice}</p>}
      {selected.length > 0 && (
        <div className="selection-bar mistake-selection">
          <span>{selected.length}개 선택</span>
          <Button variant="ghost" onClick={() => setSelected([])}>
            선택 해제
          </Button>
          <Button
            variant="secondary"
            onClick={() => confirmRemoval(rows.filter(({ q }) => selected.includes(q.id)).map(({ m }) => m.id))}
          >
            선택한 오답 빼기
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
                onClick={() => onConcept(q.id)}
                aria-label={`${q.number}번 저장된 분석 열기`}
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
                  {m.resolved ? (
                    <Badge tone="green">맞힘 · 보관됨</Badge>
                  ) : (
                    <span className="due-small">{dueLabel(m.dueAt)} 복습</span>
                  )}
                </div>
                <h3>
                  {q.number}번 <span>{q.unit}</span>
                </h3>
                <p>
                  {d.title} · {q.page}쪽
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
                  저장된 분석
                </Button>
                <Button variant="ghost" onClick={() => onSolve([q.id])}>
                  다시 풀기
                  <ArrowRight size={14} />
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`${q.number}번 오답 노트에서 빼기`}
                  onClick={() => confirmRemoval([m.id])}
                >
                  오답 빼기
                </Button>
              </div>
            </article>
          ))
        ) : (
          <div className="panel">
            <Empty
              title={
                status !== "시험 전 복습" &&
                state.mistakes.some((m) => m.resolved)
                  ? "다시 풀 오답이 없습니다"
                  : state.mistakes.length
                    ? "조건에 맞는 오답이 없습니다"
                    : "다시 볼 문제를 모아 보세요"
              }
              description={
                status !== "시험 전 복습" &&
                state.mistakes.some((m) => m.resolved)
                  ? "맞힌 문제의 분석과 기록은 시험 전 복습에서 다시 볼 수 있습니다."
                  : "자료의 문제를 누르거나, 번호를 입력해 오답을 등록할 수 있어요."
              }
              icon={<BookOpen size={27} />}
              action={
                status !== "시험 전 복습" &&
                state.mistakes.some((m) => m.resolved) ? (
                  <Button
                    variant="secondary"
                    onClick={() => change({ status: "시험 전 복습" })}
                  >
                    시험 전 복습 보기
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={onAdd}>
                    <Plus size={16} />
                    오답 등록
                  </Button>
                )
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
            <p>
              {detail.mistake.resolved
                ? "맞힌 문제로 보관 중 · 분석과 기록을 다시 볼 수 있습니다."
                : `다음 복습: ${dateLabel(detail.mistake.dueAt)}`}
            </p>
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
            <Button
              variant="secondary"
              onClick={() => onConcept(detail.mistake.questionId)}
            >
              저장된 분석 보기
            </Button>
            <Button variant="ghost" onClick={() => confirmRemoval([detail.mistake.id])}>
              <Trash2 size={14} />
              오답 빼기
            </Button>
            <Button onClick={() => setDetail(undefined)}>닫기</Button>
          </div>
        </Dialog>
      )}
      {removeIds.length > 0 && (
        <Dialog
          title={`오답 ${removeIds.length}개 빼기`}
          onClose={() => { if (!removing) setRemoveIds([]); }}
        >
          <p>오답 목록에서 제외합니다. 원본 문제와 분석, 풀이 기록은 보관되며 같은 문제를 다시 등록할 수 있습니다.</p>
          {removeError && <p className="error" role="alert">{removeError}</p>}
          <div className="dialog-footer">
            <Button variant="secondary" disabled={removing} onClick={() => setRemoveIds([])}>취소</Button>
            <Button variant="danger" busy={removing} onClick={remove}>오답 빼기</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
function Chevron() {
  return <ArrowRight size={11} />;
}
