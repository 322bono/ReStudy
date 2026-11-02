import { useEffect, useState } from "react";
import { api } from "../../lib/client";
import { Button, Dialog, Empty } from "../../components/ui";
type Scope = {
  originalId?:string;
  materialIds?: string[];
  chapterIds?: string[];
  conceptIds?: string[];
  questionIds?: string[];
  purposes?: string[];
  mode?: string;
  count?: number;
  showPending?: boolean;
};
export default function Bank({
  initial = {},
  onBack,
  onStart,
  onGenerate,
  onError,
}: {
  initial?: Scope;
  onBack: () => void;
  onStart: (id: string) => void;
  onGenerate: (materialId: string) => void;
  onError: (message: string) => void;
}) {
  const [data, setData] = useState<any>(),
    [materialIds, setMaterialIds] = useState<string[]>(
      initial.materialIds || [],
    ),
    [chapterIds, setChapterIds] = useState<string[]>(initial.chapterIds || []),
    [conceptIds, setConceptIds] = useState<string[]>(initial.conceptIds || []),
    [kinds, setKinds] = useState<string[]>([]),
    [purposes, setPurposes] = useState<string[]>(initial.purposes || []),
    [levels, setLevels] = useState<string[]>([]),
    [count, setCount] = useState(initial.count || 20),
    [order, setOrder] = useState("unattempted"),
    [mode, setMode] = useState(initial.mode || "quiz"),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [showPending, setShowPending] = useState(initial.showPending === true),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [inspection, setInspection] = useState<any>();
  const load = () =>
    api("bank/list", "POST")
      .then(setData)
      .catch((e) => onError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const toggle = (
    items: string[],
    value: string,
    set: (v: string[]) => void,
  ) => {
    set(
      items.includes(value)
        ? items.filter((v) => v !== value)
        : [...items, value],
    );
    setPage(0);
  };
  const active = (data?.items || []).filter(
    (i: any) =>
      !i.archived &&
      (showPending || i.active) &&
      (i.modes || []).includes(mode) &&
      (!initial.originalId||i.relatedQuestionIds?.includes(initial.originalId)||
        [i.conceptId,...(i.conceptIds||[])].some((id:string)=>data?.originals?.find((q:any)=>q.id===initial.originalId)?.conceptIds?.includes(id))) &&
      (!initial.questionIds?.length ||
        i.relatedQuestionIds?.some((id: string) =>
          initial.questionIds!.includes(id),
        )) &&
      (!materialIds.length ||
        i.sources?.some((s: any) => materialIds.includes(s.materialId))) &&
      (!chapterIds.length ||
        [i.chapterId, ...(i.chapterIds || [])].some((id) =>
          chapterIds.includes(id),
        )) &&
      (!conceptIds.length ||
        [i.conceptId, ...(i.conceptIds || [])].some((id) =>
          conceptIds.includes(id),
        )) &&
      (!kinds.length ||
        kinds.includes(
          i.kind ||
            (
              { 객관식: "mcq", OX: "ox", 단답형: "short", 빈칸: "blank" } as any
            )[i.type],
        )) &&
      (!purposes.length ||
        [i.purpose, ...(i.purposes || [])].some((p) => purposes.includes(p))) &&
      (!levels.length ||
        levels.includes(
          i.level ||
            ({ 기본: "easy", 보통: "medium", 심화: "hard" } as any)[
              i.difficulty
            ],
        )) &&
      (!search || i.prompt.toLowerCase().includes(search.toLowerCase())),
  );
  const chapters = (data?.chapters || []).filter(
    (c: any) => !materialIds.length || materialIds.includes(c.materialId),
  );
  const concepts = (data?.concepts || []).filter(
    (c: any) =>
      !chapterIds.length ||
      c.chapterIds?.some((id: string) => chapterIds.includes(id)),
  );
  async function start() {
    setBusy(true);
    try {
      const session = await api("bank/study", "POST", {
        materialIds,
        chapterIds,
        conceptIds,
        kinds,
        purposes,
        levels,
        count,
        order,
        mode,
        questionIds: initial.questionIds || [],
        originalId:initial.originalId,
        ...(selected.length ? { bankItemIds: selected } : {}),
      });
      onStart(session.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect(id: string) {
    try {
      setInspection(await api(`bank/inspect/${id}`));
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function review(ids: string[]) {
    setBusy(true);
    try {
      await api("bank/review", "POST", { ids });
      setInspection(undefined);
      setSelected([]);
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <div className="loading">문제 은행을 여는 중…</div>;
  return (
    <>
      <div className="page-heading">
        <div>
          <button className="text-button" onClick={onBack}>
            돌아가기
          </button>
          <h1>문제 은행</h1>
          <p>저장된 문항으로 학습 세트를 구성하세요.</p>
        </div>
        <Button
          disabled={!active.some((i: any) => i.active)}
          busy={busy}
          onClick={start}
        >
          학습 시작
        </Button>
      </div>
      <section className="panel bank-filters">
        <div className="form-grid">
          <label>
            학습 방식
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="quiz">문제 풀기</option>
              <option value="check">개념 퀴즈</option>
              <option value="memory">암기하기</option>
            </select>
          </label>
          <label>
            문제 수
            <input
              type="number"
              min={1}
              max={1000}
              value={count}
              onChange={(e) => setCount(+e.target.value)}
            />
          </label>
          <label>
            출제 순서
            <select value={order} onChange={(e) => setOrder(e.target.value)}>
              <option value="sequential">순서대로</option>
              <option value="random">무작위</option>
              <option value="unattempted">아직 풀지 않은 문제 우선</option>
              <option value="wrong">최근 오답 우선</option>
              <option value="weak">취약 개념 우선</option>
              <option value="mixed">여러 난이도 혼합</option>
            </select>
          </label>
        </div>
        <details>
          <summary>자료·단원·개념 선택</summary>
          <div className="bank-scope-columns">
            <fieldset>
              <legend>자료</legend>
              {data.materials.map((m: any) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    checked={materialIds.includes(m.id)}
                    onChange={() => toggle(materialIds, m.id, setMaterialIds)}
                  />
                  {m.subject} · {m.title}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>단원</legend>
              {chapters.map((c: any) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={chapterIds.includes(c.id)}
                    onChange={() => toggle(chapterIds, c.id, setChapterIds)}
                  />
                  {c.title}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>개념</legend>
              {concepts.map((c: any) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={conceptIds.includes(c.id)}
                    onChange={() => toggle(conceptIds, c.id, setConceptIds)}
                  />
                  {c.name}
                </label>
              ))}
            </fieldset>
          </div>
        </details>
        <div className="bank-filter-row">
          <fieldset>
            <legend>형식</legend>
            {Object.entries({
              mcq: "객관식",
              ox: "OX",
              short: "단답형",
              blank: "빈칸",
            }).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={kinds.includes(key)}
                  onChange={() => toggle(kinds, key, setKinds)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>목적</legend>
            {Object.entries({
              concept: "개념 퀴즈",
              practice: "연습문제",
              similar: "유사문제",
            }).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={purposes.includes(key)}
                  onChange={() => toggle(purposes, key, setPurposes)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>난이도</legend>
            {Object.entries({ easy: "하", medium: "중", hard: "상" }).map(
              ([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={levels.includes(key)}
                    onChange={() => toggle(levels, key, setLevels)}
                  />
                  {label}
                </label>
              ),
            )}
          </fieldset>
        </div>
      </section>
      <div className="toolbar">
        <span>조건에 맞는 문항 {active.length}개</span>
        <input
          aria-label="문제 은행 검색"
          placeholder="문항 검색"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={showPending}
            onChange={(e) => setShowPending(e.target.checked)}
          />
          검토 대기 포함
        </label>
      </div>
      {selected.length > 0 && (
        <div className="selection-bar">
          <span>{selected.length}개 선택</span>
          <Button
            variant="secondary"
            onClick={() => review(selected)}
            busy={busy}
          >
            선택 문항 검토 완료·사용
          </Button>
          <Button onClick={start} busy={busy}>
            선택 문항으로 학습
          </Button>
          <button className="text-button" onClick={() => setSelected([])}>
            해제
          </button>
        </div>
      )}
      <div className="bank-question-list">
        {active
          .slice(page * 10, page * 10 + 10)
          .map((i: any, index: number) => (
            <article className="panel bank-question-row" key={i.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`${page * 10 + index + 1}번 문항 선택`}
                  checked={selected.includes(i.id)}
                  onChange={() => toggle(selected, i.id, setSelected)}
                />
              </label>
              <div>
                <small>
                  {i.type} · {i.difficulty} ·{" "}
                  {i.active ? "학습 가능" : "내용 검토 필요"}
                </small>
                <p>{i.prompt}</p>
                <div className="row">
                  <button className="text-button" onClick={() => inspect(i.id)}>
                    문항·정답 검토
                  </button>
                  <button
                    className="text-button"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const s = await api("bank/study", "POST", {
                          bankItemIds: [i.id],
                          count: 1,
                          mode,
                        });
                        onStart(s.id);
                      } catch (e) {
                        onError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={!i.active}
                  >
                    이 문제 풀기
                  </button>
                </div>
              </div>
            </article>
          ))}
      </div>
      {!active.length && (
        <Empty
          title="조건에 맞는 문항이 없습니다"
          description="범위를 바꾸거나 자료 상세에서 문제 은행을 추가로 준비하세요."
          action={
            materialIds.length === 1 ? (
              <Button onClick={() => onGenerate(materialIds[0])}>
                추가 콘텐츠 준비
              </Button>
            ) : undefined
          }
        />
      )}
      {active.length > 10 && (
        <div className="row bank-pagination">
          <Button
            variant="secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            이전
          </Button>
          <span>
            {page + 1} / {Math.ceil(active.length / 10)}
          </span>
          <Button
            variant="secondary"
            disabled={(page + 1) * 10 >= active.length}
            onClick={() => setPage(page + 1)}
          >
            다음
          </Button>
        </div>
      )}
      {inspection && (
        <Dialog wide title="내용 검토" onClose={() => setInspection(undefined)}>
          <BankEditor
            item={inspection}
            onSave={async (item) => {
              await api(`bank-items/${item.id}`, "PUT", item);
              setInspection(await api(`bank/inspect/${item.id}`));
              await load();
            }}
            onError={onError}
          />
          <p>{inspection.prompt}</p>
          <ol type="A">
            {inspection.choices?.map((choice: string) => (
              <li key={choice}>{choice}</li>
            ))}
          </ol>
          <p>
            <strong>정답</strong> {inspection.answer}
          </p>
          <p>{inspection.explanation}</p>
          {Object.entries(inspection.choiceFeedback || {}).map(
            ([choice, feedback]: [string, any]) => (
              <p key={choice}>
                <strong>{choice}</strong> {feedback.explanation}
              </p>
            ),
          )}
          <p className="field-help">
            형식 검사는 교육적 정확성 검토와 별개입니다. 정답과 해설을 직접
            확인하세요.
          </p>
          <div className="dialog-footer">
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await api(`bank-items/${inspection.id}`, "DELETE");
                  setInspection(undefined);
                  await load();
                } catch (e) {
                  onError((e as Error).message);
                }
              }}
            >
              문항 보관
            </Button>
            <Button busy={busy} onClick={() => review([inspection.id])}>
              검토 완료·학습에 사용
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
function BankEditor({
  item,
  onSave,
  onError,
}: {
  item: any;
  onSave: (value: any) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState(item.prompt),
    [answer, setAnswer] = useState(item.answer),
    [explanation, setExplanation] = useState(item.explanation),
    [busy, setBusy] = useState(false);
  return (
    <details>
      <summary>문항 수정</summary>
      <form
        className="bank-editor"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave({
              ...item,
              prompt,
              answer,
              explanation,
              acceptedAnswers: [answer],
              active: false,
              reviewStatus: "needs_review",
            });
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          질문
          <textarea
            required
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label>
          정답
          {item.choices?.length ? (
            <select value={answer} onChange={(e) => setAnswer(e.target.value)}>
              {item.choices.map((c: string) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          ) : (
            <input
              required
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          )}
        </label>
        <label>
          해설
          <textarea
            required
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
          />
        </label>
        <Button type="submit" busy={busy}>
          수정 저장·검토 대기로
        </Button>
      </form>
    </details>
  );
}
