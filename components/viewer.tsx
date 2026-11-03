"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  ExternalLink,
  Plus,
  Check,
  Crop,
  X,
  AlertCircle,
} from "lucide-react";
import type { Concept, Material, Page, Question, Region } from "@/lib/types";
import { api } from "@/lib/client";
import { pageNavigation } from "../lib/page-navigation";
import { NumberInput } from "./number-input";
import { Badge, Button, Empty, IconButton } from "./ui";
import { MaterialStatus } from "./materials";
import { OriginalPage } from "./original-page";
import { SecureLink, prefetchSecureImages } from "./secure-assets";
export function Viewer({
  id,
  initialPage = 1,
  onBack,
  onChange,
  onError,
  manage = false,
  concepts = [],
  onRegistered,
}: {
  id: string;
  initialPage?: number;
  onBack: () => void;
  onChange: () => Promise<void>;
  onError: (s: string) => void;
  manage?: boolean;
  concepts?: Concept[];
  onRegistered: (ids: string[], autoAnalyzeIds: string[]) => void;
}) {
  const [data, setData] = useState<{
      material: Material;
      pages: Page[];
      questions: Question[];
    }>(),
    [requestedPage, setPage] = useState(initialPage),
    [selected, setSelected] = useState<string>(),
    [zoom, setZoom] = useState(1),
    [edit, setEdit] = useState(false),
    [regions, setRegions] = useState<Region[]>([]),
    [startPage, setStartPage] = useState(initialPage),
    [number, setNumber] = useState(""),
    [unit, setUnit] = useState(""),
    [busy, setBusy] = useState(""),
    [drag, setDrag] = useState<Region>(),
    [search, setSearch] = useState(""),
    [failure, setFailure] = useState(""),
    [conceptIds, setConceptIds] = useState<string[]>([]);
  const [mergeId, setMergeId] = useState(""),
    [splitNumber, setSplitNumber] = useState(""),
    [splitIndex, setSplitIndex] = useState(0),
    [splitAxis, setSplitAxis] = useState<"x" | "y">("y"),
    [splitRatio, setSplitRatio] = useState(50);
  const navigation = pageNavigation(data?.pages || [], requestedPage);
  const page = navigation.page ?? requestedPage;
  useEffect(() => {
    setPage(initialPage);
  }, [id, initialPage]);
  useEffect(() => {
    if (navigation.page !== undefined && navigation.page !== requestedPage)
      setPage(navigation.page);
  }, [navigation.page, requestedPage]);
  useEffect(() => {
    const adjacent = [navigation.next, navigation.previous].filter(
      (number): number is number => number !== undefined,
    );
    void prefetchSecureImages(
      adjacent.map((number) => `materials/${id}/page/${number}`),
    );
  }, [id, navigation.next, navigation.previous]);
  const regionPages = [...new Set(regions.map((region) => region.page))].sort(
    (a, b) => a - b,
  );
  useEffect(() => {
    if (!edit) return;
    setStartPage((current) =>
      regionPages.includes(current) ? current : regionPages[0] || page,
    );
  }, [regions, edit, page]);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const load = useCallback(async () => {
    const d = await api(`materials/${id}`);
    setData(d);
  }, [id]);
  useEffect(() => {
    load().catch((e) => {
      setFailure(e.message);
      onError(e.message);
    });
  }, [load, onError]);
  useEffect(() => {
    if (
      data?.material.status === "processing" ||
      data?.material.status === "uploaded"
    ) {
      const t = setInterval(() => load().catch(() => {}), 1500);
      return () => clearInterval(t);
    }
  }, [data?.material.status, load]);
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
      await load();
      await onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (failure && !data)
    return (
      <Empty
        title="자료를 열 수 없습니다"
        description={failure}
        action={<Button onClick={onBack}>내 자료로</Button>}
      />
    );
  if (!data) return <div className="loading">자료를 여는 중…</div>;
  const q = data.questions.find((q) => q.id === selected),
    p = data.pages.find((p) => p.number === page);
  const choose = (q: Question) => {
    setSelected(q.id);
    setMergeId("");
    setSplitNumber("");
    setSplitIndex(q.sharedRegionCount ?? 0);
    setPage(q.page || q.regions[0]?.page || 1);
    setConceptIds(q.conceptIds || []);
    setEdit(false);
    setRegions(q.regions);
    setStartPage(q.page || q.regions[0]?.page || 1);
    setNumber(String(q.number));
    setUnit(q.unit);
  };
  const begin = (question?: Question) => {
    if (!manage) return;
    if (question) {
      setSelected(question.id);
      setRegions(question.regions);
      setStartPage(question.page || question.regions[0]?.page || page);
      setNumber(String(question.number));
      setUnit(question.unit);
    } else {
      setSelected(undefined);
      setRegions([]);
      setStartPage(page);
      setNumber("");
      setUnit("");
    }
    setEdit(true);
  };
  const position = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };
  const save = () =>
    act("영역 저장", async () => {
      await api(q ? `questions/${q.id}` : "questions", q ? "PATCH" : "POST", {
        materialId: id,
        number: Number(number),
        page: startPage,
        unit,
        regions,
        confirmed: true,
      });
      setEdit(false);
    });
  return (
    <div className="viewer">
      <div className="workspace-header">
        <IconButton label="자료 목록으로" onClick={onBack}>
          <ArrowLeft size={20} />
        </IconButton>
        <div className="workspace-title">
          <strong>{data.material.title}</strong>
          <span>
            {data.material.subject} · {data.material.kind}
          </span>
        </div>
        {manage && <MaterialStatus material={data.material} />}
        {manage && <Badge tone="amber">콘텐츠 관리</Badge>}
        {manage && (
          <Button
            variant="secondary"
            disabled={
              edit ||
              data.material.status === "processing" ||
              data.material.status === "uploaded"
            }
            busy={!!busy}
            onClick={() =>
              act("다시 전처리", async () => {
                await api(`materials/${id}/retry`, "POST");
              })
            }
          >
            전체 다시 전처리
          </Button>
        )}
        <SecureLink
          className="button secondary source-link"
          path={`materials/${id}/file`}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={14} />
          원본 열기
        </SecureLink>
      </div>
      {data.material.error && (
        <div className="notice error">
          <AlertCircle size={17} />
          <span>{data.material.error}</span>
        </div>
      )}
      {manage && !!data.material.warnings?.length && (
        <details className="notice" style={{ display: "block" }}>
          <summary>사전 처리 안내 {data.material.warnings.length}개</summary>
          <ul>
            {data.material.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {(data.material.status === "processing" ||
        data.material.status === "uploaded") && (
        <div className="analysis-progress">
          <div style={{ width: `${Math.max(3, data.material.progress)}%` }} />
          <span>
            {data.material.message || "원본 페이지와 문항 번호를 읽고 있어요"} ·{" "}
            {data.material.progress}%
          </span>
        </div>
      )}
      <div className="viewer-body">
        <section className="document-area">
          <div className="pdf-toolbar">
            <IconButton
              label="이전 페이지"
              disabled={navigation.previous === undefined}
              onClick={() => {
                if (navigation.previous !== undefined)
                  setPage(navigation.previous);
              }}
            >
              <ChevronLeft size={18} />
            </IconButton>
            <label className="page-number">
              <span>PDF</span>
              <NumberInput
                min={navigation.first ?? 1}
                max={navigation.last ?? 1}
                value={navigation.page}
                disabled={!navigation.count}
                aria-label="PDF 페이지"
                normalizeValue={(number) =>
                  pageNavigation(data.pages, number).page ?? number
                }
                onValueChange={setPage}
              />
              <span>쪽</span>
            </label>
            <IconButton
              label="다음 페이지"
              disabled={navigation.next === undefined}
              onClick={() => {
                if (navigation.next !== undefined) setPage(navigation.next);
              }}
            >
              <ChevronRight size={18} />
            </IconButton>
            <span className="page-counter">
              분석 {navigation.index + 1} / {navigation.count}쪽
            </span>
            <div className="toolbar-divider" />
            <IconButton
              label="축소"
              disabled={zoom <= 0.75}
              onClick={() => setZoom((z) => z - 0.25)}
            >
              <ZoomOut size={17} />
            </IconButton>
            <span className="zoom-label">{Math.round(zoom * 100)}%</span>
            <IconButton
              label="확대"
              disabled={zoom >= 2.5}
              onClick={() => setZoom((z) => z + 0.25)}
            >
              <ZoomIn size={17} />
            </IconButton>
            {manage && p && (
              <select
                className="page-kind"
                aria-label="페이지 종류"
                value={p.kind}
                onChange={(e) =>
                  act("페이지 분류", async () => {
                    await api(`materials/${id}/page-kind`, "PATCH", {
                      page,
                      kind: e.target.value,
                    });
                  })
                }
              >
                <option value="content">문제·본문</option>
                <option value="answers">정답·해설</option>
                <option value="uncertain">인식 확인 필요</option>
              </select>
            )}
          </div>
          <div className="pdf-scroll">
            {p ? (
              <div
                className={`pdf-paper ${edit ? "cropping" : ""}`}
                style={{
                  width: `${zoom * 100}%`,
                  aspectRatio: `${p.width}/${p.height}`,
                }}
                onPointerDown={(e) => {
                  if (!manage || !edit || p.kind === "answers") return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  start.current = position(e);
                  setDrag({
                    page,
                    x: start.current.x,
                    y: start.current.y,
                    w: 0,
                    h: 0,
                  });
                }}
                onPointerMove={(e) => {
                  if (!start.current) return;
                  const c = position(e),
                    s = start.current;
                  setDrag({
                    page,
                    x: Math.min(c.x, s.x),
                    y: Math.min(c.y, s.y),
                    w: Math.abs(c.x - s.x),
                    h: Math.abs(c.y - s.y),
                  });
                }}
                onPointerUp={() => {
                  if (drag && drag.w > 0.005 && drag.h > 0.005)
                    setRegions((rs) => [...rs, drag]);
                  start.current = undefined;
                  setDrag(undefined);
                }}
                onPointerCancel={() => {
                  start.current = undefined;
                  setDrag(undefined);
                }}
              >
                <OriginalPage
                  id={id}
                  page={page}
                  title={data.material.title}
                  mime={data.material.mime}
                  zoom={zoom}
                />
                {!edit &&
                  data.questions.flatMap((question) =>
                    question.regions
                      .filter((r) => r.page === page)
                      .map((r, i) => (
                        <button
                          key={question.id + "-" + i}
                          aria-label={`${question.number}번 문제 선택`}
                          className={`question-box ${selected === question.id ? "selected" : ""} ${question.confirmed ? "confirmed" : ""}`}
                          style={{
                            left: `${r.x * 100}%`,
                            top: `${r.y * 100}%`,
                            width: `${r.w * 100}%`,
                            height: `${r.h * 100}%`,
                          }}
                          onClick={() => choose(question)}
                        >
                          <span>{question.number}</span>
                        </button>
                      )),
                  )}
                {edit &&
                  [...regions, ...(drag ? [drag] : [])]
                    .filter((r) => r.page === page)
                    .map((r, i) => (
                      <div
                        key={i}
                        className="crop-box"
                        style={{
                          left: `${r.x * 100}%`,
                          top: `${r.y * 100}%`,
                          width: `${r.w * 100}%`,
                          height: `${r.h * 100}%`,
                        }}
                      />
                    ))}
              </div>
            ) : (
              <Empty
                title="원본을 준비하고 있어요"
                description="분석이 끝나면 페이지를 볼 수 있습니다."
              />
            )}
          </div>
        </section>
        <aside className="question-sidebar">
          <div className="question-list-heading">
            <h3>
              문제 <small>{data.questions.length}</small>
            </h3>
            {manage && (
              <IconButton
                label="문제 직접 추가"
                disabled={!p || p.kind === "answers"}
                onClick={() => begin()}
              >
                <Plus size={18} />
              </IconButton>
            )}
          </div>
          <div className="question-search">
            <input
              placeholder="문제 번호 찾기"
              aria-label="문제 번호 찾기"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="question-list">
            {data.questions.length ? (
              data.questions
                .filter((q) => String(q.number).includes(search))
                .map((question) => (
                  <button
                    key={question.id}
                    data-number={question.number}
                    className={`question-list-item ${selected === question.id ? "active" : ""}`}
                    onClick={() => choose(question)}
                  >
                    <span>
                      <strong>{question.number}번</strong>
                      <small>
                        {question.unit ||
                          `${question.page || question.regions[0]?.page}쪽`}
                      </small>
                    </span>
                  </button>
                ))
            ) : (
              <p className="sidebar-note">
                {manage
                  ? "찾은 문항이 없습니다. + 버튼으로 원본 문항 영역을 등록하세요."
                  : "등록된 원본 문항이 없습니다. 자료의 페이지를 넘기며 읽을 수 있어요."}
              </p>
            )}
          </div>
          {manage && edit ? (
            <div className="question-detail">
              <Badge tone="indigo">영역 수정</Badge>
              <p>
                문제 전체를 드래그하세요. 다음 페이지에서도 영역을 추가할 수
                있어요.
              </p>
              <div className="form-grid">
                <label>
                  문제 번호
                  <NumberInput
                    min={1}
                    value={number ? Number(number) : undefined}
                    onValueChange={(value) => setNumber(String(value))}
                    onEmpty={() => setNumber("")}
                  />
                </label>
                <label>
                  단원
                  <input
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    placeholder="선택"
                  />
                </label>
              </div>
              <label>
                문항 시작 쪽
                <select
                  aria-label="문항 시작 쪽"
                  value={regionPages.length ? startPage : ""}
                  disabled={!regionPages.length || !!busy}
                  onChange={(e) => setStartPage(Number(e.target.value))}
                >
                  {!regionPages.length && (
                    <option value="">영역을 먼저 지정하세요</option>
                  )}
                  {regionPages.map((number) => (
                    <option key={number} value={number}>
                      {number}쪽
                    </option>
                  ))}
                </select>
              </label>
              <div className="region-chips">
                {regions.map((r, i) => (
                  <span key={i}>
                    {r.page}쪽 영역 {i + 1}
                    <button
                      aria-label="영역 제거"
                      onClick={() =>
                        setRegions(regions.filter((_, j) => i !== j))
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <Button
                onClick={save}
                busy={!!busy}
                disabled={
                  !regions.length || !number || !regionPages.includes(startPage)
                }
              >
                영역 저장
              </Button>
              <Button variant="ghost" onClick={() => setEdit(false)}>
                취소
              </Button>
            </div>
          ) : q ? (
            <div className="question-detail">
              <div className="row-between">
                <h3>{q.number}번</h3>
                <Badge tone={q.hasContent ? "indigo" : "amber"}>
                  {q.hasContent
                    ? "개념 연결됨"
                    : q.conceptIds?.length
                      ? "학습 문항 미등록"
                      : "개념 미등록"}
                </Badge>
              </div>
              <p>
                {q.conceptIds
                  ?.map((id) => concepts.find((c) => c.id === id)?.name)
                  .filter(Boolean)
                  .join(" · ") || "아직 연결된 개념이 없습니다."}
              </p>
              {manage && (
                <>
                  <Badge tone="green">원본 저장됨</Badge>
                  <Button variant="secondary" onClick={() => begin(q)}>
                    <Crop size={15} />
                    영역 수정
                  </Button>
                  <details>
                    <summary>문항 합치기·분리하기</summary>
                    <p className="field-help">
                      모든 새 크롭이 저장된 뒤 함께 반영합니다. 기존 문항 ID와
                      학습 기록은 보존하며, 수정한 영역은 다시 확인합니다.
                    </p>
                    <label>
                      이 문항에 합칠 문항
                      <select
                        value={mergeId}
                        onChange={(e) => setMergeId(e.target.value)}
                      >
                        <option value="">선택</option>
                        {data.questions
                          .filter((other) => other.id !== q.id)
                          .map((other) => (
                            <option key={other.id} value={other.id}>
                              {other.number}번 · PDF {other.page}쪽
                            </option>
                          ))}
                      </select>
                    </label>
                    <Button
                      variant="secondary"
                      disabled={
                        !!busy ||
                        !mergeId ||
                        ["uploaded", "processing"].includes(
                          data.material.status,
                        )
                      }
                      onClick={() =>
                        act("문항 합치기", async () => {
                          await api(`questions/${q.id}/merge`, "POST", {
                            otherId: mergeId,
                          });
                          setMergeId("");
                        })
                      }
                    >
                      선택 문항 합치기
                    </Button>
                    <div className="form-grid">
                      <label>
                        분리할 본문 영역
                        <select
                          value={splitIndex}
                          onChange={(e) =>
                            setSplitIndex(Number(e.target.value))
                          }
                        >
                          {q.regions.map(
                            (r, i) =>
                              i >= (q.sharedRegionCount ?? 0) && (
                                <option key={i} value={i}>
                                  PDF {r.page}쪽 영역 {i + 1}
                                </option>
                              ),
                          )}
                        </select>
                      </label>
                      <label>
                        분리 방향
                        <select
                          value={splitAxis}
                          onChange={(e) =>
                            setSplitAxis(e.target.value as "x" | "y")
                          }
                        >
                          <option value="y">위·아래</option>
                          <option value="x">왼쪽·오른쪽</option>
                        </select>
                      </label>
                      <label>
                        나눌 위치 (%)
                        <NumberInput
                          min={10}
                          max={90}
                          value={splitRatio}
                          onValueChange={setSplitRatio}
                        />
                      </label>
                      <label>
                        분리한 새 문항 번호
                        <NumberInput
                          min={1}
                          max={9999}
                          value={splitNumber ? Number(splitNumber) : undefined}
                          onValueChange={(value) => setSplitNumber(String(value))}
                          onEmpty={() => setSplitNumber("")}
                        />
                      </label>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={
                        !!busy ||
                        !splitNumber ||
                        ["uploaded", "processing"].includes(
                          data.material.status,
                        )
                      }
                      onClick={() =>
                        act("문항 분리하기", async () => {
                          await api(`questions/${q.id}/split`, "POST", {
                            newNumber: Number(splitNumber),
                            regionIndex: Math.max(
                              splitIndex,
                              q.sharedRegionCount ?? 0,
                            ),
                            axis: splitAxis,
                            ratio: splitRatio / 100,
                          });
                          setSplitNumber("");
                        })
                      }
                    >
                      두 문항으로 분리
                    </Button>
                  </details>
                  <fieldset className="editor-fieldset">
                    <legend>연결 개념</legend>
                    {concepts
                      .filter((c) => c.subject === data.material.subject)
                      .map((c) => (
                        <label className="checkbox-label" key={c.id}>
                          <input
                            type="checkbox"
                            checked={conceptIds.includes(c.id)}
                            onChange={(e) =>
                              setConceptIds(
                                e.target.checked
                                  ? [...conceptIds, c.id]
                                  : conceptIds.filter((id) => id !== c.id),
                              )
                            }
                          />
                          {c.name}
                        </label>
                      ))}
                    {!concepts.length && (
                      <p className="field-help">
                        콘텐츠 관리에서 개념을 먼저 등록하세요.
                      </p>
                    )}
                  </fieldset>
                  <Button
                    variant="secondary"
                    busy={!!busy}
                    onClick={() =>
                      act("개념 연결", async () => {
                        await api(`questions/${q.id}/mapping`, "PATCH", {
                          conceptIds,
                        });
                      })
                    }
                  >
                    개념 연결 저장
                  </Button>
                </>
              )}
              <Button
                variant="primary"
                busy={!!busy}
                onClick={() =>
                  act("오답 추가", async () => {
                    const result = await api("mistakes", "POST", {
                      questionIds: [q.id],
                    });
                    await onChange();
                    onRegistered(
                      result.questionIds || [q.id],
                      result.autoAnalyzeQuestionIds || [],
                    );
                  })
                }
              >
                <Plus size={15} />
                오답 추가
              </Button>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
